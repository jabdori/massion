import type { GovernanceAuthorization, GovernanceGate, GovernedAgentIdentityReader } from "@massion/governance";
import type { OrganizationService, TenantContext } from "@massion/identity";
import type { MassionDatabase, QueryExecutor } from "@massion/storage";

import type { ConfigureGrowthInput, GrowthConfigurationAuthorizer, GrowthConfigurationVersion } from "./contracts.js";

interface RuntimeAgentIdentityRecord {
  readonly organization_id: string;
  readonly work_id: string;
  readonly agent_handle: string;
  readonly status:
    | "queued"
    | "running"
    | "suspended"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "interrupted"
    | "blocked_model_unavailable";
}

export class GrowthRuntimeAgentIdentityReader implements GovernedAgentIdentityReader {
  public constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public async resolve(context: TenantContext, executionId: string) {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[RuntimeAgentIdentityRecord[]]>(
      "SELECT organization_id, work_id, agent_handle, status FROM runtime_execution WHERE organization_id = $organization_id AND execution_id = $execution_id LIMIT 1;",
      { organization_id: context.organizationId, execution_id: executionId },
    );
    const record = records[0];
    if (!record) throw new Error("Governed Runtime Execution을 찾을 수 없습니다");
    return {
      organizationId: record.organization_id,
      workId: record.work_id,
      agentHandle: record.agent_handle,
      status: record.status,
    };
  }
}

export interface AuthorizeGrowthAdoptionInput {
  readonly commandId: string;
  readonly workId: string;
  readonly suggestionId: string;
  readonly suggestionRevision: number;
  readonly reflectionExecutionId: string;
  readonly configuration: GrowthConfigurationVersion;
  readonly approvalId?: string;
}

export class GrowthGovernanceAdapter implements GrowthConfigurationAuthorizer {
  public constructor(private readonly gate: Pick<GovernanceGate, "authorize" | "authorizeAgent">) {}

  public async authorizeConfiguration(
    context: TenantContext,
    input: ConfigureGrowthInput,
    executor?: QueryExecutor,
  ): Promise<{ readonly governanceDecisionId: string }> {
    const authorization = await this.gate.authorize(
      context,
      {
        commandId: input.commandId,
        action: "growth.configure",
        resource: {
          type: "GrowthConfiguration",
          id: input.subject.type === "organization" ? context.organizationId : input.subject.userId,
          ...(input.expectedVersion === undefined ? {} : { revision: input.expectedVersion }),
          attributes: {
            subjectType: input.subject.type,
            ...(input.subject.type === "user" ? { subjectId: input.subject.userId } : {}),
          },
        },
        environment: "local",
        riskClass: "growth-configuration",
        external: false,
        executionId: `growth-configuration:${input.commandId}`,
      },
      executor,
    );
    return { governanceDecisionId: authorization.decision.decisionId };
  }

  public async authorizeAdoption(
    context: TenantContext,
    input: AuthorizeGrowthAdoptionInput,
    executor?: QueryExecutor,
  ): Promise<GovernanceAuthorization> {
    if (input.configuration.organizationId !== context.organizationId) {
      throw new Error("GrowthConfigurationVersion의 organization이 다릅니다");
    }
    return await this.gate.authorizeAgent(
      context,
      {
        commandId: input.commandId,
        action: "growth.adopt",
        workId: input.workId,
        automationMode: input.configuration.adoptionMode,
        resource: {
          type: "Suggestion",
          id: input.suggestionId,
          revision: input.suggestionRevision,
        },
        environment: "local",
        riskClass: "growth-adoption",
        external: false,
        executionId: input.reflectionExecutionId,
        ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      },
      executor,
    );
  }

  public async authorizeRevert(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly workId: string;
      readonly suggestionId: string;
      readonly suggestionRevision: number;
      readonly runtimeExecutionId: string;
      readonly mode: "review" | "auto" | "explicit";
      readonly approvalId?: string;
    },
    executor?: QueryExecutor,
  ): Promise<GovernanceAuthorization> {
    if (input.mode === "explicit") {
      return await this.gate.authorize(
        context,
        {
          commandId: input.commandId,
          action: "growth.revert",
          resource: { type: "Suggestion", id: input.suggestionId, revision: input.suggestionRevision },
          environment: "local",
          riskClass: "growth-revert",
          external: false,
          executionId: input.runtimeExecutionId,
          ...(input.approvalId ? { approvalId: input.approvalId } : {}),
        },
        executor,
      );
    }
    return await this.gate.authorizeAgent(
      context,
      {
        commandId: input.commandId,
        action: "growth.revert",
        workId: input.workId,
        automationMode: input.mode === "auto" ? "auto" : "review",
        resource: { type: "Suggestion", id: input.suggestionId, revision: input.suggestionRevision },
        environment: "local",
        riskClass: "growth-revert",
        external: false,
        executionId: input.runtimeExecutionId,
        ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      },
      executor,
    );
  }
}
