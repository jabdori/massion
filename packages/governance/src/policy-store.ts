import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { validatePolicyBundle } from "./cedar-authorizer.js";
import type { ApprovalRequirement, PolicyBundle } from "./contracts.js";
import { createDefaultPolicy } from "./defaults.js";
import { GOVERNANCE_POLICY_MIGRATION } from "./schema.js";

export interface PolicyVersion {
  readonly policy_version_id: string;
  readonly organization_id: string;
  readonly version: number;
  readonly status: "draft" | "active" | "superseded";
  readonly schema_json: string;
  readonly policies_json: string;
  readonly requirements_json: string;
  readonly checksum: string;
  readonly created_at: unknown;
  readonly activated_at?: unknown;
  readonly superseded_at?: unknown;
}

export interface CreatePolicyDraftInput {
  readonly commandId: string;
  readonly bundle: PolicyBundle;
  readonly requirements: readonly ApprovalRequirement[];
}

export interface ActivatePolicyInput {
  readonly commandId: string;
  readonly policyVersionId: string;
  readonly expectedActivePolicyVersionId?: string;
  readonly governanceApprovalId?: string;
  readonly governanceEnvironment?: string;
}

export interface PolicyActivationGate {
  authorize(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly action: string;
      readonly resource: { readonly type: string; readonly id: string; readonly revision: number };
      readonly environment: string;
      readonly riskClass: string;
      readonly external: boolean;
      readonly executionId: string;
      readonly approvalId?: string;
    },
    executor?: QueryExecutor,
  ): Promise<unknown>;
}

export interface ActivePolicy {
  readonly version: PolicyVersion;
  readonly bundle: PolicyBundle;
  readonly requirements: readonly ApprovalRequirement[];
}

interface PolicyEvent {
  readonly policy_version_id: string;
  readonly command_id: string;
  readonly request_json: string;
  readonly result_json: string;
}

type ManagedDefaultKind = "personal" | "team";

const RELEASED_MANAGED_DEFAULT_CHECKSUMS: Readonly<Record<ManagedDefaultKind, string>> = {
  personal: "637c72da0469ebd33b81bcc4c0474adcb7790e78b1bdfd1debf89d6faf6be423",
  team: "fe2b5aa02cf0760b9f6fb26180e541b8f80045b5c73e35e94817e0743ce76c18",
};

export interface ManagedDefaultReconciliation {
  readonly organizationId: string;
  readonly kind: ManagedDefaultKind;
  readonly action: "upgraded";
  readonly previousPolicyVersionId: string;
  readonly policyVersionId: string;
  readonly version: number;
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

function legacyDefaultPolicy(kind: ManagedDefaultKind): {
  readonly bundle: PolicyBundle;
  readonly requirements: readonly ApprovalRequirement[];
} {
  const current = structuredClone(createDefaultPolicy(kind));
  const namespace = (current.bundle.schema as { Massion: Record<string, Record<string, unknown>> }).Massion;
  delete namespace.actions?.["model.optimization.approve"];
  delete namespace.entityTypes?.OptimizationRecommendation;
  for (const action of Object.values(namespace.actions ?? {})) {
    const appliesTo = (action as { appliesTo?: { resourceTypes?: string[] } }).appliesTo;
    if (appliesTo?.resourceTypes) {
      appliesTo.resourceTypes = appliesTo.resourceTypes.filter((type) => type !== "OptimizationRecommendation");
    }
  }
  return {
    bundle: current.bundle,
    requirements: current.requirements.map((requirement) => ({
      ...requirement,
      actions: requirement.actions.filter((action) => action !== "model.optimization.approve"),
    })),
  };
}

function policyMaterial(input: {
  readonly bundle: PolicyBundle;
  readonly requirements: readonly ApprovalRequirement[];
}): Pick<PolicyVersion, "schema_json" | "policies_json" | "requirements_json" | "checksum"> {
  return {
    schema_json: canonicalJson(input.bundle.schema),
    policies_json: canonicalJson(input.bundle.policies),
    requirements_json: canonicalJson(input.requirements),
    checksum: createHash("sha256").update(canonicalJson(input)).digest("hex"),
  };
}

function exactPolicyMaterial(
  version: PolicyVersion,
  material: Pick<PolicyVersion, "schema_json" | "policies_json" | "requirements_json" | "checksum">,
): boolean {
  return (
    version.schema_json === material.schema_json &&
    version.policies_json === material.policies_json &&
    version.requirements_json === material.requirements_json &&
    version.checksum === material.checksum
  );
}

function assertPolicyIntegrity(version: PolicyVersion): void {
  let checksum: string;
  try {
    checksum = createHash("sha256")
      .update(
        canonicalJson({
          bundle: {
            schema: JSON.parse(version.schema_json) as unknown,
            policies: JSON.parse(version.policies_json) as unknown,
          },
          requirements: JSON.parse(version.requirements_json) as unknown,
        }),
      )
      .digest("hex");
  } catch {
    throw new Error(`Policy Version checksum 입력을 해석할 수 없습니다: ${version.policy_version_id}`);
  }
  if (checksum !== version.checksum) {
    throw new Error(`Policy Version checksum이 일치하지 않습니다: ${version.policy_version_id}`);
  }
}

export class PolicyStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly activationGate?: PolicyActivationGate,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    activationGate?: PolicyActivationGate,
  ): Promise<PolicyStore> {
    await applyMigrations(database, [GOVERNANCE_POLICY_MIGRATION]);
    return new PolicyStore(database, organizations, activationGate);
  }

  /** 제품 시작 시 과거 exact default만 현재 managed default로 올리는 내부 reconciliation 경계입니다. */
  public async reconcileManagedDefaultsAtStartup(): Promise<readonly ManagedDefaultReconciliation[]> {
    const [organizations] = await this.database.query<
      [Array<{ readonly organization_id: string; readonly kind: string }>]
    >(
      "SELECT organization_id, kind FROM organization WHERE kind IN ['personal', 'team'] ORDER BY organization_id ASC;",
    );
    const reconciled: ManagedDefaultReconciliation[] = [];
    for (const organization of organizations) {
      if (organization.kind !== "personal" && organization.kind !== "team") continue;
      const changed = await this.reconcileManagedDefault(organization.organization_id, organization.kind);
      if (changed) reconciled.push(changed);
    }
    return reconciled;
  }

  private async reconcileManagedDefault(
    organizationId: string,
    kind: ManagedDefaultKind,
  ): Promise<ManagedDefaultReconciliation | undefined> {
    const currentDefault = createDefaultPolicy(kind);
    const currentMaterial = policyMaterial(currentDefault);
    const legacyMaterial = policyMaterial(legacyDefaultPolicy(kind));
    return await this.database.transaction(async (tx) => {
      const active = await this.active(tx, organizationId);
      if (!active || exactPolicyMaterial(active, currentMaterial)) return undefined;
      if (legacyMaterial.checksum !== RELEASED_MANAGED_DEFAULT_CHECKSUMS[kind]) return undefined;
      if (!exactPolicyMaterial(active, legacyMaterial)) return undefined;
      const [versions] = await tx.query<[Array<{ readonly version: number }>]>(
        "SELECT version FROM governance_policy_version WHERE organization_id = $organization_id;",
        { organization_id: organizationId },
      );
      const version = versions.reduce((maximum, item) => Math.max(maximum, item.version), 0) + 1;
      const lineageHash = createHash("sha256").update(`${organizationId}\0${currentMaterial.checksum}`).digest("hex");
      const policyVersionId = `managed-default-${lineageHash}`;
      const commandId = `managed-default-reconcile-${lineageHash}`;
      const requestJson = canonicalJson({
        operation: "reconcile-managed-default",
        organizationId,
        kind,
        previousPolicyVersionId: active.policy_version_id,
        previousChecksum: active.checksum,
        targetChecksum: currentMaterial.checksum,
      });
      const repeated = await this.repeated(tx, organizationId, commandId, requestJson);
      if (repeated) {
        const replayed = await this.find(tx, organizationId, repeated.policy_version_id);
        return {
          organizationId,
          kind,
          action: "upgraded",
          previousPolicyVersionId: active.policy_version_id,
          policyVersionId: replayed.policy_version_id,
          version: replayed.version,
        };
      }
      const [superseded] = await tx.query<[PolicyVersion[]]>(
        "UPDATE governance_policy_version SET status = 'superseded', superseded_at = time::now() WHERE organization_id = $organization_id AND policy_version_id = $policy_version_id AND status = 'active' RETURN AFTER;",
        { organization_id: organizationId, policy_version_id: active.policy_version_id },
      );
      if (superseded.length !== 1) throw new Error("managed default active Policy Version 선점에 실패했습니다");
      const [created] = await tx.query<[PolicyVersion[]]>(
        "CREATE governance_policy_version CONTENT { policy_version_id: $policy_version_id, organization_id: $organization_id, version: $version, status: 'active', schema_json: $schema_json, policies_json: $policies_json, requirements_json: $requirements_json, checksum: $checksum, created_at: time::now(), activated_at: time::now() } RETURN AFTER;",
        {
          policy_version_id: policyVersionId,
          organization_id: organizationId,
          version,
          ...currentMaterial,
        },
      );
      if (created.length !== 1) throw new Error("managed default Policy Version 생성 결과가 없습니다");
      const result = await this.find(tx, organizationId, policyVersionId);
      await this.record(
        tx,
        organizationId,
        policyVersionId,
        commandId,
        "managed_default_reconciled",
        requestJson,
        result,
      );
      return {
        organizationId,
        kind,
        action: "upgraded",
        previousPolicyVersionId: active.policy_version_id,
        policyVersionId,
        version,
      };
    });
  }

  public async createDraft(context: TenantContext, input: CreatePolicyDraftInput): Promise<PolicyVersion> {
    await this.organizations.verifyTenantContext(context, ["owner", "admin"]);
    const validationErrors = validatePolicyBundle(input.bundle);
    if (validationErrors.length > 0) throw new Error(`Cedar Policy Bundle 검증 실패: ${validationErrors.join(",")}`);
    const requestJson = canonicalJson(input);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, ["owner", "admin"], tx);
      const repeated = await this.repeated(tx, context.organizationId, input.commandId, requestJson);
      if (repeated) return await this.find(tx, context.organizationId, repeated.policy_version_id);
      const [latest] = await tx.query<[PolicyVersion[]]>(
        "SELECT * OMIT id FROM governance_policy_version WHERE organization_id = $organization_id ORDER BY version DESC LIMIT 1;",
        { organization_id: context.organizationId },
      );
      const version = (latest[0]?.version ?? 0) + 1;
      const policyVersionId = randomUUID();
      const schemaJson = canonicalJson(input.bundle.schema);
      const policiesJson = canonicalJson(input.bundle.policies);
      const requirementsJson = canonicalJson(input.requirements);
      const checksum = createHash("sha256")
        .update(canonicalJson({ bundle: input.bundle, requirements: input.requirements }))
        .digest("hex");
      const [created] = await tx.query<[PolicyVersion[]]>(
        "CREATE governance_policy_version CONTENT { policy_version_id: $policy_version_id, organization_id: $organization_id, version: $version, status: 'draft', schema_json: $schema_json, policies_json: $policies_json, requirements_json: $requirements_json, checksum: $checksum, created_at: time::now() } RETURN AFTER;",
        {
          policy_version_id: policyVersionId,
          organization_id: context.organizationId,
          version,
          schema_json: schemaJson,
          policies_json: policiesJson,
          requirements_json: requirementsJson,
          checksum,
        },
      );
      if (!created[0]) throw new Error("Policy Version 생성 결과가 없습니다");
      const result = await this.find(tx, context.organizationId, policyVersionId);
      await this.record(
        tx,
        context.organizationId,
        policyVersionId,
        input.commandId,
        "policy_draft_created",
        requestJson,
        result,
      );
      return result;
    });
  }

  public async activate(context: TenantContext, input: ActivatePolicyInput): Promise<PolicyVersion> {
    await this.organizations.verifyTenantContext(context, ["owner", "admin"]);
    const existingActive = await this.getActive(context);
    if (existingActive && !this.activationGate) throw new Error("active Policy 교체에는 Governance Gate가 필요합니다");
    if (existingActive && !input.governanceApprovalId) await this.authorizeActivation(context, input, existingActive);
    const requestJson = canonicalJson(input);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, ["owner", "admin"], tx);
      const repeated = await this.repeated(tx, context.organizationId, input.commandId, requestJson);
      if (repeated) return await this.find(tx, context.organizationId, repeated.policy_version_id);
      const target = await this.find(tx, context.organizationId, input.policyVersionId);
      const active = await this.active(tx, context.organizationId);
      const activeId = active?.policy_version_id;
      if (activeId !== input.expectedActivePolicyVersionId)
        throw new Error("active Policy Version precondition이 일치하지 않습니다");
      if (target.status !== "draft") throw new Error("draft Policy Version만 활성화할 수 있습니다");
      if (active && input.governanceApprovalId) await this.authorizeActivation(context, input, active, tx);
      if (active) {
        await tx.query(
          "UPDATE governance_policy_version SET status = 'superseded', superseded_at = time::now() WHERE organization_id = $organization_id AND policy_version_id = $policy_version_id;",
          { organization_id: context.organizationId, policy_version_id: active.policy_version_id },
        );
      }
      const [updated] = await tx.query<[PolicyVersion[]]>(
        "UPDATE governance_policy_version SET status = 'active', activated_at = time::now() WHERE organization_id = $organization_id AND policy_version_id = $policy_version_id RETURN AFTER;",
        { organization_id: context.organizationId, policy_version_id: target.policy_version_id },
      );
      if (!updated[0]) throw new Error("Policy Version 활성화 결과가 없습니다");
      const result = await this.find(tx, context.organizationId, target.policy_version_id);
      await this.record(
        tx,
        context.organizationId,
        result.policy_version_id,
        input.commandId,
        "policy_version_activated",
        requestJson,
        result,
      );
      return result;
    });
  }

  private async authorizeActivation(
    context: TenantContext,
    input: ActivatePolicyInput,
    active: PolicyVersion,
    executor?: QueryExecutor,
  ): Promise<void> {
    if (!this.activationGate) throw new Error("active Policy 교체에는 Governance Gate가 필요합니다");
    await this.activationGate.authorize(
      context,
      {
        commandId: input.commandId,
        action: "policy.activate",
        resource: { type: "Policy", id: input.policyVersionId, revision: active.version },
        environment: input.governanceEnvironment ?? "local",
        riskClass: "destructive",
        external: false,
        executionId: `policy-activation:${input.policyVersionId}`,
        ...(input.governanceApprovalId ? { approvalId: input.governanceApprovalId } : {}),
      },
      executor,
    );
  }

  public async get(context: TenantContext, policyVersionId: string): Promise<PolicyVersion> {
    await this.organizations.verifyTenantContext(context);
    return await this.find(this.database, context.organizationId, policyVersionId);
  }

  public async getActive(context: TenantContext): Promise<PolicyVersion | undefined> {
    await this.organizations.verifyTenantContext(context);
    return await this.active(this.database, context.organizationId);
  }

  public async getActivePolicy(context: TenantContext): Promise<ActivePolicy | undefined> {
    const version = await this.getActive(context);
    if (!version) return undefined;
    return {
      version,
      bundle: {
        schema: JSON.parse(version.schema_json) as Readonly<Record<string, unknown>>,
        policies: JSON.parse(version.policies_json) as Readonly<Record<string, string>>,
      },
      requirements: JSON.parse(version.requirements_json) as ApprovalRequirement[],
    };
  }

  /** Growth projection 전용 API입니다. 호출자는 동일 transaction에서 Governance 결정을 검증해야 합니다. */
  public async inspectGrowthProjection(context: TenantContext, executor: QueryExecutor): Promise<ActivePolicy> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    const version = await this.active(executor, context.organizationId);
    if (!version) throw new Error("활성 Policy Version을 찾을 수 없습니다");
    return {
      version,
      bundle: {
        schema: JSON.parse(version.schema_json) as Readonly<Record<string, unknown>>,
        policies: JSON.parse(version.policies_json) as Readonly<Record<string, string>>,
      },
      requirements: JSON.parse(version.requirements_json) as ApprovalRequirement[],
    };
  }

  /** 검증된 Growth patch를 활성 Policy의 새 immutable version으로 투영합니다. */
  public async applyGrowthProjection(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly expectedVersionId: string;
      readonly patch: { readonly policyId: string; readonly policyText: string };
    },
    executor: QueryExecutor,
  ): Promise<ActivePolicy> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    const current = await this.active(executor, context.organizationId);
    if (!current || current.policy_version_id !== input.expectedVersionId) {
      throw new Error("active Policy Version precondition이 일치하지 않습니다");
    }
    const existing = await this.repeated(executor, context.organizationId, input.commandId, canonicalJson(input));
    if (existing) {
      const replayed = await this.find(executor, context.organizationId, existing.policy_version_id);
      return {
        version: replayed,
        bundle: {
          schema: JSON.parse(replayed.schema_json) as Record<string, unknown>,
          policies: JSON.parse(replayed.policies_json) as Record<string, string>,
        },
        requirements: JSON.parse(replayed.requirements_json) as ApprovalRequirement[],
      };
    }
    const bundle: PolicyBundle = {
      schema: JSON.parse(current.schema_json) as Readonly<Record<string, unknown>>,
      policies: {
        ...(JSON.parse(current.policies_json) as Record<string, string>),
        [input.patch.policyId]: input.patch.policyText,
      },
    };
    const errors = validatePolicyBundle(bundle);
    if (errors.length > 0) throw new Error(`Cedar Policy Bundle 검증 실패: ${errors.join(",")}`);
    const requirements = JSON.parse(current.requirements_json) as ApprovalRequirement[];
    const id = randomUUID();
    const schemaJson = canonicalJson(bundle.schema);
    const policiesJson = canonicalJson(bundle.policies);
    const requirementsJson = canonicalJson(requirements);
    const checksum = createHash("sha256").update(canonicalJson({ bundle, requirements })).digest("hex");
    await executor.query(
      "UPDATE governance_policy_version SET status = 'superseded', superseded_at = time::now() WHERE organization_id = $organization_id AND policy_version_id = $policy_version_id;",
      { organization_id: context.organizationId, policy_version_id: current.policy_version_id },
    );
    const [created] = await executor.query<[PolicyVersion[]]>(
      "CREATE governance_policy_version CONTENT { policy_version_id: $id, organization_id: $organization_id, version: $version, status: 'active', schema_json: $schema_json, policies_json: $policies_json, requirements_json: $requirements_json, checksum: $checksum, created_at: time::now(), activated_at: time::now() } RETURN AFTER;",
      {
        id,
        organization_id: context.organizationId,
        version: current.version + 1,
        schema_json: schemaJson,
        policies_json: policiesJson,
        requirements_json: requirementsJson,
        checksum,
      },
    );
    if (!created[0]) throw new Error("Growth Policy Version 생성 결과가 없습니다");
    const result = await this.find(executor, context.organizationId, id);
    await this.record(
      executor,
      context.organizationId,
      id,
      input.commandId,
      "growth_policy_adopted",
      canonicalJson(input),
      result,
    );
    return { version: result, bundle, requirements };
  }

  public async revertGrowthProjection(
    context: TenantContext,
    input: { readonly commandId: string; readonly expectedVersionId: string; readonly targetVersionId: string },
    executor: QueryExecutor,
  ): Promise<ActivePolicy> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    const current = await this.active(executor, context.organizationId);
    if (!current || current.policy_version_id !== input.expectedVersionId)
      throw new Error("active Policy revert precondition이 일치하지 않습니다");
    const target = await this.find(executor, context.organizationId, input.targetVersionId);
    const requestJson = canonicalJson(input);
    const existing = await this.repeated(executor, context.organizationId, input.commandId, requestJson);
    if (existing) {
      const replayed = await this.find(executor, context.organizationId, existing.policy_version_id);
      return {
        version: replayed,
        bundle: {
          schema: JSON.parse(replayed.schema_json) as Record<string, unknown>,
          policies: JSON.parse(replayed.policies_json) as Record<string, string>,
        },
        requirements: JSON.parse(replayed.requirements_json) as ApprovalRequirement[],
      };
    }
    const bundle: PolicyBundle = {
      schema: JSON.parse(target.schema_json) as Record<string, unknown>,
      policies: JSON.parse(target.policies_json) as Record<string, string>,
    };
    const requirements = JSON.parse(target.requirements_json) as ApprovalRequirement[];
    const errors = validatePolicyBundle(bundle);
    if (errors.length > 0) throw new Error(`Cedar Policy Bundle 검증 실패: ${errors.join(",")}`);
    const id = randomUUID();
    await executor.query(
      "UPDATE governance_policy_version SET status = 'superseded', superseded_at = time::now() WHERE organization_id = $organization_id AND policy_version_id = $policy_version_id;",
      { organization_id: context.organizationId, policy_version_id: current.policy_version_id },
    );
    const [created] = await executor.query<[PolicyVersion[]]>(
      "CREATE governance_policy_version CONTENT { policy_version_id: $id, organization_id: $organization_id, version: $version, status: 'active', schema_json: $schema_json, policies_json: $policies_json, requirements_json: $requirements_json, checksum: $checksum, created_at: time::now(), activated_at: time::now() } RETURN AFTER;",
      {
        id,
        organization_id: context.organizationId,
        version: current.version + 1,
        schema_json: target.schema_json,
        policies_json: target.policies_json,
        requirements_json: target.requirements_json,
        checksum: target.checksum,
      },
    );
    if (!created[0]) throw new Error("Growth Policy revert version 생성 결과가 없습니다");
    const result = await this.find(executor, context.organizationId, id);
    await this.record(
      executor,
      context.organizationId,
      id,
      input.commandId,
      "growth_policy_reverted",
      requestJson,
      result,
    );
    return { version: result, bundle, requirements };
  }

  private async find(executor: QueryExecutor, organizationId: string, policyVersionId: string): Promise<PolicyVersion> {
    const [records] = await executor.query<[PolicyVersion[]]>(
      "SELECT * OMIT id FROM governance_policy_version WHERE organization_id = $organization_id AND policy_version_id = $policy_version_id LIMIT 1;",
      { organization_id: organizationId, policy_version_id: policyVersionId },
    );
    if (!records[0]) throw new Error(`Policy Version을 찾을 수 없습니다: ${policyVersionId}`);
    assertPolicyIntegrity(records[0]);
    return records[0];
  }

  private async active(executor: QueryExecutor, organizationId: string): Promise<PolicyVersion | undefined> {
    const [records] = await executor.query<[PolicyVersion[]]>(
      "SELECT * OMIT id FROM governance_policy_version WHERE organization_id = $organization_id AND status = 'active';",
      { organization_id: organizationId },
    );
    if (records.length > 1) throw new Error("조직별 active Policy Version은 하나여야 합니다");
    if (records[0]) assertPolicyIntegrity(records[0]);
    return records[0];
  }

  private async repeated(
    executor: QueryExecutor,
    organizationId: string,
    commandId: string,
    requestJson: string,
  ): Promise<PolicyEvent | undefined> {
    const [events] = await executor.query<[PolicyEvent[]]>(
      "SELECT * OMIT id FROM governance_policy_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    if (events[0] && events[0].request_json !== requestJson)
      throw new Error("같은 commandId에 다른 Policy 요청을 사용할 수 없습니다");
    return events[0];
  }

  private async record(
    executor: QueryExecutor,
    organizationId: string,
    policyVersionId: string,
    commandId: string,
    eventType: string,
    requestJson: string,
    result: PolicyVersion,
  ): Promise<void> {
    await executor.query(
      "CREATE governance_policy_event CONTENT { event_id: $event_id, organization_id: $organization_id, policy_version_id: $policy_version_id, command_id: $command_id, event_type: $event_type, request_json: $request_json, result_json: $result_json, created_at: time::now() };",
      {
        event_id: randomUUID(),
        organization_id: organizationId,
        policy_version_id: policyVersionId,
        command_id: commandId,
        event_type: eventType,
        request_json: requestJson,
        result_json: canonicalJson(result),
      },
    );
  }
}
