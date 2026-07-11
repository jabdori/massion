import { createHmac, randomBytes, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import type { IntegrationPlatform } from "./contracts.js";
import { INTEGRATION_MIGRATIONS } from "./schema.js";

interface OAuthRecord {
  attempt_id: string;
  organization_id: string;
  platform: IntegrationPlatform;
  state_hash: string;
  redirect_uri: string;
  expires_at: string | Date;
  consumed_at?: string | Date;
  created_by_user_id: string;
}

interface InteractionRecord {
  interaction_id: string;
  organization_id: string;
  installation_id: string;
  external_user_id: string;
  handle_hash: string;
  action: string;
  resource_id: string;
  payload_hash: string;
  expires_at: string | Date;
  consumed_at?: string | Date;
}

async function first<T>(
  executor: QueryExecutor,
  query: string,
  bindings: Record<string, unknown>,
): Promise<T | undefined> {
  const [records] = await executor.query<[T[]]>(query, bindings);
  return records[0];
}

function date(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

export class IntegrationTokenService {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly key: Buffer,
  ) {}

  public static async create(database: MassionDatabase, organizations: OrganizationService, key: Buffer) {
    if (key.length < 32) throw new Error("Integration token HMAC key는 32 byte 이상이어야 합니다");
    await applyMigrations(database, INTEGRATION_MIGRATIONS);
    return new IntegrationTokenService(database, organizations, Buffer.from(key));
  }

  public async issueOAuthState(
    context: TenantContext,
    input: { platform: IntegrationPlatform; redirectUri: string; ttlSeconds?: number },
  ) {
    await this.organizations.verifyTenantContext(context);
    const redirect = new URL(input.redirectUri);
    if (redirect.protocol !== "https:" || redirect.username || redirect.password || redirect.hash)
      throw new Error("OAuth redirect URI가 유효하지 않습니다");
    const ttl = input.ttlSeconds ?? 600;
    if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 600) throw new Error("OAuth state TTL이 유효하지 않습니다");
    const state = randomBytes(32).toString("base64url");
    const attemptId = randomUUID();
    const expiresAt = new Date(Date.now() + ttl * 1000);
    await this.database.query(
      "CREATE integration_oauth_attempt CONTENT { attempt_id:$attempt_id, organization_id:$organization_id, platform:$platform, state_hash:$state_hash, redirect_uri:$redirect_uri, expires_at:$expires_at, consumed_at:NONE, created_by_user_id:$user_id, created_at:time::now() };",
      {
        attempt_id: attemptId,
        organization_id: context.organizationId,
        platform: input.platform,
        state_hash: this.digest("oauth", state),
        redirect_uri: redirect.toString(),
        expires_at: expiresAt,
        user_id: context.userId,
      },
    );
    return { attemptId, state, expiresAt: expiresAt.toISOString() };
  }

  public async consumeOAuthState(state: string, now = new Date()) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(state)) throw new Error("OAuth state가 유효하지 않습니다");
    const record = await this.database.transaction(async (tx) => {
      const record = await first<OAuthRecord>(
        tx,
        "SELECT * OMIT id FROM integration_oauth_attempt WHERE state_hash=$state_hash LIMIT 1;",
        { state_hash: this.digest("oauth", state) },
      );
      if (!record || record.consumed_at || date(record.expires_at).getTime() <= now.getTime())
        throw new Error("OAuth state가 만료됐거나 이미 소비됐습니다");
      const consumed = await first<OAuthRecord>(
        tx,
        "UPDATE integration_oauth_attempt SET consumed_at=$now WHERE attempt_id=$attempt_id AND consumed_at=NONE AND expires_at>$now RETURN AFTER;",
        { attempt_id: record.attempt_id, now },
      );
      if (!consumed) throw new Error("OAuth state 동시 소비를 거부했습니다");
      return record;
    });
    const context = await this.organizations.resolveTenantContext(record.created_by_user_id, record.organization_id);
    return { context, attemptId: record.attempt_id, platform: record.platform, redirectUri: record.redirect_uri };
  }

  public async issueInteraction(
    context: TenantContext,
    input: {
      installationId: string;
      externalUserId: string;
      action: string;
      resourceId: string;
      payloadHash: string;
      ttlSeconds?: number;
    },
  ) {
    await this.organizations.verifyTenantContext(context);
    if (
      !/^[a-z][a-z0-9.-]{1,127}$/u.test(input.action) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(input.resourceId) ||
      !/^[a-f0-9]{64}$/u.test(input.payloadHash)
    )
      throw new Error("Interaction handle input이 유효하지 않습니다");
    const ttl = input.ttlSeconds ?? 900;
    if (!Number.isSafeInteger(ttl) || ttl < 30 || ttl > 900)
      throw new Error("Interaction handle TTL이 유효하지 않습니다");
    const handle = randomBytes(24).toString("base64url");
    const interactionId = randomUUID();
    const expiresAt = new Date(Date.now() + ttl * 1000);
    await this.database.query(
      "CREATE integration_interaction_handle CONTENT { interaction_id:$interaction_id, organization_id:$organization_id, installation_id:$installation_id, external_user_id:$external_user_id, handle_hash:$handle_hash, action:$action, resource_id:$resource_id, payload_hash:$payload_hash, expires_at:$expires_at, consumed_at:NONE, created_at:time::now() };",
      {
        interaction_id: interactionId,
        organization_id: context.organizationId,
        installation_id: input.installationId,
        external_user_id: input.externalUserId,
        handle_hash: this.digest("interaction", handle),
        action: input.action,
        resource_id: input.resourceId,
        payload_hash: input.payloadHash,
        expires_at: expiresAt,
      },
    );
    return { interactionId, handle, expiresAt: expiresAt.toISOString() };
  }

  public async consumeInteraction(
    context: TenantContext,
    input: {
      installationId: string;
      externalUserId: string;
      handle: string;
      action: string;
      payloadHash: string;
      now?: Date;
    },
  ) {
    await this.organizations.verifyTenantContext(context);
    if (!/^[A-Za-z0-9_-]{32}$/u.test(input.handle)) throw new Error("Interaction handle이 유효하지 않습니다");
    const now = input.now ?? new Date();
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const record = await first<InteractionRecord>(
        tx,
        "SELECT * OMIT id FROM integration_interaction_handle WHERE organization_id=$organization_id AND handle_hash=$handle_hash LIMIT 1;",
        { organization_id: context.organizationId, handle_hash: this.digest("interaction", input.handle) },
      );
      if (
        !record ||
        record.consumed_at ||
        date(record.expires_at).getTime() <= now.getTime() ||
        record.installation_id !== input.installationId ||
        record.external_user_id !== input.externalUserId ||
        record.action !== input.action ||
        record.payload_hash !== input.payloadHash
      )
        throw new Error("Interaction handle binding이 일치하지 않거나 만료됐습니다");
      const consumed = await first<InteractionRecord>(
        tx,
        "UPDATE integration_interaction_handle SET consumed_at=$now WHERE organization_id=$organization_id AND interaction_id=$interaction_id AND consumed_at=NONE AND expires_at>$now RETURN AFTER;",
        { organization_id: context.organizationId, interaction_id: record.interaction_id, now },
      );
      if (!consumed) throw new Error("Interaction handle 동시 소비를 거부했습니다");
      return { interactionId: record.interaction_id, resourceId: record.resource_id, action: record.action };
    });
  }

  private digest(kind: string, token: string): string {
    return createHmac("sha256", this.key).update(`massion-integration:${kind}:v1:`).update(token).digest("hex");
  }
}
