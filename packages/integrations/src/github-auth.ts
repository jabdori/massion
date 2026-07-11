import { createSign } from "node:crypto";

export const GITHUB_API_VERSION = "2026-03-10" as const;

interface InstallationToken {
  readonly token: string;
  readonly expiresAt: Date;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function createGitHubAppJwt(input: {
  readonly clientId: string;
  readonly privateKeyPem: string;
  readonly now?: Date;
}): string {
  if (!/^[A-Za-z0-9_-]{4,128}$/u.test(input.clientId)) throw new Error("GitHub App client ID가 유효하지 않습니다");
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const signingInput = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: input.clientId })}`;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    return `${signingInput}.${signer.sign(input.privateKeyPem).toString("base64url")}`;
  } catch {
    throw new Error("GitHub App JWT private key 서명에 실패했습니다");
  }
}

export class GitHubInstallationTokenManager {
  private readonly cache = new Map<string, InstallationToken>();

  public constructor(
    private readonly dependencies: {
      readonly clientId: string;
      readonly privateKey: () => Promise<string>;
      readonly exchange: (input: {
        readonly installationId: string;
        readonly authorization: string;
        readonly apiVersion: typeof GITHUB_API_VERSION;
        readonly repositoryIds?: readonly number[];
        readonly permissions?: Readonly<Record<string, "read" | "write">>;
      }) => Promise<unknown>;
    },
  ) {}

  public async get(
    installationId: string,
    input: {
      readonly now?: Date;
      readonly repositoryIds?: readonly number[];
      readonly permissions?: Readonly<Record<string, "read" | "write">>;
    } = {},
  ): Promise<string> {
    if (!/^[0-9]{1,20}$/u.test(installationId)) throw new Error("GitHub App installation ID가 유효하지 않습니다");
    const now = input.now ?? new Date();
    const cacheKey = `${installationId}:${JSON.stringify(input.repositoryIds ?? [])}:${JSON.stringify(input.permissions ?? {})}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt.getTime() - now.getTime() > 300_000) return cached.token;
    const jwt = createGitHubAppJwt({
      clientId: this.dependencies.clientId,
      privateKeyPem: await this.dependencies.privateKey(),
      now,
    });
    const response = await this.dependencies.exchange({
      installationId,
      authorization: `Bearer ${jwt}`,
      apiVersion: GITHUB_API_VERSION,
      ...(input.repositoryIds === undefined ? {} : { repositoryIds: input.repositoryIds }),
      ...(input.permissions === undefined ? {} : { permissions: input.permissions }),
    });
    if (!response || typeof response !== "object" || Array.isArray(response))
      throw new Error("GitHub installation token 응답이 유효하지 않습니다");
    const record = response as Record<string, unknown>;
    if (typeof record.token !== "string" || record.token.length < 20 || record.token.length > 2_048)
      throw new Error("GitHub installation token이 유효하지 않습니다");
    if (typeof record.expires_at !== "string") throw new Error("GitHub installation token 만료가 유효하지 않습니다");
    const expiresAt = new Date(record.expires_at);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime())
      throw new Error("GitHub installation token이 이미 만료됐습니다");
    this.cache.set(cacheKey, { token: record.token, expiresAt });
    return record.token;
  }

  public revoke(installationId: string): void {
    for (const key of this.cache.keys()) if (key.startsWith(`${installationId}:`)) this.cache.delete(key);
  }
}
