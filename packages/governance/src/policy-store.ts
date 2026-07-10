import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { validatePolicyBundle } from "./cedar-authorizer.js";
import type { ApprovalRequirement, PolicyBundle } from "./contracts.js";
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

  private async find(executor: QueryExecutor, organizationId: string, policyVersionId: string): Promise<PolicyVersion> {
    const [records] = await executor.query<[PolicyVersion[]]>(
      "SELECT * OMIT id FROM governance_policy_version WHERE organization_id = $organization_id AND policy_version_id = $policy_version_id LIMIT 1;",
      { organization_id: organizationId, policy_version_id: policyVersionId },
    );
    if (!records[0]) throw new Error(`Policy Version을 찾을 수 없습니다: ${policyVersionId}`);
    return records[0];
  }

  private async active(executor: QueryExecutor, organizationId: string): Promise<PolicyVersion | undefined> {
    const [records] = await executor.query<[PolicyVersion[]]>(
      "SELECT * OMIT id FROM governance_policy_version WHERE organization_id = $organization_id AND status = 'active' LIMIT 1;",
      { organization_id: organizationId },
    );
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
