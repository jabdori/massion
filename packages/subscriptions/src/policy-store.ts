import { createHash, randomUUID } from "node:crypto";

import { type OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import {
  SUBSCRIPTION_APPROVAL_MODE_MIGRATION,
  SUBSCRIPTION_MIGRATION,
  SUBSCRIPTION_POLICY_MIGRATION,
} from "./schema.js";
import { listSubscriptionProviderManifests, subscriptionProviderApprovalModes } from "./provider-catalog.js";

export const SUBSCRIPTION_CREDENTIAL_POLICIES = [
  "adaptive",
  "priority",
  "fill-first",
  "round-robin",
  "weighted",
  "least-used",
  "quota-headroom",
  "reset-aware",
  "sticky",
] as const;

export type SubscriptionCredentialPolicy = (typeof SUBSCRIPTION_CREDENTIAL_POLICIES)[number];

export const SUBSCRIPTION_APPROVAL_MODES = ["automatic", "review", "deny"] as const;
export type SubscriptionApprovalMode = (typeof SUBSCRIPTION_APPROVAL_MODES)[number];

export interface ConfigureSubscriptionPolicyInput {
  readonly commandId: string;
  readonly providerId: string;
  readonly credentialPolicy: SubscriptionCredentialPolicy;
  readonly approvalMode?: SubscriptionApprovalMode;
  readonly expectedVersion?: number;
}

export interface SubscriptionPolicyView {
  readonly providerId: string;
  readonly credentialPolicy: SubscriptionCredentialPolicy;
  readonly approvalMode: SubscriptionApprovalMode;
  readonly version: number;
  readonly source: "configured" | "default";
  readonly policyVersionId?: string;
  readonly updatedAt?: string;
}

interface PolicyVersionRecord {
  readonly policy_version_id: string;
  readonly organization_id: string;
  readonly provider_id: string;
  readonly credential_policy: SubscriptionCredentialPolicy;
  readonly approval_mode: SubscriptionApprovalMode;
  readonly version: number;
  readonly command_id: string;
  readonly actor_user_id: string;
  readonly request_hash: string;
  readonly created_at: unknown;
}

interface ActivePolicyRecord {
  readonly organization_id: string;
  readonly provider_id: string;
  readonly policy_version_id: string;
  readonly credential_policy: SubscriptionCredentialPolicy;
  readonly approval_mode: SubscriptionApprovalMode;
  readonly version: number;
  readonly updated_at: unknown;
}

const POLICY_SET = new Set<string>(SUBSCRIPTION_CREDENTIAL_POLICIES);
const APPROVAL_MODE_SET = new Set<string>(SUBSCRIPTION_APPROVAL_MODES);

function providerManifest(providerId: string) {
  return listSubscriptionProviderManifests().find((manifest) => manifest.id === providerId);
}

function providerDefaultApprovalMode(normalizedProviderId: string): SubscriptionApprovalMode {
  const manifest = providerManifest(normalizedProviderId);
  if (manifest?.connectionSurface === "unavailable") return "deny";
  const declared = manifest ? subscriptionProviderApprovalModes(manifest) : undefined;
  if (!declared) return "review";
  if (declared.includes("review")) return "review";
  if (declared.includes("deny")) return "deny";
  return declared[0] ?? "deny";
}

function assertProviderApprovalMode(normalizedProviderId: string, approvalMode: SubscriptionApprovalMode): void {
  const manifest = providerManifest(normalizedProviderId);
  if (manifest?.connectionSurface === "unavailable") {
    throw new Error("공개 연결 표면이 없는 Provider에는 구독 실행 정책이 허용되지 않습니다");
  }
  const declared = manifest ? subscriptionProviderApprovalModes(manifest) : undefined;
  if (declared && !declared.includes(approvalMode)) {
    throw new Error(`이 Provider에서 허용되지 않는 구독 승인 방식입니다: ${approvalMode}`);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function text(value: string, label: string, maximum = 128): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${label}이 유효하지 않습니다`);
  return normalized;
}

function providerId(value: string): string {
  const normalized = text(value, "Provider ID");
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(normalized)) throw new Error("Provider ID 형식이 유효하지 않습니다");
  return normalized;
}

function iso(value: unknown): string {
  const serialized = value instanceof Date ? value.toISOString() : String(value);
  const parsed = new Date(serialized);
  if (!Number.isFinite(parsed.getTime())) throw new Error("구독 정책 시각이 유효하지 않습니다");
  return parsed.toISOString();
}

function view(record: PolicyVersionRecord | ActivePolicyRecord): SubscriptionPolicyView {
  const policyVersionId = record.policy_version_id;
  const updatedAt = "created_at" in record ? record.created_at : record.updated_at;
  return {
    providerId: record.provider_id,
    credentialPolicy: record.credential_policy,
    approvalMode: record.approval_mode,
    version: record.version,
    source: "configured",
    policyVersionId,
    updatedAt: iso(updatedAt),
  };
}

export class SubscriptionPolicyStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
  ): Promise<SubscriptionPolicyStore> {
    await applyMigrations(database, [
      SUBSCRIPTION_MIGRATION,
      SUBSCRIPTION_POLICY_MIGRATION,
      SUBSCRIPTION_APPROVAL_MODE_MIGRATION,
    ]);
    return new SubscriptionPolicyStore(database, organizations);
  }

  public async configure(
    context: TenantContext,
    input: ConfigureSubscriptionPolicyInput,
  ): Promise<SubscriptionPolicyView> {
    const commandId = text(input.commandId, "Command ID");
    const normalizedProviderId = providerId(input.providerId);
    if (!POLICY_SET.has(input.credentialPolicy)) throw new Error("지원하지 않는 구독 계정 선택 정책입니다");
    if (input.approvalMode !== undefined && !APPROVAL_MODE_SET.has(input.approvalMode)) {
      throw new Error("지원하지 않는 구독 승인 방식입니다");
    }
    if (
      input.expectedVersion !== undefined &&
      (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0)
    ) {
      throw new Error("구독 정책 expected version이 유효하지 않습니다");
    }
    await this.organizations.verifyTenantContext(context, ["owner", "admin"]);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, ["owner", "admin"], tx);
      const [existing] = await tx.query<[PolicyVersionRecord[]]>(
        `SELECT * OMIT id FROM subscription_routing_policy_version
         WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;`,
        { organization_id: context.organizationId, command_id: commandId },
      );
      if (existing[0]) {
        const replayApprovalMode = input.approvalMode ?? existing[0].approval_mode;
        assertProviderApprovalMode(normalizedProviderId, replayApprovalMode);
        const requestHash = this.requestHash(input, normalizedProviderId, replayApprovalMode);
        if (existing[0].actor_user_id !== context.userId) {
          throw new Error("같은 Command ID를 다른 사용자가 재사용할 수 없습니다");
        }
        if (existing[0].request_hash !== requestHash) {
          throw new Error("같은 Command ID에 다른 구독 정책 요청을 사용할 수 없습니다");
        }
        return view(existing[0]);
      }

      const [activeRows] = await tx.query<[ActivePolicyRecord[]]>(
        `SELECT * OMIT id FROM subscription_routing_policy_active
         WHERE organization_id = $organization_id AND provider_id = $provider_id LIMIT 1;`,
        { organization_id: context.organizationId, provider_id: normalizedProviderId },
      );
      const active = activeRows[0];
      const approvalMode =
        input.approvalMode ?? active?.approval_mode ?? providerDefaultApprovalMode(normalizedProviderId);
      assertProviderApprovalMode(normalizedProviderId, approvalMode);
      const requestHash = this.requestHash(input, normalizedProviderId, approvalMode);
      const currentVersion = active?.version ?? 0;
      if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
        throw new Error("구독 정책 version이 일치하지 않습니다");
      }
      const nextVersion = currentVersion + 1;
      const policyVersionId = randomUUID();
      const updatedAt = new Date();
      const [created] = await tx.query<[PolicyVersionRecord[]]>(
        `CREATE subscription_routing_policy_version CONTENT {
           policy_version_id: $policy_version_id, organization_id: $organization_id,
           provider_id: $provider_id, credential_policy: $credential_policy,
           approval_mode: $approval_mode, version: $version,
           command_id: $command_id, actor_user_id: $actor_user_id,
           request_hash: $request_hash, created_at: $updated_at
         } RETURN AFTER;`,
        {
          policy_version_id: policyVersionId,
          organization_id: context.organizationId,
          provider_id: normalizedProviderId,
          credential_policy: input.credentialPolicy,
          approval_mode: approvalMode,
          version: nextVersion,
          command_id: commandId,
          actor_user_id: context.userId,
          request_hash: requestHash,
          updated_at: updatedAt,
        },
      );
      if (!created[0]) throw new Error("구독 정책 version을 생성하지 못했습니다");
      const bindings = {
        organization_id: context.organizationId,
        provider_id: normalizedProviderId,
        policy_version_id: policyVersionId,
        credential_policy: input.credentialPolicy,
        approval_mode: approvalMode,
        version: nextVersion,
        updated_at: updatedAt,
      };
      if (active) {
        await tx.query(
          `UPDATE subscription_routing_policy_active
           SET policy_version_id = $policy_version_id, credential_policy = $credential_policy,
               approval_mode = $approval_mode,
               version = $version, updated_at = $updated_at
           WHERE organization_id = $organization_id AND provider_id = $provider_id AND version = $current_version;`,
          { ...bindings, current_version: currentVersion },
        );
      } else {
        await tx.query(
          `CREATE subscription_routing_policy_active CONTENT {
             organization_id: $organization_id, provider_id: $provider_id,
             policy_version_id: $policy_version_id, credential_policy: $credential_policy,
             approval_mode: $approval_mode,
             version: $version, updated_at: $updated_at
           };`,
          bindings,
        );
      }
      const current = await this.active(tx, context.organizationId, normalizedProviderId);
      if (!current || current.version !== nextVersion || current.policy_version_id !== policyVersionId) {
        throw new Error("구독 정책 현재 포인터 갱신이 충돌했습니다");
      }
      return view(created[0]);
    });
  }

  public async list(context: TenantContext, requestedProviderId?: string): Promise<readonly SubscriptionPolicyView[]> {
    await this.organizations.verifyTenantContext(context);
    const normalizedProviderId = requestedProviderId === undefined ? undefined : providerId(requestedProviderId);
    const [rows] = await this.database.query<[ActivePolicyRecord[]]>(
      `SELECT * OMIT id FROM subscription_routing_policy_active
       WHERE organization_id = $organization_id${normalizedProviderId === undefined ? "" : " AND provider_id = $provider_id"}
       ORDER BY provider_id ASC;`,
      { organization_id: context.organizationId, provider_id: normalizedProviderId },
    );
    return rows.map(view);
  }

  public async resolve(
    context: TenantContext,
    requestedProviderId: string,
    executor: QueryExecutor = this.database,
  ): Promise<SubscriptionPolicyView> {
    const normalizedProviderId = providerId(requestedProviderId);
    await this.organizations.verifyTenantContext(context, undefined, executor);
    const active = await this.active(executor, context.organizationId, normalizedProviderId);
    return active
      ? view(active)
      : {
          providerId: normalizedProviderId,
          credentialPolicy: "adaptive",
          approvalMode: providerDefaultApprovalMode(normalizedProviderId),
          version: 0,
          source: "default",
        };
  }

  private async active(
    executor: QueryExecutor,
    organizationId: string,
    normalizedProviderId: string,
  ): Promise<ActivePolicyRecord | undefined> {
    const [rows] = await executor.query<[ActivePolicyRecord[]]>(
      `SELECT * OMIT id FROM subscription_routing_policy_active
       WHERE organization_id = $organization_id AND provider_id = $provider_id LIMIT 1;`,
      { organization_id: organizationId, provider_id: normalizedProviderId },
    );
    return rows[0];
  }

  private requestHash(
    input: ConfigureSubscriptionPolicyInput,
    normalizedProviderId: string,
    approvalMode: SubscriptionApprovalMode,
  ): string {
    return sha256(
      canonicalJson({
        providerId: normalizedProviderId,
        credentialPolicy: input.credentialPolicy,
        approvalMode,
        expectedVersion: input.expectedVersion,
      }),
    );
  }
}
