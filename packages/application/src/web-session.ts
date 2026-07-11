import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import type { ApplicationAccessTokenService, AuthenticatedApplicationAccess } from "./auth.js";
import { APPLICATION_WEB_SESSION_MIGRATION, APPLICATION_WEB_SESSION_REVISION_MIGRATION } from "./schema.js";

const TICKET = /^mwt_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/u;
const SESSION = /^mws_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/u;
const CSRF = /^[A-Za-z0-9_-]{43}$/u;
const COMMAND = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

export interface WebSessionClock {
  readonly now: Date;
}

interface LoginTicketRecord {
  readonly ticket_id: string;
  readonly organization_id: string;
  readonly user_id: string;
  readonly source_token_id: string;
  readonly audience: string;
  readonly scopes: readonly string[];
  readonly key_id: string;
  readonly code_hash: string;
  readonly command_id: string;
  readonly request_hash: string;
  readonly issued_at: unknown;
  readonly expires_at: unknown;
  readonly used_at?: unknown;
}

interface WebSessionRecord {
  readonly session_id: string;
  readonly organization_id: string;
  readonly user_id: string;
  readonly source_token_id: string;
  readonly audience: string;
  readonly scopes: readonly string[];
  readonly key_id: string;
  readonly session_hash: string;
  readonly csrf_hash: string;
  readonly issued_at: unknown;
  readonly expires_at: unknown;
  readonly idle_ttl_seconds: number;
  readonly idle_expires_at: unknown;
  readonly last_seen_at: unknown;
  readonly revision: number;
  readonly revoked_at?: unknown;
  readonly revoked_reason?: string;
}

export interface IssuedWebLoginTicket {
  readonly ticketId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly expiresAt: string;
  readonly replayed: boolean;
  readonly code?: string;
}

export interface ExchangedWebSession {
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly context: TenantContext;
  readonly scopes: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly idleExpiresAt: string;
}

export interface AuthenticatedWebSession extends AuthenticatedApplicationAccess {
  readonly sessionId: string;
}

export interface WebSessionView {
  readonly sessionId: string;
  readonly status: "active" | "idle-expired" | "expired" | "revoked";
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly idleExpiresAt: string;
  readonly lastSeenAt: string;
  readonly revision: number;
  readonly revokedAt?: string;
  readonly revokedReason?: string;
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

function date(value: unknown, label: string): Date {
  const result = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(result.getTime())) throw new Error(`${label} datetime이 유효하지 않습니다`);
  return result;
}

async function first<T>(
  executor: QueryExecutor,
  query: string,
  bindings: Record<string, unknown>,
): Promise<T | undefined> {
  const [records] = await executor.query<[T[]]>(query, bindings);
  return records[0];
}

export class WebSessionService {
  private readonly clock: WebSessionClock;

  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly tokens: Pick<ApplicationAccessTokenService, "authenticateTokenId">,
    private readonly keyId: string,
    private readonly key: Buffer,
    clock?: WebSessionClock,
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
    tokens: Pick<ApplicationAccessTokenService, "authenticateTokenId">,
    input: { readonly keyId: string; readonly key: Buffer; readonly clock?: WebSessionClock },
  ): Promise<WebSessionService> {
    if (!/^[a-z][a-z0-9-]{2,63}$/u.test(input.keyId)) throw new Error("Web session keyId가 유효하지 않습니다");
    if (input.key.length < 32) throw new Error("Web session HMAC key는 32 byte 이상이어야 합니다");
    await applyMigrations(database, [APPLICATION_WEB_SESSION_MIGRATION, APPLICATION_WEB_SESSION_REVISION_MIGRATION]);
    return new WebSessionService(database, organizations, tokens, input.keyId, Buffer.from(input.key), input.clock);
  }

  public async issueLoginTicket(
    access: AuthenticatedApplicationAccess,
    input: { readonly commandId: string; readonly ttlSeconds?: number },
  ): Promise<IssuedWebLoginTicket> {
    if (!COMMAND.test(input.commandId)) throw new Error("Web login ticket commandId가 유효하지 않습니다");
    const ttlSeconds = input.ttlSeconds ?? 300;
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 300)
      throw new Error("Web login ticket ttlSeconds가 유효하지 않습니다");
    const verified = await this.tokens.authenticateTokenId(access.tokenId, "massion-api", []);
    if (
      verified.context.organizationId !== access.context.organizationId ||
      verified.context.userId !== access.context.userId
    )
      throw new Error("Web login ticket access 계보가 일치하지 않습니다");
    const issuedAt = this.clock.now.toISOString();
    const expiresAt = new Date(this.clock.now.getTime() + ttlSeconds * 1_000).toISOString();
    const requestHash = sha256(canonicalJson({ ...input, ttlSeconds, tokenId: access.tokenId }));
    let raw: string | undefined;
    const record = await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(access.context, undefined, transaction);
      const replayed = await first<LoginTicketRecord>(
        transaction,
        "SELECT * OMIT id FROM application_web_login_ticket WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
        { organization_id: access.context.organizationId, command_id: input.commandId },
      );
      if (replayed) {
        if (replayed.request_hash !== requestHash)
          throw new Error("같은 commandId에 다른 Web login ticket 요청을 사용할 수 없습니다");
        return replayed;
      }
      const ticketId = randomUUID();
      raw = `mwt_${ticketId}.${randomBytes(32).toString("base64url")}`;
      const created = await first<LoginTicketRecord>(
        transaction,
        "CREATE application_web_login_ticket CONTENT { ticket_id: $ticket_id, organization_id: $organization_id, user_id: $user_id, source_token_id: $source_token_id, audience: 'massion-api', scopes: $scopes, key_id: $key_id, code_hash: $code_hash, command_id: $command_id, request_hash: $request_hash, issued_at: <datetime>$issued_at, expires_at: <datetime>$expires_at, used_at: NONE } RETURN AFTER;",
        {
          ticket_id: ticketId,
          organization_id: access.context.organizationId,
          user_id: access.context.userId,
          source_token_id: access.tokenId,
          scopes: [...access.scopes],
          key_id: this.keyId,
          code_hash: this.digest(raw),
          command_id: input.commandId,
          request_hash: requestHash,
          issued_at: issuedAt,
          expires_at: expiresAt,
        },
      );
      if (!created) throw new Error("Web login ticket 생성 결과가 없습니다");
      await this.event(transaction, created.organization_id, created.user_id, { ticketId }, "ticket-issued");
      return created;
    });
    return {
      ticketId: record.ticket_id,
      organizationId: record.organization_id,
      userId: record.user_id,
      expiresAt: date(record.expires_at, "ticket expiresAt").toISOString(),
      replayed: raw === undefined,
      ...(raw === undefined ? {} : { code: raw }),
    };
  }

  public async exchangeLoginTicket(
    code: string,
    input: { readonly absoluteTtlSeconds?: number; readonly idleTtlSeconds?: number } = {},
  ): Promise<ExchangedWebSession> {
    const match = code.match(TICKET);
    if (!match?.[1]) throw new Error("Web login ticket 형식이 유효하지 않습니다");
    const absoluteTtlSeconds = input.absoluteTtlSeconds ?? 28_800;
    const idleTtlSeconds = input.idleTtlSeconds ?? 1_800;
    if (
      !Number.isSafeInteger(absoluteTtlSeconds) ||
      absoluteTtlSeconds < 300 ||
      absoluteTtlSeconds > 86_400 ||
      !Number.isSafeInteger(idleTtlSeconds) ||
      idleTtlSeconds < 60 ||
      idleTtlSeconds > absoluteTtlSeconds
    )
      throw new Error("Web session TTL이 유효하지 않습니다");
    const candidate = await first<LoginTicketRecord>(
      this.database,
      "SELECT * OMIT id FROM application_web_login_ticket WHERE ticket_id = $ticket_id LIMIT 1;",
      { ticket_id: match[1] },
    );
    this.assertTicket(candidate, code);
    const source = await this.tokens.authenticateTokenId(candidate.source_token_id, candidate.audience, []);
    const now = this.clock.now.toISOString();
    const expiresAt = new Date(this.clock.now.getTime() + absoluteTtlSeconds * 1_000).toISOString();
    const idleExpiresAt = new Date(this.clock.now.getTime() + idleTtlSeconds * 1_000).toISOString();
    const sessionId = randomUUID();
    const sessionToken = `mws_${sessionId}.${randomBytes(32).toString("base64url")}`;
    const csrfToken = randomBytes(32).toString("base64url");
    await this.database.transaction(async (transaction) => {
      const consumed = await first<LoginTicketRecord>(
        transaction,
        "UPDATE application_web_login_ticket SET used_at = <datetime>$now WHERE ticket_id = $ticket_id AND used_at = NONE AND expires_at > <datetime>$now RETURN AFTER;",
        { ticket_id: candidate.ticket_id, now },
      );
      if (!consumed || !this.matches(code, consumed.code_hash))
        throw new Error("Web login ticket은 만료됐거나 이미 사용됐습니다");
      const created = await first<WebSessionRecord>(
        transaction,
        "CREATE application_web_session CONTENT { session_id: $session_id, organization_id: $organization_id, user_id: $user_id, source_token_id: $source_token_id, audience: $audience, scopes: $scopes, key_id: $key_id, session_hash: $session_hash, csrf_hash: $csrf_hash, issued_at: <datetime>$issued_at, expires_at: <datetime>$expires_at, idle_ttl_seconds: $idle_ttl_seconds, idle_expires_at: <datetime>$idle_expires_at, last_seen_at: <datetime>$issued_at, revision: 0, revoked_at: NONE, revoked_reason: NONE } RETURN AFTER;",
        {
          session_id: sessionId,
          organization_id: consumed.organization_id,
          user_id: consumed.user_id,
          source_token_id: consumed.source_token_id,
          audience: consumed.audience,
          scopes: [...consumed.scopes],
          key_id: this.keyId,
          session_hash: this.digest(sessionToken),
          csrf_hash: this.digest(csrfToken),
          issued_at: now,
          expires_at: expiresAt,
          idle_ttl_seconds: idleTtlSeconds,
          idle_expires_at: idleExpiresAt,
        },
      );
      if (!created) throw new Error("Web session 생성 결과가 없습니다");
      await this.event(
        transaction,
        consumed.organization_id,
        consumed.user_id,
        { ticketId: consumed.ticket_id },
        "ticket-consumed",
      );
      await this.event(transaction, consumed.organization_id, consumed.user_id, { sessionId }, "session-issued");
    });
    const verified = await this.tokens.authenticateTokenId(candidate.source_token_id, candidate.audience, []);
    if (
      verified.context.organizationId !== source.context.organizationId ||
      verified.context.userId !== source.context.userId
    )
      throw new Error("Web session source token 계보가 변경됐습니다");
    return {
      sessionId,
      sessionToken,
      csrfToken,
      context: verified.context,
      scopes: verified.scopes,
      issuedAt: now,
      expiresAt,
      idleExpiresAt,
    };
  }

  public async authenticate(
    sessionToken: string,
    audience: string,
    requiredScopes: readonly string[],
  ): Promise<AuthenticatedWebSession> {
    const record = await this.session(sessionToken);
    if (record.audience !== audience) throw new Error("Web session audience가 일치하지 않습니다");
    if (record.revoked_at !== undefined) throw new Error("Web session이 폐기됐습니다");
    if (date(record.expires_at, "session expiresAt").getTime() <= this.clock.now.getTime())
      throw new Error("Web session이 만료됐습니다");
    if (date(record.idle_expires_at, "session idleExpiresAt").getTime() <= this.clock.now.getTime())
      throw new Error("Web session이 비활성(idle) 만료됐습니다");
    const source = await this.tokens.authenticateTokenId(record.source_token_id, audience, requiredScopes);
    if (source.context.organizationId !== record.organization_id || source.context.userId !== record.user_id)
      throw new Error("Web session tenant 계보가 일치하지 않습니다");
    const idleExpiresAt = new Date(this.clock.now.getTime() + record.idle_ttl_seconds * 1_000);
    const boundedIdle = new Date(
      Math.min(idleExpiresAt.getTime(), date(record.expires_at, "session expiresAt").getTime()),
    );
    await this.database.query(
      "UPDATE application_web_session SET last_seen_at = <datetime>$now, idle_expires_at = <datetime>$idle_expires_at WHERE session_id = $session_id AND revoked_at = NONE;",
      { session_id: record.session_id, now: this.clock.now.toISOString(), idle_expires_at: boundedIdle.toISOString() },
    );
    return { ...source, sessionId: record.session_id };
  }

  public async verifyCsrf(sessionToken: string, csrfToken: string): Promise<boolean> {
    if (!CSRF.test(csrfToken)) return false;
    await this.authenticate(sessionToken, "massion-api", []);
    const record = await this.session(sessionToken);
    return this.matches(csrfToken, record.csrf_hash);
  }

  public async list(context: TenantContext): Promise<readonly WebSessionView[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[WebSessionRecord[]]>(
      `SELECT * OMIT id, source_token_id, audience, scopes, key_id, session_hash, csrf_hash, idle_ttl_seconds
       FROM application_web_session
       WHERE organization_id = $organization_id AND user_id = $user_id
       ORDER BY issued_at DESC
       LIMIT 100;`,
      { organization_id: context.organizationId, user_id: context.userId },
    );
    const now = this.clock.now.getTime();
    return records.map((record) => {
      const expiresAt = date(record.expires_at, "session expiresAt");
      const idleExpiresAt = date(record.idle_expires_at, "session idleExpiresAt");
      const revokedAt = record.revoked_at === undefined ? undefined : date(record.revoked_at, "session revokedAt");
      const status: WebSessionView["status"] = revokedAt
        ? "revoked"
        : expiresAt.getTime() <= now
          ? "expired"
          : idleExpiresAt.getTime() <= now
            ? "idle-expired"
            : "active";
      return {
        sessionId: record.session_id,
        status,
        issuedAt: date(record.issued_at, "session issuedAt").toISOString(),
        expiresAt: expiresAt.toISOString(),
        idleExpiresAt: idleExpiresAt.toISOString(),
        lastSeenAt: date(record.last_seen_at, "session lastSeenAt").toISOString(),
        revision: record.revision,
        ...(revokedAt === undefined ? {} : { revokedAt: revokedAt.toISOString() }),
        ...(record.revoked_reason === undefined ? {} : { revokedReason: record.revoked_reason }),
      };
    });
  }

  public async rotateCsrf(sessionToken: string): Promise<string> {
    const access = await this.authenticate(sessionToken, "massion-api", []);
    const csrfToken = randomBytes(32).toString("base64url");
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        "UPDATE application_web_session SET csrf_hash = $csrf_hash WHERE organization_id = $organization_id AND session_id = $session_id AND revoked_at = NONE;",
        {
          organization_id: access.context.organizationId,
          session_id: access.sessionId,
          csrf_hash: this.digest(csrfToken),
        },
      );
      await this.event(
        transaction,
        access.context.organizationId,
        access.context.userId,
        { sessionId: access.sessionId },
        "csrf-rotated",
      );
    });
    return csrfToken;
  }

  public async revokeById(
    context: TenantContext,
    sessionId: string,
    expectedRevision: number,
    reason: string,
  ): Promise<WebSessionView> {
    await this.organizations.verifyTenantContext(context);
    if (!/^[0-9a-f-]{36}$/u.test(sessionId)) throw new Error("Web session ID가 유효하지 않습니다");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new Error("Web session revision이 유효하지 않습니다");
    const normalizedReason = reason.trim();
    if (!normalizedReason || normalizedReason.length > 256)
      throw new Error("Web session 폐기 이유가 유효하지 않습니다");
    const now = this.clock.now.toISOString();
    const updated = await this.database.transaction(async (transaction) => {
      const value = await first<WebSessionRecord>(
        transaction,
        `UPDATE application_web_session
         SET revoked_at = <datetime>$now, revoked_reason = $reason, revision += 1
         WHERE organization_id = $organization_id AND user_id = $user_id AND session_id = $session_id
           AND revision = $expected_revision AND revoked_at = NONE
         RETURN AFTER;`,
        {
          organization_id: context.organizationId,
          user_id: context.userId,
          session_id: sessionId,
          expected_revision: expectedRevision,
          now,
          reason: normalizedReason,
        },
      );
      if (!value) throw new Error("Web session revision이 일치하지 않거나 session을 찾을 수 없습니다");
      await this.event(
        transaction,
        context.organizationId,
        context.userId,
        { sessionId, reason: normalizedReason },
        "session-revoked",
      );
      return value;
    });
    return {
      sessionId: updated.session_id,
      status: "revoked",
      issuedAt: date(updated.issued_at, "session issuedAt").toISOString(),
      expiresAt: date(updated.expires_at, "session expiresAt").toISOString(),
      idleExpiresAt: date(updated.idle_expires_at, "session idleExpiresAt").toISOString(),
      lastSeenAt: date(updated.last_seen_at, "session lastSeenAt").toISOString(),
      revision: updated.revision,
      revokedAt: date(updated.revoked_at, "session revokedAt").toISOString(),
      ...(updated.revoked_reason === undefined ? {} : { revokedReason: updated.revoked_reason }),
    };
  }

  public async revoke(sessionToken: string, csrfToken: string, reason: string): Promise<void> {
    if (!(await this.verifyCsrf(sessionToken, csrfToken)))
      throw new Error("Web session CSRF token이 유효하지 않습니다");
    if (!reason.trim() || reason.length > 256) throw new Error("Web session 폐기 이유가 유효하지 않습니다");
    const record = await this.session(sessionToken);
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        "UPDATE application_web_session SET revoked_at = <datetime>$now, revoked_reason = $reason, revision += 1 WHERE organization_id = $organization_id AND session_id = $session_id AND revoked_at = NONE;",
        {
          organization_id: record.organization_id,
          session_id: record.session_id,
          now: this.clock.now.toISOString(),
          reason: reason.trim(),
        },
      );
      await this.event(
        transaction,
        record.organization_id,
        record.user_id,
        { sessionId: record.session_id, reason },
        "session-revoked",
      );
    });
  }

  private assertTicket(record: LoginTicketRecord | undefined, raw: string): asserts record is LoginTicketRecord {
    if (!record || record.key_id !== this.keyId || !this.matches(raw, record.code_hash))
      throw new Error("Web login ticket이 유효하지 않습니다");
    if (record.used_at !== undefined) throw new Error("Web login ticket은 이미 사용됐습니다");
    if (date(record.expires_at, "ticket expiresAt").getTime() <= this.clock.now.getTime())
      throw new Error("Web login ticket이 만료됐습니다");
  }

  private async session(raw: string): Promise<WebSessionRecord> {
    const match = raw.match(SESSION);
    if (!match?.[1]) throw new Error("Web session 형식이 유효하지 않습니다");
    const record = await first<WebSessionRecord>(
      this.database,
      "SELECT * OMIT id FROM application_web_session WHERE session_id = $session_id LIMIT 1;",
      { session_id: match[1] },
    );
    if (!record || record.key_id !== this.keyId || !this.matches(raw, record.session_hash))
      throw new Error("Web session이 유효하지 않습니다");
    return record;
  }

  private digest(value: string): string {
    return createHmac("sha256", this.key).update(value).digest("hex");
  }

  private matches(value: string, expected: string): boolean {
    const actual = Buffer.from(this.digest(value), "hex");
    const stored = Buffer.from(expected, "hex");
    return actual.length === stored.length && timingSafeEqual(actual, stored);
  }

  private async event(
    executor: QueryExecutor,
    organizationId: string,
    userId: string,
    detail: { readonly sessionId?: string; readonly ticketId?: string; readonly reason?: string },
    eventType: "ticket-issued" | "ticket-consumed" | "session-issued" | "csrf-rotated" | "session-revoked",
  ): Promise<void> {
    await executor.query(
      "CREATE application_web_session_event CONTENT { event_id: $event_id, organization_id: $organization_id, user_id: $user_id, session_id: $session_id, ticket_id: $ticket_id, event_type: $event_type, detail_hash: $detail_hash, created_at: <datetime>$created_at };",
      {
        event_id: randomUUID(),
        organization_id: organizationId,
        user_id: userId,
        session_id: detail.sessionId,
        ticket_id: detail.ticketId,
        event_type: eventType,
        detail_hash: sha256(canonicalJson(detail)),
        created_at: this.clock.now.toISOString(),
      },
    );
  }
}
