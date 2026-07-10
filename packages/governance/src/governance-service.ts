import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase } from "@massion/storage";

import { CedarAuthorizer } from "./cedar-authorizer.js";
import type { ApprovalRequirement, EvaluatePolicyInput, PolicyDecision, PolicyRequest } from "./contracts.js";
import { PolicyStore } from "./policy-store.js";
import { GOVERNANCE_DECISION_MIGRATION } from "./schema.js";

interface DecisionRecord {
  readonly decision_id: string;
  readonly organization_id: string;
  readonly command_id: string;
  readonly policy_version_id?: string;
  readonly request_hash: string;
  readonly outcome: PolicyDecision["outcome"];
  readonly reasons_json: string;
  readonly errors_json: string;
  readonly requirement_json?: string;
  readonly request_json: string;
  readonly created_at: unknown;
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

export function hashPolicyRequest(request: PolicyRequest): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

function matches(requirement: ApprovalRequirement, request: PolicyRequest): boolean {
  const environment = typeof request.context.environment === "string" ? request.context.environment : "unknown";
  const riskClass = typeof request.context.riskClass === "string" ? request.context.riskClass : "unknown";
  return (
    (requirement.actions.includes("*") || requirement.actions.includes(request.action)) &&
    (requirement.environments.includes("*") || requirement.environments.includes(environment)) &&
    (requirement.riskClasses.includes("*") || requirement.riskClasses.includes(riskClass))
  );
}

export class GovernanceService {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly policies: PolicyStore,
    private readonly authorizer = new CedarAuthorizer(),
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    policies: PolicyStore,
  ): Promise<GovernanceService> {
    await applyMigrations(database, [GOVERNANCE_DECISION_MIGRATION]);
    return new GovernanceService(database, organizations, policies);
  }

  public async evaluate(context: TenantContext, input: EvaluatePolicyInput): Promise<PolicyDecision> {
    await this.organizations.verifyTenantContext(context);
    const requestJson = canonicalJson(input);
    const repeated = await this.repeated(context.organizationId, input.commandId, requestJson);
    if (repeated) return this.view(repeated);
    const requestHash = hashPolicyRequest(input.request);
    let outcome: PolicyDecision["outcome"] = "deny";
    let reasons: readonly string[] = [];
    let errors: readonly string[] = [];
    let requirement: ApprovalRequirement | undefined;
    const active = await this.policies.getActivePolicy(context);
    if (!active) {
      errors = ["active_policy_missing"];
    } else if (
      input.request.principal.organizationId !== context.organizationId ||
      input.request.resource.organizationId !== context.organizationId
    ) {
      reasons = ["tenant-context"];
    } else {
      const authorization = this.authorizer.authorize(active.bundle, input.request);
      reasons = authorization.reasons;
      errors = authorization.errors;
      if (authorization.decision === "allow") {
        requirement = active.requirements.find((candidate) => matches(candidate, input.request));
        outcome = requirement ? "require_approval" : "allow";
      }
    }
    const decisionId = randomUUID();
    const summary = {
      principal: { type: input.request.principal.type, id: input.request.principal.id },
      action: input.request.action,
      resource: { type: input.request.resource.type, id: input.request.resource.id },
      environment: input.request.context.environment,
      riskClass: input.request.context.riskClass,
    };
    await this.database.query(
      "CREATE governance_policy_decision CONTENT { decision_id: $decision_id, organization_id: $organization_id, command_id: $command_id, policy_version_id: $policy_version_id, request_hash: $request_hash, request_summary_json: $summary_json, outcome: $outcome, reasons_json: $reasons_json, errors_json: $errors_json, requirement_json: $requirement_json, request_json: $request_json, created_at: time::now() };",
      {
        decision_id: decisionId,
        organization_id: context.organizationId,
        command_id: input.commandId,
        policy_version_id: active?.version.policy_version_id,
        request_hash: requestHash,
        summary_json: canonicalJson(summary),
        outcome,
        reasons_json: canonicalJson(reasons),
        errors_json: canonicalJson(errors),
        requirement_json: requirement ? canonicalJson(requirement) : undefined,
        request_json: requestJson,
      },
    );
    return this.view(await this.find(context.organizationId, decisionId));
  }

  public async getDecision(context: TenantContext, decisionId: string): Promise<PolicyDecision> {
    await this.organizations.verifyTenantContext(context);
    return this.view(await this.find(context.organizationId, decisionId));
  }

  private async repeated(
    organizationId: string,
    commandId: string,
    requestJson: string,
  ): Promise<DecisionRecord | undefined> {
    const [records] = await this.database.query<[DecisionRecord[]]>(
      "SELECT * OMIT id FROM governance_policy_decision WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    if (records[0] && records[0].request_json !== requestJson)
      throw new Error("같은 commandId에 다른 Governance 요청을 사용할 수 없습니다");
    return records[0];
  }

  private async find(organizationId: string, decisionId: string): Promise<DecisionRecord> {
    const [records] = await this.database.query<[DecisionRecord[]]>(
      "SELECT * OMIT id FROM governance_policy_decision WHERE organization_id = $organization_id AND decision_id = $decision_id LIMIT 1;",
      { organization_id: organizationId, decision_id: decisionId },
    );
    if (!records[0]) throw new Error(`Policy Decision을 찾을 수 없습니다: ${decisionId}`);
    return records[0];
  }

  private view(record: DecisionRecord): PolicyDecision {
    return {
      decisionId: record.decision_id,
      organizationId: record.organization_id,
      ...(record.policy_version_id ? { policyVersionId: record.policy_version_id } : {}),
      requestHash: record.request_hash,
      outcome: record.outcome,
      reasons: JSON.parse(record.reasons_json) as string[],
      errors: JSON.parse(record.errors_json) as string[],
      ...(record.requirement_json ? { requirement: JSON.parse(record.requirement_json) as ApprovalRequirement } : {}),
      createdAt: record.created_at,
    };
  }
}
