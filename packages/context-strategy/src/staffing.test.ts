import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { StaffingAdvisor, type StrategyTask } from "./index.js";

function task(
  key: string,
  requiredCapabilities: readonly string[],
  recommendedAgentHandles: readonly string[],
): StrategyTask {
  return {
    key,
    title: key,
    objective: `${key}를 수행한다`,
    criterionKeys: [],
    dependencyKeys: [],
    requiredCapabilities: [...requiredCapabilities],
    recommendedAgentHandles: [...recommendedAgentHandles],
    parallelizable: false,
  };
}

describe("Strategy staffing recommendation 검증", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let organizations: OrganizationService;
  let graph: OrganizationGraphService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "staffing@example.com", displayName: "Staffing" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    graph = await OrganizationGraphService.create(database, organizations);
    await graph.bootstrap(context);
  });

  afterEach(async () => database.close());

  it("명시적으로 추천된 활성 handle만 verified recommendation으로 보존한다", async () => {
    const verifyActiveNode = vi.spyOn(graph, "verifyActiveNode");
    const advisor = await StaffingAdvisor.create(database, organizations, graph);
    const input = {
      commandId: crypto.randomUUID(),
      workId: "work-1",
      strategyGenerationId: "strategy-1",
      tasks: [task("verify", ["testing"], ["assurance"])],
    };

    const first = await advisor.assess(context, input);
    const repeated = await advisor.assess(context, input);

    expect(first.status).toBe("verified");
    expect(first.recommendations).toEqual([
      { taskKey: "verify", agentHandle: "assurance", requiredCapabilities: ["testing"] },
    ]);
    expect(first.gaps).toEqual([]);
    expect(repeated.assessmentId).toBe(first.assessmentId);
    expect(verifyActiveNode).toHaveBeenCalledTimes(1);
    expect(verifyActiveNode).toHaveBeenCalledWith(context, "assurance");
  });

  it("추천 없음·존재하지 않음·비활성을 gap으로 기록하고 문자열 유사 대상을 선택하지 않는다", async () => {
    await graph.execute(context, {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      kind: "create",
      handle: "inactive-researcher",
      name: "Inactive Researcher",
      responsibility: "Research capability",
      parentHandle: "delivery-coordination",
      scope: "persistent",
    });
    await graph.execute(context, {
      commandId: crypto.randomUUID(),
      expectedVersion: 2,
      kind: "deactivate",
      handle: "inactive-researcher",
    });
    const verifyActiveNode = vi.spyOn(graph, "verifyActiveNode");
    const advisor = await StaffingAdvisor.create(database, organizations, graph);

    const result = await advisor.assess(context, {
      commandId: crypto.randomUUID(),
      workId: "work-gap",
      strategyGenerationId: "strategy-gap",
      tasks: [
        task("unrecommended", ["database"], []),
        task("missing", ["research"], ["research-specialist"]),
        task("inactive", ["research"], ["inactive-researcher"]),
      ],
    });

    expect(result.status).toBe("gaps");
    expect(result.gaps).toEqual([
      expect.objectContaining({ taskKey: "unrecommended", reason: "missing_recommendation", capability: "database" }),
      expect.objectContaining({ taskKey: "missing", reason: "unavailable_recommendation", agentHandle: "research-specialist" }),
      expect.objectContaining({ taskKey: "inactive", reason: "unavailable_recommendation", agentHandle: "inactive-researcher" }),
    ]);
    expect(result.recommendations).toEqual([]);
    expect(verifyActiveNode.mock.calls.map((call) => call[1])).toEqual([
      "research-specialist",
      "inactive-researcher",
    ]);
    expect(verifyActiveNode.mock.calls.flat()).not.toContain("evidence-research");

    const [events] = await database.query<[{ event_type: string }[]]>(
      "SELECT event_type FROM strategy_event WHERE organization_id = $organization_id AND strategy_generation_id = $strategy_generation_id;",
      { organization_id: context.organizationId, strategy_generation_id: "strategy-gap" },
    );
    expect(events.map((event) => event.event_type)).toContain("staffing_gap_detected");
  });
});
