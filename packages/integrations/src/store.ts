import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import type { IntegrationPlatform } from "./contracts.js";
import { normalizeDeliveryId, normalizeExternalId } from "./contracts.js";
import { INTEGRATION_MIGRATIONS } from "./schema.js";

const HASH = /^[a-f0-9]{64}$/u;
const REFERENCE = /^[a-z][a-z0-9-]{1,31}:[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/u;
const SECRET = /\b(?:xox[baprs]-|gh[opusr]_|Bearer\s+)[A-Za-z0-9._~+/-]{12,}/iu;

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

async function first<T>(
  executor: QueryExecutor,
  surql: string,
  bindings: Record<string, unknown>,
): Promise<T | undefined> {
  const [records] = await executor.query<[T[]]>(surql, bindings);
  return records[0];
}

interface InstallationRecord {
  installation_id: string;
  organization_id: string;
  platform: IntegrationPlatform;
  external_tenant_id: string;
  credential_ref: string;
  scopes: string[];
  state: "active" | "disabled" | "blocked";
  revision: number;
  command_id: string;
  request_hash: string;
}

interface BindingRecord {
  binding_id: string;
  organization_id: string;
  installation_id: string;
  external_user_id: string;
  user_id: string;
  state: "active" | "revoked";
  revision: number;
  command_id: string;
  request_hash: string;
}

interface ChannelBindingRecord {
  channel_binding_id: string;
  organization_id: string;
  installation_id: string;
  external_resource_id: string;
  resource_kind: "channel" | "repository";
  maximum_classification: "public";
  events: string[];
  state: "active" | "revoked";
  revision: number;
  command_id: string;
  request_hash: string;
}

interface DeliveryRecord {
  delivery_record_id: string;
  organization_id: string;
  installation_id: string;
  delivery_id: string;
  event_type: string;
  body_hash: string;
  state: "accepted" | "processing" | "succeeded" | "failed" | "blocked";
  attempt: number;
  lease_owner?: string;
  lease_generation: number;
  lease_expires_at?: string | Date;
  payload_json?: string;
}

interface OutboxRecord {
  outbox_id: string;
  organization_id: string;
  installation_id: string;
  destination: string;
  operation: string;
  idempotency_key: string;
  payload_json: string;
  payload_hash: string;
  state: "pending" | "processing" | "retrying" | "succeeded" | "blocked";
  attempt: number;
  lease_owner?: string;
  lease_generation: number;
  command_id: string;
  request_hash: string;
}

export class IntegrationStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(database: MassionDatabase, organizations: OrganizationService): Promise<IntegrationStore> {
    await applyMigrations(database, INTEGRATION_MIGRATIONS);
    return new IntegrationStore(database, organizations);
  }

  public async connect(
    context: TenantContext,
    input: {
      commandId: string;
      platform: IntegrationPlatform;
      externalTenantId: string;
      credentialRef: string;
      scopes: readonly string[];
    },
  ) {
    await this.organizations.verifyTenantContext(context);
    normalizeExternalId(input.platform, input.externalTenantId);
    if (!REFERENCE.test(input.credentialRef) || SECRET.test(input.credentialRef))
      throw new Error("Integration credential reference가 유효하지 않습니다");
    const scopes = [...new Set(input.scopes)].sort();
    if (scopes.length !== input.scopes.length || scopes.some((scope) => !/^[a-z][a-z0-9._:-]{1,127}$/u.test(scope)))
      throw new Error("Integration scope가 유효하지 않습니다");
    const requestHash = sha256(canonical({ ...input, scopes }));
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const replay = await first<InstallationRecord>(
        tx,
        "SELECT * OMIT id FROM integration_installation WHERE organization_id=$organization_id AND command_id=$command_id LIMIT 1;",
        { organization_id: context.organizationId, command_id: input.commandId },
      );
      if (replay) {
        if (replay.request_hash !== requestHash)
          throw new Error("같은 commandId에 다른 Integration 요청을 사용할 수 없습니다");
        return this.installationView(replay);
      }
      const installation = await first<InstallationRecord>(
        tx,
        "CREATE integration_installation CONTENT { installation_id:$installation_id, organization_id:$organization_id, platform:$platform, external_tenant_id:$external_tenant_id, credential_ref:$credential_ref, scopes:$scopes, state:'active', revision:1, command_id:$command_id, request_hash:$request_hash, created_at:time::now(), updated_at:time::now() } RETURN AFTER;",
        {
          installation_id: randomUUID(),
          organization_id: context.organizationId,
          platform: input.platform,
          external_tenant_id: input.externalTenantId,
          credential_ref: input.credentialRef,
          scopes,
          command_id: input.commandId,
          request_hash: requestHash,
        },
      );
      if (!installation) throw new Error("Integration installation 생성 결과가 없습니다");
      return this.installationView(installation);
    });
  }

  public async getInstallation(context: TenantContext, installationId: string) {
    await this.organizations.verifyTenantContext(context);
    const record = await first<InstallationRecord>(
      this.database,
      "SELECT * OMIT id FROM integration_installation WHERE organization_id=$organization_id AND installation_id=$installation_id LIMIT 1;",
      { organization_id: context.organizationId, installation_id: installationId },
    );
    if (!record) throw new Error("Integration installation을 찾을 수 없습니다");
    return this.installationView(record);
  }

  public async list(context: TenantContext) {
    await this.organizations.verifyTenantContext(context);
    const [installations] = await this.database.query<[InstallationRecord[]]>(
      "SELECT * OMIT id FROM integration_installation WHERE organization_id=$organization_id ORDER BY platform, created_at;",
      { organization_id: context.organizationId },
    );
    const [channels] = await this.database.query<[ChannelBindingRecord[]]>(
      "SELECT * OMIT id FROM integration_channel_binding WHERE organization_id=$organization_id ORDER BY created_at;",
      { organization_id: context.organizationId },
    );
    return installations.map((installation) => ({
      installationId: installation.installation_id,
      platform: installation.platform,
      externalTenantId: installation.external_tenant_id,
      scopes: [...installation.scopes],
      state: installation.state,
      revision: installation.revision,
      channels: channels
        .filter((channel) => channel.installation_id === installation.installation_id)
        .map((channel) => this.channelView(channel)),
    }));
  }

  public async listDeliveries(context: TenantContext, limit = 100) {
    await this.organizations.verifyTenantContext(context);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
      throw new Error("Integration delivery limit이 유효하지 않습니다");
    const [records] = await this.database.query<[DeliveryRecord[]]>(
      "SELECT * OMIT id, payload_json, body_hash, result_hash FROM integration_delivery WHERE organization_id=$organization_id ORDER BY received_at DESC LIMIT $limit;",
      { organization_id: context.organizationId, limit },
    );
    return records.map((record) => ({
      deliveryRecordId: record.delivery_record_id,
      installationId: record.installation_id,
      deliveryId: record.delivery_id,
      eventType: record.event_type,
      state: record.state,
      attempt: record.attempt,
      receivedAt: (record as DeliveryRecord & { received_at?: string | Date }).received_at,
    }));
  }

  public async recordTelemetry(
    context: TenantContext,
    input: {
      sourceId: string;
      installationId?: string;
      platform: IntegrationPlatform;
      eventType: string;
      outcome: string;
      payload: unknown;
      metricName: string;
      value?: number;
    },
  ): Promise<void> {
    await this.organizations.verifyTenantContext(context);
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(input.sourceId) ||
      !/^[a-z][a-z0-9._-]{1,127}$/u.test(input.eventType) ||
      !/^[a-z][a-z0-9._-]{1,127}$/u.test(input.metricName) ||
      !/^[a-z][a-z0-9._-]{1,63}$/u.test(input.outcome) ||
      !Number.isFinite(input.value ?? 1) ||
      (input.value ?? 1) < 0
    )
      throw new Error("Integration telemetry input이 유효하지 않습니다");
    const payloadHash = sha256(canonical(input.payload));
    await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const existing = await first<{ payload_hash: string }>(
        tx,
        "SELECT payload_hash FROM integration_event WHERE organization_id=$organization_id AND source_id=$source_id AND event_type=$event_type LIMIT 1;",
        { organization_id: context.organizationId, source_id: input.sourceId, event_type: input.eventType },
      );
      if (existing) {
        if (existing.payload_hash !== payloadHash)
          throw new Error("같은 telemetry source에 다른 payload를 사용할 수 없습니다");
        return;
      }
      await tx.query(
        `CREATE integration_event CONTENT { event_id:$event_id, organization_id:$organization_id, installation_id:${input.installationId === undefined ? "NONE" : "$installation_id"}, source_id:$source_id, event_type:$event_type, outcome:$outcome, payload_hash:$payload_hash, created_at:time::now() };`,
        {
          event_id: randomUUID(),
          organization_id: context.organizationId,
          ...(input.installationId === undefined ? {} : { installation_id: input.installationId }),
          source_id: input.sourceId,
          event_type: input.eventType,
          outcome: input.outcome,
          payload_hash: payloadHash,
        },
      );
      await tx.query(
        "CREATE integration_metric CONTENT { metric_id:$metric_id, organization_id:$organization_id, source_id:$source_id, metric_name:$metric_name, platform:$platform, outcome:$outcome, value:$value, created_at:time::now() };",
        {
          metric_id: randomUUID(),
          organization_id: context.organizationId,
          source_id: input.sourceId,
          metric_name: input.metricName,
          platform: input.platform,
          outcome: input.outcome,
          value: input.value ?? 1,
        },
      );
    });
  }

  public async bindUser(
    context: TenantContext,
    input: { commandId: string; installationId: string; externalUserId: string; userId: string },
  ) {
    await this.getInstallation(context, input.installationId);
    normalizeExternalId("slack", input.externalUserId);
    const requestHash = sha256(canonical(input));
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const replay = await first<BindingRecord>(
        tx,
        "SELECT * OMIT id FROM integration_user_binding WHERE organization_id=$organization_id AND command_id=$command_id LIMIT 1;",
        { organization_id: context.organizationId, command_id: input.commandId },
      );
      if (replay) {
        if (replay.request_hash !== requestHash)
          throw new Error("같은 commandId에 다른 user binding 요청을 사용할 수 없습니다");
        return this.bindingView(replay);
      }
      const record = await first<BindingRecord>(
        tx,
        "CREATE integration_user_binding CONTENT { binding_id:$binding_id, organization_id:$organization_id, installation_id:$installation_id, external_user_id:$external_user_id, user_id:$user_id, state:'active', revision:1, command_id:$command_id, request_hash:$request_hash, created_at:time::now(), updated_at:time::now() } RETURN AFTER;",
        {
          binding_id: randomUUID(),
          organization_id: context.organizationId,
          installation_id: input.installationId,
          external_user_id: input.externalUserId,
          user_id: input.userId,
          command_id: input.commandId,
          request_hash: requestHash,
        },
      );
      if (!record) throw new Error("Integration user binding 생성 결과가 없습니다");
      return this.bindingView(record);
    });
  }

  public async bindChannel(
    context: TenantContext,
    input: {
      commandId: string;
      installationId: string;
      externalResourceId: string;
      resourceKind: "channel" | "repository";
      events: readonly string[];
    },
  ) {
    await this.getInstallation(context, input.installationId);
    if (
      input.externalResourceId.length === 0 ||
      input.externalResourceId.length > 256 ||
      /(?:^|\/)\.\.?($|\/)|\\/u.test(input.externalResourceId)
    )
      throw new Error("Integration channel resource가 유효하지 않습니다");
    const events = [...new Set(input.events)].sort();
    if (
      events.length !== input.events.length ||
      events.some((event) => event !== "*" && !/^[a-z][a-z0-9._*-]{0,127}$/u.test(event))
    )
      throw new Error("Integration channel event가 유효하지 않습니다");
    const requestHash = sha256(canonical({ ...input, events }));
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const replay = await first<ChannelBindingRecord>(
        tx,
        "SELECT * OMIT id FROM integration_channel_binding WHERE organization_id=$organization_id AND command_id=$command_id LIMIT 1;",
        { organization_id: context.organizationId, command_id: input.commandId },
      );
      if (replay) {
        if (replay.request_hash !== requestHash)
          throw new Error("같은 commandId에 다른 channel binding 요청을 사용할 수 없습니다");
        return this.channelView(replay);
      }
      const record = await first<ChannelBindingRecord>(
        tx,
        "CREATE integration_channel_binding CONTENT { channel_binding_id:$binding_id, organization_id:$organization_id, installation_id:$installation_id, external_resource_id:$external_resource_id, resource_kind:$resource_kind, maximum_classification:'public', events:$events, state:'active', revision:1, command_id:$command_id, request_hash:$request_hash, created_at:time::now(), updated_at:time::now() } RETURN AFTER;",
        {
          binding_id: randomUUID(),
          organization_id: context.organizationId,
          installation_id: input.installationId,
          external_resource_id: input.externalResourceId,
          resource_kind: input.resourceKind,
          events,
          command_id: input.commandId,
          request_hash: requestHash,
        },
      );
      if (!record) throw new Error("Integration channel binding 생성 결과가 없습니다");
      return this.channelView(record);
    });
  }

  public async assertBoundResource(
    context: TenantContext,
    installationId: string,
    externalResourceId: string,
    event: string,
  ): Promise<void> {
    await this.organizations.verifyTenantContext(context);
    const record = await first<ChannelBindingRecord>(
      this.database,
      "SELECT * OMIT id FROM integration_channel_binding WHERE organization_id=$organization_id AND installation_id=$installation_id AND external_resource_id=$external_resource_id AND state='active' LIMIT 1;",
      {
        organization_id: context.organizationId,
        installation_id: installationId,
        external_resource_id: externalResourceId,
      },
    );
    if (!record || (!record.events.includes("*") && !record.events.includes(event)))
      throw new Error("허용된 Integration channel binding을 찾을 수 없습니다");
  }

  public async acceptDelivery(
    context: TenantContext,
    input: {
      installationId: string;
      deliveryId: string;
      eventType: string;
      bodyHash: string;
      normalizedPayload?: unknown;
      receivedAt: Date;
    },
  ) {
    const installation = await this.getInstallation(context, input.installationId);
    normalizeDeliveryId(installation.platform, input.deliveryId);
    if (!HASH.test(input.bodyHash) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.eventType))
      throw new Error("Integration delivery input이 유효하지 않습니다");
    const payloadJson = canonical(input.normalizedPayload ?? {});
    if (Buffer.byteLength(payloadJson) > 262_144 || SECRET.test(payloadJson))
      throw new Error("Integration delivery payload가 안전하지 않습니다");
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const replay = await first<DeliveryRecord>(
        tx,
        "SELECT * OMIT id FROM integration_delivery WHERE organization_id=$organization_id AND installation_id=$installation_id AND delivery_id=$delivery_id LIMIT 1;",
        {
          organization_id: context.organizationId,
          installation_id: input.installationId,
          delivery_id: input.deliveryId,
        },
      );
      if (replay) {
        if (replay.body_hash !== input.bodyHash)
          throw new Error("같은 delivery ID에 다른 body hash를 사용할 수 없습니다");
        return { ...this.deliveryView(replay), replayed: true };
      }
      const record = await first<DeliveryRecord>(
        tx,
        "CREATE integration_delivery CONTENT { delivery_record_id:$delivery_record_id, organization_id:$organization_id, installation_id:$installation_id, delivery_id:$delivery_id, event_type:$event_type, body_hash:$body_hash, payload_json:$payload_json, state:'accepted', attempt:0, lease_owner:NONE, lease_generation:0, lease_expires_at:NONE, result_hash:NONE, received_at:$received_at, updated_at:time::now() } RETURN AFTER;",
        {
          delivery_record_id: randomUUID(),
          organization_id: context.organizationId,
          installation_id: input.installationId,
          delivery_id: input.deliveryId,
          event_type: input.eventType,
          body_hash: input.bodyHash,
          payload_json: payloadJson,
          received_at: input.receivedAt,
        },
      );
      if (!record) throw new Error("Integration delivery 생성 결과가 없습니다");
      return { ...this.deliveryView(record), replayed: false };
    });
  }

  public async claimDelivery(context: TenantContext, input: { workerId: string; now: Date; leaseMs: number }) {
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const candidate = await first<DeliveryRecord>(
        tx,
        "SELECT * OMIT id FROM integration_delivery WHERE organization_id=$organization_id AND (state='accepted' OR (state='processing' AND lease_expires_at <= $now)) ORDER BY received_at ASC LIMIT 1;",
        { organization_id: context.organizationId, now: input.now },
      );
      if (!candidate) return undefined;
      const record = await first<DeliveryRecord>(
        tx,
        "UPDATE integration_delivery SET state='processing', attempt=attempt+1, lease_owner=$worker_id, lease_generation=lease_generation+1, lease_expires_at=$lease_expires_at, updated_at=time::now() WHERE organization_id=$organization_id AND delivery_record_id=$delivery_record_id AND lease_generation=$expected_generation RETURN AFTER;",
        {
          organization_id: context.organizationId,
          delivery_record_id: candidate.delivery_record_id,
          expected_generation: candidate.lease_generation,
          worker_id: input.workerId,
          lease_expires_at: new Date(input.now.getTime() + input.leaseMs),
        },
      );
      if (!record) throw new Error("Integration delivery lease 충돌입니다");
      return this.deliveryView(record);
    });
  }

  public async resolveVerifiedActor(platform: IntegrationPlatform, externalTenantId: string, externalUserId: string) {
    normalizeExternalId(platform, externalTenantId);
    normalizeExternalId(platform, externalUserId);
    const installation = await first<InstallationRecord>(
      this.database,
      "SELECT * OMIT id FROM integration_installation WHERE platform=$platform AND external_tenant_id=$external_tenant_id AND state='active' LIMIT 1;",
      { platform, external_tenant_id: externalTenantId },
    );
    if (!installation) throw new Error("활성 Integration installation을 찾을 수 없습니다");
    const binding = await first<BindingRecord>(
      this.database,
      "SELECT * OMIT id FROM integration_user_binding WHERE organization_id=$organization_id AND installation_id=$installation_id AND external_user_id=$external_user_id AND state='active' LIMIT 1;",
      {
        organization_id: installation.organization_id,
        installation_id: installation.installation_id,
        external_user_id: externalUserId,
      },
    );
    if (!binding) throw new Error("확인된 Integration user binding을 찾을 수 없습니다");
    return {
      context: await this.organizations.resolveTenantContext(binding.user_id, installation.organization_id),
      installation: this.installationView(installation),
    };
  }

  public async completeDelivery(
    context: TenantContext,
    input: {
      deliveryRecordId: string;
      workerId: string;
      leaseGeneration: number;
      outcome: "succeeded" | "failed" | "blocked";
      resultHash: string;
    },
  ) {
    if (!HASH.test(input.resultHash)) throw new Error("Integration result hash가 유효하지 않습니다");
    const record = await first<DeliveryRecord>(
      this.database,
      "UPDATE integration_delivery SET state=$outcome, result_hash=$result_hash, lease_owner=NONE, lease_expires_at=NONE, updated_at=time::now() WHERE organization_id=$organization_id AND delivery_record_id=$delivery_record_id AND state='processing' AND lease_owner=$worker_id AND lease_generation=$lease_generation RETURN AFTER;",
      {
        organization_id: context.organizationId,
        delivery_record_id: input.deliveryRecordId,
        worker_id: input.workerId,
        lease_generation: input.leaseGeneration,
        outcome: input.outcome,
        result_hash: input.resultHash,
      },
    );
    if (!record) throw new Error("Integration delivery lease가 일치하지 않습니다");
  }

  public async enqueue(
    context: TenantContext,
    input: {
      commandId: string;
      installationId: string;
      destination: string;
      operation: string;
      idempotencyKey: string;
      payload: unknown;
    },
  ) {
    await this.getInstallation(context, input.installationId);
    const payloadJson = canonical(input.payload);
    if (Buffer.byteLength(payloadJson) > 262_144 || SECRET.test(payloadJson))
      throw new Error("Integration outbox payload가 안전하지 않습니다");
    const requestHash = sha256(canonical({ ...input, payload: JSON.parse(payloadJson) as unknown }));
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const replay = await first<OutboxRecord>(
        tx,
        "SELECT * OMIT id FROM integration_outbox WHERE organization_id=$organization_id AND command_id=$command_id LIMIT 1;",
        { organization_id: context.organizationId, command_id: input.commandId },
      );
      if (replay) {
        if (replay.request_hash !== requestHash)
          throw new Error("같은 commandId에 다른 outbox 요청을 사용할 수 없습니다");
        return this.outboxView(replay);
      }
      const record = await first<OutboxRecord>(
        tx,
        "CREATE integration_outbox CONTENT { outbox_id:$outbox_id, organization_id:$organization_id, installation_id:$installation_id, destination:$destination, operation:$operation, idempotency_key:$idempotency_key, payload_json:$payload_json, payload_hash:$payload_hash, state:'pending', attempt:0, lease_owner:NONE, lease_generation:0, lease_expires_at:NONE, next_attempt_at:time::now(), error_category:NONE, command_id:$command_id, request_hash:$request_hash, created_at:time::now(), updated_at:time::now() } RETURN AFTER;",
        {
          outbox_id: randomUUID(),
          organization_id: context.organizationId,
          installation_id: input.installationId,
          destination: input.destination,
          operation: input.operation,
          idempotency_key: input.idempotencyKey,
          payload_json: payloadJson,
          payload_hash: sha256(payloadJson),
          command_id: input.commandId,
          request_hash: requestHash,
        },
      );
      if (!record) throw new Error("Integration outbox 생성 결과가 없습니다");
      return this.outboxView(record);
    });
  }

  public async claimOutbox(context: TenantContext, input: { workerId: string; now: Date; leaseMs: number }) {
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const candidate = await first<OutboxRecord>(
        tx,
        "SELECT * OMIT id FROM integration_outbox WHERE organization_id=$organization_id AND ((state IN ['pending','retrying'] AND next_attempt_at <= $now) OR (state='processing' AND lease_expires_at <= $now)) ORDER BY next_attempt_at ASC LIMIT 1;",
        { organization_id: context.organizationId, now: input.now },
      );
      if (!candidate) return undefined;
      const record = await first<OutboxRecord>(
        tx,
        "UPDATE integration_outbox SET state='processing', attempt=attempt+1, lease_owner=$worker_id, lease_generation=lease_generation+1, lease_expires_at=$lease_expires_at, updated_at=time::now() WHERE organization_id=$organization_id AND outbox_id=$outbox_id AND lease_generation=$expected_generation RETURN AFTER;",
        {
          organization_id: context.organizationId,
          outbox_id: candidate.outbox_id,
          expected_generation: candidate.lease_generation,
          worker_id: input.workerId,
          lease_expires_at: new Date(input.now.getTime() + input.leaseMs),
        },
      );
      if (!record) throw new Error("Integration outbox lease 충돌입니다");
      return this.outboxView(record);
    });
  }

  public async retryOutbox(
    context: TenantContext,
    input: { outboxId: string; workerId: string; leaseGeneration: number; nextAttemptAt: Date; errorCategory: string },
  ) {
    const record = await first<OutboxRecord>(
      this.database,
      "UPDATE integration_outbox SET state='retrying', lease_owner=NONE, lease_expires_at=NONE, next_attempt_at=$next_attempt_at, error_category=$error_category, updated_at=time::now() WHERE organization_id=$organization_id AND outbox_id=$outbox_id AND state='processing' AND lease_owner=$worker_id AND lease_generation=$lease_generation RETURN AFTER;",
      {
        organization_id: context.organizationId,
        outbox_id: input.outboxId,
        worker_id: input.workerId,
        lease_generation: input.leaseGeneration,
        next_attempt_at: input.nextAttemptAt,
        error_category: input.errorCategory,
      },
    );
    if (!record) throw new Error("Integration outbox lease가 일치하지 않습니다");
  }

  public async completeOutbox(
    context: TenantContext,
    input: {
      outboxId: string;
      workerId: string;
      leaseGeneration: number;
      externalId: string;
      externalUrl?: string;
      responseHash: string;
    },
  ) {
    if (!HASH.test(input.responseHash)) throw new Error("Integration response hash가 유효하지 않습니다");
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const existing = await first<{ receipt_id: string; external_id: string }>(
        tx,
        "SELECT * OMIT id FROM integration_receipt WHERE organization_id=$organization_id AND outbox_id=$outbox_id LIMIT 1;",
        { organization_id: context.organizationId, outbox_id: input.outboxId },
      );
      if (existing) return { receiptId: existing.receipt_id, externalId: existing.external_id, replayed: true };
      const updated = await first<OutboxRecord>(
        tx,
        "UPDATE integration_outbox SET state='succeeded', lease_owner=NONE, lease_expires_at=NONE, error_category=NONE, updated_at=time::now() WHERE organization_id=$organization_id AND outbox_id=$outbox_id AND state='processing' AND lease_owner=$worker_id AND lease_generation=$lease_generation RETURN AFTER;",
        {
          organization_id: context.organizationId,
          outbox_id: input.outboxId,
          worker_id: input.workerId,
          lease_generation: input.leaseGeneration,
        },
      );
      if (!updated) throw new Error("Integration outbox lease가 일치하지 않습니다");
      const receiptId = randomUUID();
      await tx.query(
        `CREATE integration_receipt CONTENT { receipt_id:$receipt_id, organization_id:$organization_id, outbox_id:$outbox_id, external_id:$external_id, external_url:${input.externalUrl === undefined ? "NONE" : "$external_url"}, payload_hash:$payload_hash, created_at:time::now() };`,
        {
          receipt_id: receiptId,
          organization_id: context.organizationId,
          outbox_id: input.outboxId,
          external_id: input.externalId,
          ...(input.externalUrl === undefined ? {} : { external_url: input.externalUrl }),
          payload_hash: input.responseHash,
        },
      );
      return { receiptId, externalId: input.externalId, replayed: false };
    });
  }

  public async blockOutbox(
    context: TenantContext,
    input: { outboxId: string; workerId: string; leaseGeneration: number; errorCategory: string },
  ): Promise<void> {
    const record = await first<OutboxRecord>(
      this.database,
      "UPDATE integration_outbox SET state='blocked', lease_owner=NONE, lease_expires_at=NONE, error_category=$error_category, updated_at=time::now() WHERE organization_id=$organization_id AND outbox_id=$outbox_id AND state='processing' AND lease_owner=$worker_id AND lease_generation=$lease_generation RETURN AFTER;",
      {
        organization_id: context.organizationId,
        outbox_id: input.outboxId,
        worker_id: input.workerId,
        lease_generation: input.leaseGeneration,
        error_category: input.errorCategory,
      },
    );
    if (!record) throw new Error("Integration outbox lease가 일치하지 않습니다");
  }

  private installationView(record: InstallationRecord) {
    return {
      installationId: record.installation_id,
      organizationId: record.organization_id,
      platform: record.platform,
      externalTenantId: record.external_tenant_id,
      credentialRef: record.credential_ref,
      scopes: [...record.scopes],
      state: record.state,
      revision: record.revision,
    };
  }
  private bindingView(record: BindingRecord) {
    return {
      bindingId: record.binding_id,
      installationId: record.installation_id,
      externalUserId: record.external_user_id,
      userId: record.user_id,
      state: record.state,
      revision: record.revision,
    };
  }
  private channelView(record: ChannelBindingRecord) {
    return {
      channelBindingId: record.channel_binding_id,
      installationId: record.installation_id,
      externalResourceId: record.external_resource_id,
      resourceKind: record.resource_kind,
      maximumClassification: record.maximum_classification,
      events: [...record.events],
      state: record.state,
      revision: record.revision,
    };
  }
  private deliveryView(record: DeliveryRecord) {
    return {
      deliveryRecordId: record.delivery_record_id,
      installationId: record.installation_id,
      deliveryId: record.delivery_id,
      eventType: record.event_type,
      state: record.state,
      attempt: record.attempt,
      leaseGeneration: record.lease_generation,
      payload: JSON.parse(record.payload_json ?? "{}") as unknown,
    };
  }
  private outboxView(record: OutboxRecord) {
    return {
      outboxId: record.outbox_id,
      installationId: record.installation_id,
      destination: record.destination,
      operation: record.operation,
      idempotencyKey: record.idempotency_key,
      payload: JSON.parse(record.payload_json) as unknown,
      state: record.state,
      attempt: record.attempt,
      leaseGeneration: record.lease_generation,
    };
  }
}
