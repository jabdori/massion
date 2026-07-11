import type { OrganizationService, TenantContext } from "@massion/identity";
import type { AgentConfigurationReader, ResolvedAgentConfiguration } from "@massion/runtime";
import type { MassionDatabase } from "@massion/storage";

import { growthChecksum, type PromptMemoryStore } from "./prompt-memory.js";

interface RuntimeLineage {
  readonly execution_id: string;
  readonly work_id: string;
  readonly agent_handle: string;
}

interface WorkLineage {
  readonly prompt_version_id?: string;
  readonly prompt_schema_version?: string;
}

export class GrowthAgentConfigurationReader implements AgentConfigurationReader {
  public constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly prompts: PromptMemoryStore,
  ) {}

  public async resolve(
    context: TenantContext,
    input: { readonly executionId: string; readonly agentHandle: string },
  ): Promise<ResolvedAgentConfiguration> {
    await this.organizations.verifyTenantContext(context);
    const [executions] = await this.database.query<[RuntimeLineage[]]>(
      "SELECT execution_id, work_id, agent_handle FROM runtime_execution WHERE organization_id = $organization_id AND execution_id = $execution_id LIMIT 1;",
      { organization_id: context.organizationId, execution_id: input.executionId },
    );
    const execution = executions[0];
    if (!execution) throw new Error("Runtime Execution을 찾을 수 없습니다");
    if (execution.agent_handle !== input.agentHandle)
      throw new Error("Runtime Execution의 Agent handle이 일치하지 않습니다");
    const [works] = await this.database.query<[WorkLineage[]]>(
      "SELECT prompt_version_id, prompt_schema_version FROM work WHERE organization_id = $organization_id AND work_id = $work_id LIMIT 1;",
      { organization_id: context.organizationId, work_id: execution.work_id },
    );
    const work = works[0];
    if (!work?.prompt_version_id || work.prompt_schema_version !== "massion.work.prompt.v1") {
      throw new Error("Growth-aware Work PromptVersion을 찾을 수 없습니다");
    }
    const prompt = await this.prompts.getPromptVersion(context, work.prompt_version_id);
    const section = prompt.sections.find((candidate) => candidate.agentHandle === input.agentHandle);
    if (!section) throw new Error(`PromptVersion에서 Agent section을 찾을 수 없습니다: ${input.agentHandle}`);
    return {
      promptVersionId: prompt.promptVersionId,
      promptChecksum: prompt.checksum,
      memoryVersionIds: prompt.memoryVersionIds,
      instruction: section.instruction,
      instructionChecksum: growthChecksum(section),
    };
  }
}
