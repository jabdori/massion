import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

import { assertDigest, assertRegistryId, normalizePackageIdentity } from "./contracts.js";

export interface PublisherTrustPolicy {
  readonly issuer: string;
  readonly audience: string;
  readonly subject: RegExp;
  readonly repository: string;
  readonly workflow: RegExp;
  readonly jwksUrl?: string;
}

interface JwtVerificationResult {
  readonly payload: JWTPayload;
}

type VerifyJwt = (token: string, policy: PublisherTrustPolicy) => Promise<JwtVerificationResult>;

export class OidcPublisherAuthenticator {
  private readonly verifyJwt: VerifyJwt;
  private readonly consumed = new Set<string>();
  private readonly now: () => Date;

  public constructor(options: { readonly verifyJwt?: VerifyJwt; readonly now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
    this.verifyJwt =
      options.verifyJwt ??
      (async (token, policy) => {
        if (!policy.jwksUrl) throw new Error("OIDC trust policy에 JWKS URL이 필요합니다");
        const jwks = createRemoteJWKSet(new URL(policy.jwksUrl), { timeoutDuration: 5_000, cooldownDuration: 30_000 });
        return await jwtVerify(token, jwks, {
          issuer: policy.issuer,
          audience: policy.audience,
          algorithms: ["RS256", "ES256"],
          maxTokenAge: "5m",
          clockTolerance: 5,
        });
      });
  }

  public async authenticate(
    token: string,
    policy: PublisherTrustPolicy,
  ): Promise<{
    readonly subject: string;
    readonly repository: string;
    readonly workflow: string;
    readonly tokenId: string;
  }> {
    if (token.length < 3 || token.length > 16 * 1024) throw new Error("OIDC token byte 상한이 유효하지 않습니다");
    const { payload } = await this.verifyJwt(token, policy);
    const { iss, aud, sub, iat, exp, jti } = payload;
    const repository = payload.repository;
    const workflow = payload.job_workflow_ref;
    if (iss !== policy.issuer || !(aud === policy.audience || (Array.isArray(aud) && aud.includes(policy.audience))))
      throw new Error("OIDC issuer 또는 audience가 trust policy와 다릅니다");
    if (typeof sub !== "string" || !policy.subject.test(sub)) throw new Error("OIDC subject가 trust policy와 다릅니다");
    if (repository !== policy.repository || typeof workflow !== "string" || !policy.workflow.test(workflow))
      throw new Error("OIDC repository 또는 workflow가 trust policy와 다릅니다");
    if (typeof iat !== "number" || typeof exp !== "number" || exp <= iat || exp - iat > 600)
      throw new Error("OIDC token 수명이 유효하지 않습니다");
    const now = Math.floor(this.now().getTime() / 1_000);
    if (iat > now + 5 || exp < now - 5) throw new Error("OIDC token이 아직 유효하지 않거나 만료됐습니다");
    if (typeof jti !== "string" || jti.length < 8 || jti.length > 256) throw new Error("OIDC jti가 유효하지 않습니다");
    if (this.consumed.has(jti)) throw new Error("OIDC token을 이미 교환했습니다");
    this.consumed.add(jti);
    return { subject: sub, repository, workflow, tokenId: jti };
  }
}

interface GrantRecord {
  readonly publisherId: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly artifactDigest: string;
  readonly expiresAt: number;
  consumed: boolean;
}

export class UploadGrantService {
  private readonly records = new Map<string, GrantRecord>();
  private readonly now: () => Date;

  public constructor(private readonly options: { readonly secret: Buffer; readonly now?: () => Date }) {
    if (options.secret.length < 32) throw new Error("upload grant HMAC secret은 256-bit 이상이어야 합니다");
    this.now = options.now ?? (() => new Date());
  }

  public issue(input: {
    readonly publisherId: string;
    readonly packageName: string;
    readonly packageVersion: string;
    readonly artifactDigest: string;
    readonly ttlSeconds: number;
  }): { readonly token: string; readonly expiresAt: string } {
    assertRegistryId(input.publisherId, "publisher");
    normalizePackageIdentity(input.packageName, input.packageVersion);
    assertDigest(input.artifactDigest, "artifact");
    if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 30 || input.ttlSeconds > 300)
      throw new Error("upload grant TTL이 유효하지 않습니다");
    const token = randomBytes(32).toString("base64url");
    const key = this.key(token);
    const expiresAt = this.now().getTime() + input.ttlSeconds * 1_000;
    this.records.set(key, { ...input, expiresAt, consumed: false });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  public consume(
    token: string,
    expected: { readonly packageName: string; readonly packageVersion: string; readonly artifactDigest: string },
  ): GrantRecord {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new Error("upload grant 형식이 유효하지 않습니다");
    normalizePackageIdentity(expected.packageName, expected.packageVersion);
    assertDigest(expected.artifactDigest, "artifact");
    const expectedKey = this.key(token);
    let matched: GrantRecord | undefined;
    for (const [key, record] of this.records) {
      const left = Buffer.from(key, "hex");
      const right = Buffer.from(expectedKey, "hex");
      if (left.length === right.length && timingSafeEqual(left, right)) matched = record;
    }
    if (!matched) throw new Error("upload grant를 찾을 수 없습니다");
    if (matched.consumed) throw new Error("upload grant를 이미 소비했습니다");
    if (matched.expiresAt < this.now().getTime()) throw new Error("upload grant가 만료됐습니다");
    if (
      matched.packageName !== expected.packageName ||
      matched.packageVersion !== expected.packageVersion ||
      matched.artifactDigest !== expected.artifactDigest
    )
      throw new Error("upload grant가 package identity와 일치하지 않습니다");
    matched.consumed = true;
    return { ...matched };
  }

  private key(token: string): string {
    return createHmac("sha256", this.options.secret).update(token).digest("hex");
  }
}
