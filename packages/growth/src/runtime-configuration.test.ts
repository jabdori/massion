import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { RuntimeExecutionStore } from "@massion/runtime";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";

import { PromptMemoryStore } from "./prompt-memory.js";
import { GrowthAgentConfigurationReader } from "./runtime-configuration.js";
import { GrowthWorkPromptAdapter } from "./work-prompt-adapter.js";

describe("Growth Runtime AgentConfiguration adapter", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let work: WorkService;
  let reader: GrowthAgentConfigurationReader;
  let executions: RuntimeExecutionStore;
  let organizationVersionId: string;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "runtime-config@example.com", displayName: "Runtime" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    const bootstrapped = await graph.bootstrap(context);
    organizationVersionId = bootstrapped.version.version_id;
    const prompts = await PromptMemoryStore.create(database, organizations);
    await prompts.bootstrap(context, bootstrapped.nodes);
    const resolver = new GrowthWorkPromptAdapter(database, organizations, prompts);
    work = await WorkService.create(database, organizations, graph, undefined, resolver);
    reader = new GrowthAgentConfigurationReader(database, organizations, prompts);
    executions = await RuntimeExecutionStore.create(database, organizations, reader);
  });

  afterEach(async () => database.close());

  it("Runtime Execution에 exact Prompt·Memory·instruction checksum을 기록한다", async () => {
    const createdWork = await work.createWork(context, {
      commandId: "runtime-config-work",
      text: "실행 프롬프트를 고정해주세요",
      surface: "test",
      organizationVersionId,
    });
    const created = await executions.createExecution(context, {
      commandId: "runtime-config-execution",
      workId: createdWork.work.work_id,
      agentHandle: "assurance",
      modelRoute: "default",
      correlationId: "runtime-config-correlation",
      estimatedTokens: 100,
      estimatedCostMicros: 1,
      input: "검증",
    });
    const resolved = await reader.resolve(context, {
      executionId: created.execution.execution_id,
      agentHandle: "assurance",
    });

    expect(created.execution).toMatchObject({
      prompt_version_id: createdWork.work.prompt_version_id,
      prompt_checksum: resolved.promptChecksum,
      memory_version_ids: resolved.memoryVersionIds,
      agent_instruction_checksum: resolved.instructionChecksum,
    });
    expect(resolved.instruction).toContain("독립 리뷰");
  });
});
