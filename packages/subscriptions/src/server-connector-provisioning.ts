import { createHash, randomUUID } from "node:crypto";

import { type OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { listCodingPlanPresets } from "./coding-plan.js";
import type { ConnectorExecutionKind, ConnectorStatus, SubscriptionConnector } from "./contracts.js";
import { listSubscriptionProviderManifests } from "./provider-catalog.js";
import { SUBSCRIPTION_MIGRATION, SUBSCRIPTION_SERVER_CONNECTOR_MIGRATION } from "./schema.js";

interface ServerConnectorRecord extends SubscriptionConnector {
  readonly trust_origin: "server-managed";
  readonly provider_id: string;
  readonly runtime_id: string;
  readonly runtime_artifact_digest: string;
  readonly process_generation?: number;
  readonly last_health_at?: unknown;
}

interface SubscriptionAuditEvent {
  readonly actor_user_id: string;
  readonly event_type: string;
  readonly request_hash: string;
  readonly result_json: string;
}

export interface ProvisionServerConnectorInput {
  readonly commandId: string;
  readonly connectorId: string;
  readonly providerId: string;
  readonly executionKind: ConnectorExecutionKind;
  readonly runtimeId: string;
}

export interface AttestServerConnectorHealthInput {
  readonly commandId: string;
  readonly connectorId: string;
}

export interface ServerConnectorCommandInput {
  readonly commandId: string;
  readonly connectorId: string;
}

export interface ServerConnectorView {
  readonly connectorId: string;
  readonly providerId: string;
  readonly executionKind: ConnectorExecutionKind;
  readonly runtimeId: string;
  readonly runtimeArtifactDigest: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly status: ConnectorStatus;
  readonly trustOrigin: "server-managed";
  readonly processGeneration?: number;
  readonly lastHealthAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ServerConnectorProvisioningOptions {
  readonly runtimeAttestor: ServerConnectorRuntimeAttestor;
  readonly now?: () => Date;
}

export interface VerifiedServerRuntimeArtifact {
  readonly runtimeId: string;
  readonly runtimeArtifactDigest: string;
  readonly version: string;
}

export interface VerifiedServerConnectorHealth {
  readonly runtimeId: string;
  readonly runtimeArtifactDigest: string;
  readonly processGeneration: number;
  readonly processState: "same-process" | "new-process";
}

export interface ServerConnectorRuntimeAttestor {
  inspectArtifact(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly providerId: string;
    readonly executionKind: ConnectorExecutionKind;
    readonly runtimeId: string;
  }): Promise<VerifiedServerRuntimeArtifact>;
  attestHealth(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly connectorId: string;
    readonly providerId: string;
    readonly executionKind: ConnectorExecutionKind;
    readonly runtimeId: string;
    readonly runtimeArtifactDigest: string;
    readonly version: string;
    readonly previousProcessGeneration?: number;
  }): Promise<VerifiedServerConnectorHealth>;
}

function canonicalJson(value: unknown): string {
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

function requireText(value: string, label: string, maximum = 128): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}은(는) 비어 있을 수 없습니다`);
  if (normalized.length > maximum) throw new Error(`${label}은(는) ${String(maximum)}자를 초과할 수 없습니다`);
  return normalized;
}

function requireIdentifier(value: string, label: string): string {
  const normalized = requireText(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(normalized)) {
    throw new Error(`${label} 형식이 유효하지 않습니다`);
  }
  return normalized;
}

function requireDigest(value: string): string {
  const normalized = requireText(value, "Runtime artifact digest").toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error("Runtime artifact digest는 SHA-256이어야 합니다");
  return normalized;
}

function requireVersion(value: string): string {
  const normalized = requireText(value, "Connector version");
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/u.test(normalized)) {
    throw new Error("Connector version 형식이 유효하지 않습니다");
  }
  return normalized;
}

const AGENT_RUNTIME_IDS = {
  "openai-codex": "codex",
  "anthropic-claude-code": "claude",
  "google-gemini-cli-enterprise": "gemini-acp",
  "google-antigravity-cli": "antigravity",
  "github-copilot": "copilot-acp",
  "xai-grok-build": "grok-acp",
} as const satisfies Readonly<Record<string, string>>;

function providerRuntimeContract(providerId: string): {
  readonly executionKind: ConnectorExecutionKind;
  readonly runtimeIds: ReadonlySet<string>;
} {
  const manifest = listSubscriptionProviderManifests().find((candidate) => candidate.id === providerId);
  const preset = listCodingPlanPresets().find((candidate) => candidate.id === providerId);
  if (!manifest && !preset) throw new Error(`구독 Provider catalog를 찾을 수 없습니다: ${providerId}`);
  const executionKinds = new Set<ConnectorExecutionKind>([
    ...(manifest ? [manifest.executionKind] : []),
    ...(preset ? (["model"] as const) : []),
  ]);
  if (executionKinds.size !== 1) throw new Error("구독 Provider catalog의 실행 종류가 충돌합니다");
  const executionKind = [...executionKinds][0];
  if (!executionKind) throw new Error("구독 Provider 실행 종류를 찾을 수 없습니다");
  if (executionKind === "agent-runtime") {
    const runtimeId = (AGENT_RUNTIME_IDS as Partial<Record<string, string>>)[providerId];
    if (!runtimeId) throw new Error("구독 Provider의 서버 runtime ID가 등록되지 않았습니다");
    return { executionKind, runtimeIds: new Set([runtimeId]) };
  }
  const protocols = new Set([
    ...(manifest ? [manifest.protocol] : []),
    ...(preset?.routes.map((route) => route.protocol) ?? []),
  ]);
  return { executionKind, runtimeIds: new Set([...protocols].map((protocol) => `${protocol}-model`)) };
}

function iso(value: unknown, label: string): string {
  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label}이(가) 유효하지 않습니다`);
  return parsed.toISOString();
}

export class ServerConnectorProvisioningService {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly runtimeAttestor: ServerConnectorRuntimeAttestor,
    private readonly now: () => Date,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    options: ServerConnectorProvisioningOptions,
  ): Promise<ServerConnectorProvisioningService> {
    const runtimeAttestor = (options as Partial<ServerConnectorProvisioningOptions>).runtimeAttestor;
    if (
      !runtimeAttestor ||
      typeof runtimeAttestor.inspectArtifact !== "function" ||
      typeof runtimeAttestor.attestHealth !== "function"
    ) {
      throw new Error("서버 Runtime attestor가 필요합니다");
    }
    await applyMigrations(database, [SUBSCRIPTION_MIGRATION, SUBSCRIPTION_SERVER_CONNECTOR_MIGRATION]);
    return new ServerConnectorProvisioningService(
      database,
      organizations,
      runtimeAttestor,
      options.now ?? (() => new Date()),
    );
  }

  public async provision(context: TenantContext, input: ProvisionServerConnectorInput): Promise<ServerConnectorView> {
    const commandId = requireText(input.commandId, "Command ID");
    const connectorId = requireIdentifier(input.connectorId, "Connector ID");
    const providerId = requireIdentifier(input.providerId, "Provider ID");
    const runtimeContract = providerRuntimeContract(providerId);
    if (input.executionKind !== runtimeContract.executionKind) {
      throw new Error("구독 Provider와 Connector 실행 종류가 일치하지 않습니다");
    }
    const runtimeId = requireIdentifier(input.runtimeId, "Runtime ID");
    if (!runtimeContract.runtimeIds.has(runtimeId)) {
      throw new Error("구독 Provider와 서버 runtime ID가 일치하지 않습니다");
    }
    const request = {
      operation: "provision",
      connectorId,
      providerId,
      executionKind: runtimeContract.executionKind,
      runtimeId,
    };

    return await this.command(context, commandId, "subscription_server_connector_provisioned", request, async (tx) => {
      let inspected: VerifiedServerRuntimeArtifact;
      try {
        inspected = await this.runtimeAttestor.inspectArtifact({
          organizationId: context.organizationId,
          actorUserId: context.userId,
          providerId,
          executionKind: runtimeContract.executionKind,
          runtimeId,
        });
      } catch {
        throw new Error("서버 Runtime artifact 검증에 실패했습니다");
      }
      const verifiedRuntimeId = requireIdentifier(inspected.runtimeId, "검증된 Runtime ID");
      if (verifiedRuntimeId !== runtimeId || !runtimeContract.runtimeIds.has(verifiedRuntimeId)) {
        throw new Error("검증된 서버 Runtime ID가 Provider 계약과 일치하지 않습니다");
      }
      const runtimeArtifactDigest = requireDigest(inspected.runtimeArtifactDigest);
      const version = requireVersion(inspected.version);
      const now = this.now();
      await tx.query(
        `CREATE subscription_connector CONTENT {
          connector_id: $connector_id,
          organization_id: $organization_id,
          owner_user_id: $owner_user_id,
          location: 'server',
          trust_origin: 'server-managed',
          provider_id: $provider_id,
          execution_kind: $execution_kind,
          protocol: 'massion.connector.v1',
          version: $version,
          runtime_id: $runtime_id,
          runtime_artifact_digest: $runtime_artifact_digest,
          capabilities: [$provider_id],
          status: 'offline',
          created_at: $now,
          updated_at: $now
        };`,
        {
          connector_id: connectorId,
          organization_id: context.organizationId,
          owner_user_id: context.userId,
          provider_id: providerId,
          execution_kind: runtimeContract.executionKind,
          version,
          runtime_id: runtimeId,
          runtime_artifact_digest: runtimeArtifactDigest,
          now,
        },
      );
      return await this.requireView(tx, context, connectorId);
    });
  }

  public async attestHealth(
    context: TenantContext,
    input: AttestServerConnectorHealthInput,
  ): Promise<ServerConnectorView> {
    const commandId = requireText(input.commandId, "Command ID");
    const connectorId = requireIdentifier(input.connectorId, "Connector ID");
    const request = {
      operation: "attest-health",
      connectorId,
    };

    return await this.command(
      context,
      commandId,
      "subscription_server_connector_health_attested",
      request,
      async (tx) => {
        const connector = await this.requireOwnedServerConnector(tx, context, connectorId);
        if (connector.status === "revoked") throw new Error("폐기된 서버 Connector는 건강 증명할 수 없습니다");
        if (connector.status === "incompatible") throw new Error("호환되지 않는 서버 Connector입니다");
        let attested: VerifiedServerConnectorHealth;
        try {
          attested = await this.runtimeAttestor.attestHealth({
            organizationId: context.organizationId,
            actorUserId: context.userId,
            connectorId,
            providerId: connector.provider_id,
            executionKind: connector.execution_kind,
            runtimeId: connector.runtime_id,
            runtimeArtifactDigest: connector.runtime_artifact_digest,
            version: connector.version,
            ...(connector.process_generation === undefined
              ? {}
              : { previousProcessGeneration: connector.process_generation }),
          });
        } catch {
          throw new Error("서버 Runtime 건강 증명에 실패했습니다");
        }
        const attestedRuntimeId = requireIdentifier(attested.runtimeId, "검증된 Runtime ID");
        const attestedArtifactDigest = requireDigest(attested.runtimeArtifactDigest);
        if (connector.runtime_id !== attestedRuntimeId)
          throw new Error("서버 Connector Runtime ID가 일치하지 않습니다");
        if (connector.runtime_artifact_digest !== attestedArtifactDigest) {
          throw new Error("서버 Connector runtime artifact digest가 일치하지 않습니다");
        }
        if (!Number.isSafeInteger(attested.processGeneration) || attested.processGeneration < 1) {
          throw new Error("Process generation은 1 이상의 안전한 정수여야 합니다");
        }
        const previousProcessGeneration = connector.process_generation;
        const processState: unknown = attested.processState;
        if (processState === "same-process") {
          if (
            connector.status !== "ready" ||
            previousProcessGeneration === undefined ||
            attested.processGeneration !== previousProcessGeneration
          ) {
            throw new Error("동일 Process 건강 증명의 generation이 일치하지 않습니다");
          }
        } else if (processState === "new-process") {
          if (attested.processGeneration !== (previousProcessGeneration ?? 0) + 1) {
            throw new Error("새 Process generation은 이전 값보다 정확히 1 증가해야 합니다");
          }
        } else {
          throw new Error("Process 상태 증명이 유효하지 않습니다");
        }
        const now = this.now();
        const generationPredicate =
          previousProcessGeneration === undefined
            ? "process_generation = NONE"
            : "process_generation = $previous_process_generation";
        const [updated] = await tx.query<[ServerConnectorRecord[]]>(
          `UPDATE subscription_connector
         SET process_generation = $process_generation, last_health_at = $now,
             status = 'ready', updated_at = $now
         WHERE organization_id = $organization_id AND connector_id = $connector_id
           AND trust_origin = 'server-managed' AND status != 'revoked'
           AND ${generationPredicate}
         RETURN AFTER;`,
          {
            organization_id: context.organizationId,
            connector_id: connectorId,
            process_generation: attested.processGeneration,
            ...(previousProcessGeneration === undefined
              ? {}
              : { previous_process_generation: previousProcessGeneration }),
            now,
          },
        );
        if (!updated[0]) throw new Error("Process generation 갱신이 충돌했습니다");
        await tx.query(
          `UPDATE subscription_account SET status = 'active', version += 1, updated_at = $now
           WHERE organization_id = $organization_id AND connector_id = $connector_id
             AND (status = 'offline' OR ($authentication_verified AND status = 'needs-reauth'));`,
          {
            organization_id: context.organizationId,
            connector_id: connectorId,
            authentication_verified: connector.execution_kind === "agent-runtime",
            now,
          },
        );
        return this.toView(updated[0]);
      },
    );
  }

  public async markOffline(context: TenantContext, input: ServerConnectorCommandInput): Promise<ServerConnectorView> {
    return await this.changeStatus(context, input, "offline", "subscription_server_connector_offline");
  }

  public async revoke(context: TenantContext, input: ServerConnectorCommandInput): Promise<ServerConnectorView> {
    return await this.changeStatus(context, input, "revoked", "subscription_server_connector_revoked");
  }

  public async get(context: TenantContext, connectorId: string): Promise<ServerConnectorView> {
    await this.organizations.verifyTenantContext(context);
    return await this.requireView(this.database, context, requireIdentifier(connectorId, "Connector ID"));
  }

  public async list(context: TenantContext): Promise<readonly ServerConnectorView[]> {
    await this.organizations.verifyTenantContext(context);
    const [connectors] = await this.database.query<[ServerConnectorRecord[]]>(
      `SELECT * OMIT id FROM subscription_connector
       WHERE organization_id = $organization_id AND trust_origin = 'server-managed'
       ORDER BY created_at ASC, connector_id ASC;`,
      { organization_id: context.organizationId },
    );
    return connectors.map((connector) => this.toView(connector));
  }

  private async changeStatus(
    context: TenantContext,
    input: ServerConnectorCommandInput,
    status: "offline" | "revoked",
    eventType: string,
  ): Promise<ServerConnectorView> {
    const commandId = requireText(input.commandId, "Command ID");
    const connectorId = requireIdentifier(input.connectorId, "Connector ID");
    const request = { operation: status === "offline" ? "mark-offline" : "revoke", connectorId };
    return await this.command(context, commandId, eventType, request, async (tx) => {
      const connector = await this.requireOwnedServerConnector(tx, context, connectorId);
      if (connector.status === "revoked") throw new Error("이미 폐기된 서버 Connector입니다");
      const now = this.now();
      const [updated] = await tx.query<[ServerConnectorRecord[]]>(
        `UPDATE subscription_connector SET status = $status, updated_at = $now
         WHERE organization_id = $organization_id AND connector_id = $connector_id
           AND trust_origin = 'server-managed' AND status != 'revoked'
         RETURN AFTER;`,
        {
          organization_id: context.organizationId,
          connector_id: connectorId,
          status,
          now,
        },
      );
      if (!updated[0]) throw new Error("서버 Connector 상태 갱신이 충돌했습니다");
      await tx.query(
        `UPDATE subscription_account SET status = 'offline', version += 1, updated_at = $now
         WHERE organization_id = $organization_id AND connector_id = $connector_id AND status = 'active';`,
        { organization_id: context.organizationId, connector_id: connectorId, now },
      );
      return this.toView(updated[0]);
    });
  }

  private async command(
    context: TenantContext,
    commandId: string,
    eventType: string,
    request: unknown,
    operation: (executor: QueryExecutor) => Promise<ServerConnectorView>,
  ): Promise<ServerConnectorView> {
    const requestHash = sha256(canonicalJson(request));
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const [events] = await tx.query<[SubscriptionAuditEvent[]]>(
        `SELECT actor_user_id, event_type, request_hash, result_json FROM subscription_audit_event
         WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;`,
        { organization_id: context.organizationId, command_id: commandId },
      );
      const existing = events[0];
      if (existing) {
        if (existing.actor_user_id !== context.userId) {
          throw new Error("같은 Command ID를 다른 사용자가 재사용할 수 없습니다");
        }
        if (existing.event_type !== eventType || existing.request_hash !== requestHash) {
          throw new Error("같은 Command ID에 다른 요청을 사용할 수 없습니다");
        }
        return JSON.parse(existing.result_json) as ServerConnectorView;
      }

      const result = await operation(tx);
      const safeResult = JSON.parse(JSON.stringify(result)) as ServerConnectorView;
      await tx.query(
        `CREATE subscription_audit_event CONTENT {
          event_id: $event_id,
          organization_id: $organization_id,
          actor_user_id: $actor_user_id,
          command_id: $command_id,
          event_type: $event_type,
          resource_id: $resource_id,
          request_hash: $request_hash,
          result_json: $result_json,
          created_at: $created_at
        };`,
        {
          event_id: randomUUID(),
          organization_id: context.organizationId,
          actor_user_id: context.userId,
          command_id: commandId,
          event_type: eventType,
          resource_id: result.connectorId,
          request_hash: requestHash,
          result_json: JSON.stringify(safeResult),
          created_at: this.now(),
        },
      );
      return safeResult;
    });
  }

  private async requireView(
    executor: QueryExecutor,
    context: TenantContext,
    connectorId: string,
  ): Promise<ServerConnectorView> {
    const connector = await this.requireServerConnector(executor, context.organizationId, connectorId);
    return this.toView(connector);
  }

  private async requireOwnedServerConnector(
    executor: QueryExecutor,
    context: TenantContext,
    connectorId: string,
  ): Promise<ServerConnectorRecord> {
    const connector = await this.requireServerConnector(executor, context.organizationId, connectorId);
    if (context.role === "member" && connector.owner_user_id !== context.userId) {
      throw new Error("서버 Connector 소유자 또는 조직 관리자만 이 작업을 수행할 수 있습니다");
    }
    return connector;
  }

  private async requireServerConnector(
    executor: QueryExecutor,
    organizationId: string,
    connectorId: string,
  ): Promise<ServerConnectorRecord> {
    const [connectors] = await executor.query<[ServerConnectorRecord[]]>(
      `SELECT * OMIT id FROM subscription_connector
       WHERE organization_id = $organization_id AND connector_id = $connector_id
         AND trust_origin = 'server-managed' LIMIT 1;`,
      { organization_id: organizationId, connector_id: connectorId },
    );
    const connector = connectors[0];
    if (!connector) throw new Error(`서버 Connector를 찾을 수 없습니다: ${connectorId}`);
    if (
      connector.location !== "server" ||
      !connector.provider_id ||
      !connector.runtime_id ||
      !connector.runtime_artifact_digest ||
      connector.capabilities.length !== 1 ||
      connector.capabilities[0] !== connector.provider_id
    ) {
      throw new Error("서버 Connector 계보가 불완전합니다");
    }
    return connector;
  }

  private toView(connector: ServerConnectorRecord): ServerConnectorView {
    return {
      connectorId: connector.connector_id,
      providerId: connector.provider_id,
      executionKind: connector.execution_kind,
      runtimeId: connector.runtime_id,
      runtimeArtifactDigest: connector.runtime_artifact_digest,
      version: connector.version,
      capabilities: [...connector.capabilities],
      status: connector.status,
      trustOrigin: "server-managed",
      ...(connector.process_generation === undefined ? {} : { processGeneration: connector.process_generation }),
      ...(connector.last_health_at === undefined
        ? {}
        : { lastHealthAt: iso(connector.last_health_at, "마지막 건강 증명 시각") }),
      createdAt: iso(connector.created_at, "Connector 생성 시각"),
      updatedAt: iso(connector.updated_at, "Connector 갱신 시각"),
    };
  }
}
