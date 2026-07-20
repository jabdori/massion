import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { APPLICATION_AUTH_MIGRATION } from "./schema.js";

const AUDIENCE = /^[a-z][a-z0-9-]{2,63}$/u;
const SCOPE = /^(?:application:\*|[a-z][a-z0-9-]*:[a-z][a-z0-9-]*)$/u;
const TOKEN = /^mat_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/u;

interface TokenRecord {
  readonly token_id: string;
  readonly organization_id: string;
  readonly user_id: string;
  readonly key_id: string;
  readonly audience: string;
  readonly scopes: readonly string[];
  readonly token_hash: string;
  readonly command_id: string;
  readonly request_hash: string;
  readonly issued_at: unknown;
  readonly expires_at: unknown;
  readonly revoked_at?: unknown;
}

interface TokenEventRecord {
  readonly token_id: string;
  readonly request_hash: string;
}

export interface ApplicationTokenClock {
  readonly now: Date;
}

export interface IssueApplicationTokenInput {
  readonly commandId: string;
  readonly audience: string;
  readonly scopes: readonly string[];
  readonly ttlSeconds: number;
}

export interface IssuedApplicationToken {
  readonly tokenId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly audience: string;
  readonly scopes: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly replayed: boolean;
  readonly token?: string;
}

export interface AuthenticatedApplicationAccess {
  readonly context: TenantContext;
  readonly tokenId: string;
  readonly scopes: readonly string[];
}

export interface RevokeApplicationTokenInput {
  readonly commandId: string;
  readonly tokenId: string;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function first<T>(
  executor: QueryExecutor,
  query: string,
  bindings: Record<string, unknown>,
): Promise<T | undefined> {
  const [records] = await executor.query<[T[]]>(query, bindings);
  return records[0];
}

function dateText(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new Error("Application token datetime이 유효하지 않습니다");
  return parsed.toISOString();
}

function validateIssue(input: IssueApplicationTokenInput): {
  readonly scopes: readonly string[];
  readonly hash: string;
} {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(input.commandId)) {
    throw new Error("Application token commandId가 유효하지 않습니다");
  }
  if (!AUDIENCE.test(input.audience)) throw new Error("Application token audience가 유효하지 않습니다");
  const scopes = [...new Set(input.scopes)].sort();
  if (scopes.length === 0 || scopes.length > 64 || scopes.some((scope) => !SCOPE.test(scope))) {
    throw new Error("Application token scope가 유효하지 않습니다");
  }
  if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > 3_600) {
    throw new Error("Application token ttlSeconds가 유효하지 않습니다");
  }
  return { scopes, hash: sha256(canonicalJson({ ...input, scopes })) };
}

export class ApplicationAccessTokenService {
  private readonly clock: ApplicationTokenClock;

  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly keyId: string,
    private readonly key: Buffer,
    clock?: ApplicationTokenClock,
  ) {
    this.clock = clock ?? {
      get now() {
        return new Date();
      },
    };
  }

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    input: { readonly keyId: string; readonly key: Buffer; readonly clock?: ApplicationTokenClock },
  ): Promise<ApplicationAccessTokenService> {
    if (!/^[a-z][a-z0-9-]{2,63}$/u.test(input.keyId)) throw new Error("Application token keyId가 유효하지 않습니다");
    if (input.key.length < 32) throw new Error("Application token HMAC key는 32 byte 이상이어야 합니다");
    await applyMigrations(database, [APPLICATION_AUTH_MIGRATION]);
    return new ApplicationAccessTokenService(database, organizations, input.keyId, Buffer.from(input.key), input.clock);
  }

  public async issue(context: TenantContext, input: IssueApplicationTokenInput): Promise<IssuedApplicationToken> {
    await this.organizations.verifyTenantContext(context);
    const validated = validateIssue(input);
    const issuedAt = this.clock.now.toISOString();
    const expiresAt = new Date(this.clock.now.getTime() + input.ttlSeconds * 1_000).toISOString();
    let rawToken: string | undefined;
    const record = await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const repeated = await first<TokenRecord>(
        transaction,
        "SELECT * OMIT id FROM application_access_token WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
        { organization_id: context.organizationId, command_id: input.commandId },
      );
      if (repeated) {
        if (repeated.request_hash !== validated.hash) {
          throw new Error("같은 commandId에 다른 Application token 요청을 사용할 수 없습니다");
        }
        return repeated;
      }
      const tokenId = randomUUID();
      rawToken = `mat_${tokenId}.${randomBytes(32).toString("base64url")}`;
      const tokenHash = this.digest(rawToken);
      const created = await first<TokenRecord>(
        transaction,
        "CREATE application_access_token CONTENT { token_id: $token_id, organization_id: $organization_id, user_id: $user_id, key_id: $key_id, audience: $audience, scopes: $scopes, token_hash: $token_hash, command_id: $command_id, request_hash: $request_hash, issued_at: <datetime>$issued_at, expires_at: <datetime>$expires_at, revoked_at: NONE } RETURN AFTER;",
        {
          token_id: tokenId,
          organization_id: context.organizationId,
          user_id: context.userId,
          key_id: this.keyId,
          audience: input.audience,
          scopes: [...validated.scopes],
          token_hash: tokenHash,
          command_id: input.commandId,
          request_hash: validated.hash,
          issued_at: issuedAt,
          expires_at: expiresAt,
        },
      );
      if (!created) throw new Error("Application access token 생성 결과가 없습니다");
      await transaction.query(
        "CREATE application_token_event CONTENT { event_id: $event_id, organization_id: $organization_id, token_id: $token_id, actor_user_id: $actor_user_id, command_id: $command_id, event_type: 'issued', request_hash: $request_hash, created_at: <datetime>$created_at };",
        {
          event_id: randomUUID(),
          organization_id: context.organizationId,
          token_id: tokenId,
          actor_user_id: context.userId,
          command_id: input.commandId,
          request_hash: validated.hash,
          created_at: issuedAt,
        },
      );
      return created;
    });
    return this.view(record, rawToken);
  }

  public async authenticate(
    authorization: string | undefined,
    audience: string,
    requiredScopes: readonly string[],
  ): Promise<TenantContext> {
    return (await this.authenticateAccess(authorization, audience, requiredScopes)).context;
  }

  public async authenticateAccess(
    authorization: string | undefined,
    audience: string,
    requiredScopes: readonly string[],
  ): Promise<AuthenticatedApplicationAccess> {
    return await this.access(await this.verifiedRecord(authorization), audience, requiredScopes);
  }

  /**
   * 개인 loopback HTTP 경계에서만 호출하는 만료 token 교체용 경로입니다.
   * 원래 token의 원문 hash·audience·권한·폐기 상태는 그대로 검증합니다.
   */
  public async refreshLocalAccess(
    authorization: string | undefined,
    audience: string,
    requiredScopes: readonly string[],
    input: { readonly commandId: string },
  ): Promise<IssuedApplicationToken> {
    const access = await this.access(await this.verifiedRecord(authorization), audience, requiredScopes, true);
    return await this.issue(access.context, {
      commandId: input.commandId,
      audience,
      scopes: access.scopes,
      ttlSeconds: 3_600,
    });
  }

  private async verifiedRecord(authorization: string | undefined): Promise<TokenRecord> {
    const match = authorization?.match(/^Bearer ([^ ]+)$/u);
    if (!match?.[1]) throw new Error("Authorization Bearer header가 필요합니다");
    const tokenMatch = match[1].match(TOKEN);
    if (!tokenMatch?.[1]) throw new Error("Application access token 형식이 유효하지 않습니다");
    const record = await first<TokenRecord>(
      this.database,
      "SELECT * OMIT id FROM application_access_token WHERE token_id = $token_id LIMIT 1;",
      { token_id: tokenMatch[1] },
    );
    if (!record || record.key_id !== this.keyId || !this.matches(match[1], record.token_hash)) {
      throw new Error("Application access token이 유효하지 않습니다");
    }
    return record;
  }

  public async authenticateTokenId(
    tokenId: string,
    audience: string,
    requiredScopes: readonly string[],
  ): Promise<AuthenticatedApplicationAccess> {
    if (!/^[0-9a-f-]{36}$/u.test(tokenId)) throw new Error("Application access token ID가 유효하지 않습니다");
    const record = await first<TokenRecord>(
      this.database,
      "SELECT * OMIT id FROM application_access_token WHERE token_id = $token_id LIMIT 1;",
      { token_id: tokenId },
    );
    if (!record || record.key_id !== this.keyId) throw new Error("Application access token이 유효하지 않습니다");
    return await this.access(record, audience, requiredScopes);
  }

  private async access(
    record: TokenRecord,
    audience: string,
    requiredScopes: readonly string[],
    allowExpired = false,
  ): Promise<AuthenticatedApplicationAccess> {
    if (record.audience !== audience) throw new Error("Application access token audience가 일치하지 않습니다");
    if (record.revoked_at !== undefined) throw new Error("Application access token이 폐기됐습니다");
    if (!allowExpired && new Date(dateText(record.expires_at)).getTime() <= this.clock.now.getTime()) {
      throw new Error("Application access token이 만료됐습니다");
    }
    if (!record.scopes.includes("application:*") && requiredScopes.some((scope) => !record.scopes.includes(scope))) {
      throw new Error("Application access token scope가 부족합니다");
    }
    return {
      context: await this.organizations.resolveTenantContext(record.user_id, record.organization_id),
      tokenId: record.token_id,
      scopes: record.scopes,
    };
  }

  public async revoke(context: TenantContext, input: RevokeApplicationTokenInput): Promise<void> {
    await this.organizations.verifyTenantContext(context);
    const requestHash = sha256(canonicalJson(input));
    await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const repeated = await first<TokenEventRecord>(
        transaction,
        "SELECT token_id, request_hash FROM application_token_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
        { organization_id: context.organizationId, command_id: input.commandId },
      );
      if (repeated) {
        if (repeated.request_hash !== requestHash) {
          throw new Error("같은 commandId에 다른 Application token 폐기 요청을 사용할 수 없습니다");
        }
        return;
      }
      const token = await first<TokenRecord>(
        transaction,
        "SELECT * OMIT id FROM application_access_token WHERE organization_id = $organization_id AND token_id = $token_id LIMIT 1;",
        { organization_id: context.organizationId, token_id: input.tokenId },
      );
      if (!token) throw new Error("Application access token을 찾을 수 없습니다");
      const revokedAt = this.clock.now.toISOString();
      await transaction.query(
        "UPDATE application_access_token SET revoked_at = <datetime>$revoked_at WHERE organization_id = $organization_id AND token_id = $token_id;",
        { organization_id: context.organizationId, token_id: input.tokenId, revoked_at: revokedAt },
      );
      await transaction.query(
        "CREATE application_token_event CONTENT { event_id: $event_id, organization_id: $organization_id, token_id: $token_id, actor_user_id: $actor_user_id, command_id: $command_id, event_type: 'revoked', request_hash: $request_hash, created_at: <datetime>$created_at };",
        {
          event_id: randomUUID(),
          organization_id: context.organizationId,
          token_id: input.tokenId,
          actor_user_id: context.userId,
          command_id: input.commandId,
          request_hash: requestHash,
          created_at: revokedAt,
        },
      );
    });
  }

  private digest(token: string): string {
    return createHmac("sha256", this.key).update(token).digest("hex");
  }

  private matches(token: string, expected: string): boolean {
    const actual = Buffer.from(this.digest(token), "hex");
    const stored = Buffer.from(expected, "hex");
    return actual.length === stored.length && timingSafeEqual(actual, stored);
  }

  private view(record: TokenRecord, token?: string): IssuedApplicationToken {
    return {
      tokenId: record.token_id,
      organizationId: record.organization_id,
      userId: record.user_id,
      audience: record.audience,
      scopes: record.scopes,
      issuedAt: dateText(record.issued_at),
      expiresAt: dateText(record.expires_at),
      replayed: token === undefined,
      ...(token === undefined ? {} : { token }),
    };
  }
}
