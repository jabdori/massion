import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase, type MassionDatabase, type QueryExecutor } from "@massion/storage";

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
    const listNodes = vi.spyOn(graph, "listNodes");
    const advisor = await StaffingAdvisor.create(database, organizations, graph);
    const input = {
      commandId: crypto.randomUUID(),
      workId: "work-1",
      strategyGenerationId: "strategy-1",
      tasks: [task("verify", ["assurance"], ["assurance"])],
    };

    const first = await advisor.assess(context, input);
    const repeated = await advisor.assess(context, input);

    expect(first.status).toBe("verified");
    expect(first.recommendations).toEqual([
      { taskKey: "verify", agentHandle: "assurance", requiredCapabilities: ["assurance"] },
    ]);
    expect(first.gaps).toEqual([]);
    expect(repeated.assessmentId).toBe(first.assessmentId);
    expect(listNodes).toHaveBeenCalledTimes(1);
    expect(listNodes).toHaveBeenCalledWith(context, expect.anything());
  });

  it("추천이 없으면 현재 Work에서 모든 필수 역량을 충족하는 활성 후보만 handle 순서로 추천한다", async () => {
    await graph.execute(context, {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      kind: "install-profile",
      profileId: "staffing-candidates",
      profileVersion: "1.0.0",
      nodes: [
        {
          handle: "staffing-a-persistent",
          name: "Persistent Full",
          responsibility: "Database와 security를 담당한다",
          outputs: ["Review"],
          capabilities: ["database", "security"],
          parentHandle: "delivery-coordination",
          scope: "persistent",
          role: "operator",
        },
        {
          handle: "staffing-b-current-work",
          name: "Current Work Full",
          responsibility: "현재 Work의 Database와 security를 담당한다",
          outputs: ["Review"],
          capabilities: ["security", "database"],
          parentHandle: "delivery-coordination",
          scope: "work",
          workId: "work-candidates",
          role: "operator",
        },
        {
          handle: "staffing-c-partial",
          name: "Partial",
          responsibility: "Database만 담당한다",
          outputs: ["Review"],
          capabilities: ["database"],
          parentHandle: "delivery-coordination",
          scope: "persistent",
          role: "operator",
        },
        {
          handle: "staffing-d-other-work",
          name: "Other Work Full",
          responsibility: "다른 Work의 Database와 security를 담당한다",
          outputs: ["Review"],
          capabilities: ["database", "security"],
          parentHandle: "delivery-coordination",
          scope: "work",
          workId: "work-other",
          role: "operator",
        },
      ],
    });
    const advisor = await StaffingAdvisor.create(database, organizations, graph);

    const result = await advisor.assess(context, {
      commandId: crypto.randomUUID(),
      workId: "work-candidates",
      strategyGenerationId: "strategy-candidates",
      tasks: [task("staff", ["database", "security"], [])],
    });

    expect(result.status).toBe("verified");
    expect(result.gaps).toEqual([]);
    expect(result.recommendations).toEqual([
      {
        taskKey: "staff",
        agentHandle: "staffing-a-persistent",
        requiredCapabilities: ["database", "security"],
      },
      {
        taskKey: "staff",
        agentHandle: "staffing-b-current-work",
        requiredCapabilities: ["database", "security"],
      },
    ]);
  });

  it("명시 추천이 일부 필수 역량만 가지면 gap으로 기록하고 replay에서도 행을 중복하지 않는다", async () => {
    await graph.execute(context, {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      kind: "install-profile",
      profileId: "staffing-partial",
      profileVersion: "1.0.0",
      nodes: [
        {
          handle: "staffing-partial-agent",
          name: "Partial Agent",
          responsibility: "Database만 담당한다",
          outputs: ["Review"],
          capabilities: ["database"],
          parentHandle: "delivery-coordination",
          scope: "persistent",
          role: "operator",
        },
      ],
    });
    const advisor = await StaffingAdvisor.create(database, organizations, graph);
    const input = {
      commandId: crypto.randomUUID(),
      workId: "work-partial",
      strategyGenerationId: "strategy-partial",
      tasks: [task("partial", ["database", "security"], ["staffing-partial-agent"])],
    };

    const first = await advisor.assess(context, input);
    const replayed = await advisor.assess(context, input);

    expect(first.status).toBe("gaps");
    expect(first.recommendations).toEqual([]);
    expect(first.gaps).toEqual([
      expect.objectContaining({
        taskKey: "partial",
        reason: "unavailable_recommendation",
        agentHandle: "staffing-partial-agent",
      }),
    ]);
    expect(replayed).toEqual(first);
    const [[assessmentCount], [gapCount], [eventCount]] = await Promise.all([
      database.query<[{ count: number }[]]>(
        "SELECT count() AS count FROM staffing_assessment WHERE organization_id = $organization_id GROUP ALL;",
        { organization_id: context.organizationId },
      ),
      database.query<[{ count: number }[]]>(
        "SELECT count() AS count FROM staffing_gap WHERE organization_id = $organization_id GROUP ALL;",
        { organization_id: context.organizationId },
      ),
      database.query<[{ count: number }[]]>(
        "SELECT count() AS count FROM strategy_event WHERE organization_id = $organization_id AND event_type = 'staffing_gap_detected' GROUP ALL;",
        { organization_id: context.organizationId },
      ),
    ]);
    expect(assessmentCount[0]?.count).toBe(1);
    expect(gapCount[0]?.count).toBe(1);
    expect(eventCount[0]?.count).toBe(1);
  });

  it("필수 역량이 비어 있으면 명시 추천만 검증하고 자동 후보를 만들지 않는다", async () => {
    const advisor = await StaffingAdvisor.create(database, organizations, graph);

    const result = await advisor.assess(context, {
      commandId: crypto.randomUUID(),
      workId: "work-empty-capabilities",
      strategyGenerationId: "strategy-empty-capabilities",
      tasks: [task("unassigned", [], []), task("explicit", [], ["assurance"])],
    });

    expect(result.status).toBe("verified");
    expect(result.gaps).toEqual([]);
    expect(result.recommendations).toEqual([
      { taskKey: "explicit", agentHandle: "assurance", requiredCapabilities: [] },
    ]);
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
      expect.objectContaining({
        taskKey: "missing",
        reason: "unavailable_recommendation",
        agentHandle: "research-specialist",
      }),
      expect.objectContaining({
        taskKey: "inactive",
        reason: "unavailable_recommendation",
        agentHandle: "inactive-researcher",
      }),
    ]);
    expect(result.recommendations).toEqual([]);
    const [events] = await database.query<[{ event_type: string }[]]>(
      "SELECT event_type FROM strategy_event WHERE organization_id = $organization_id AND strategy_generation_id = $strategy_generation_id;",
      { organization_id: context.organizationId, strategy_generation_id: "strategy-gap" },
    );
    expect(events.map((event) => event.event_type)).toContain("staffing_gap_detected");
  });

  it("모든 필수 역량을 가진 inactive Agent는 자동 후보에서 제외한다", async () => {
    await graph.execute(context, {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      kind: "install-profile",
      profileId: "inactive-full-capability",
      profileVersion: "1.0.0",
      nodes: [
        {
          handle: "inactive-full-capability",
          name: "Inactive Full Capability",
          responsibility: "비활성 전체 역량 후보",
          outputs: ["Review"],
          capabilities: ["rare-capability"],
          parentHandle: "delivery-coordination",
          scope: "persistent",
          role: "operator",
        },
      ],
    });
    await graph.execute(context, {
      commandId: crypto.randomUUID(),
      expectedVersion: 2,
      kind: "deactivate",
      handle: "inactive-full-capability",
    });
    const advisor = await StaffingAdvisor.create(database, organizations, graph);

    const result = await advisor.assess(context, {
      commandId: crypto.randomUUID(),
      workId: "work-inactive-candidate",
      strategyGenerationId: "strategy-inactive-candidate",
      tasks: [task("inactive-candidate", ["rare-capability"], [])],
    });

    expect(result.recommendations).toEqual([]);
    expect(result.gaps).toEqual([
      expect.objectContaining({
        taskKey: "inactive-candidate",
        reason: "missing_recommendation",
        capability: "rare-capability",
      }),
    ]);
  });

  it("명시 추천은 동일 Work 범위 Agent만 허용하고 다른 Work 범위 Agent는 gap으로 기록한다", async () => {
    await graph.execute(context, {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      kind: "install-profile",
      profileId: "explicit-work-scope",
      profileVersion: "1.0.0",
      nodes: [
        {
          handle: "explicit-current-work",
          name: "Current Work",
          responsibility: "현재 Work 담당",
          outputs: ["Review"],
          capabilities: ["scoped-capability"],
          parentHandle: "delivery-coordination",
          scope: "work",
          workId: "work-explicit-scope",
          role: "operator",
        },
        {
          handle: "explicit-other-work",
          name: "Other Work",
          responsibility: "다른 Work 담당",
          outputs: ["Review"],
          capabilities: ["scoped-capability"],
          parentHandle: "delivery-coordination",
          scope: "work",
          workId: "work-other-scope",
          role: "operator",
        },
      ],
    });
    const advisor = await StaffingAdvisor.create(database, organizations, graph);

    const result = await advisor.assess(context, {
      commandId: crypto.randomUUID(),
      workId: "work-explicit-scope",
      strategyGenerationId: "strategy-explicit-scope",
      tasks: [
        task("current", ["scoped-capability"], ["explicit-current-work"]),
        task("other", ["scoped-capability"], ["explicit-other-work"]),
      ],
    });

    expect(result.recommendations).toEqual([
      {
        taskKey: "current",
        agentHandle: "explicit-current-work",
        requiredCapabilities: ["scoped-capability"],
      },
    ]);
    expect(result.gaps).toEqual([
      expect.objectContaining({
        taskKey: "other",
        reason: "unavailable_recommendation",
        agentHandle: "explicit-other-work",
      }),
    ]);
  });

  it("Organization snapshot 조회 오류는 gap으로 바꾸거나 assessment를 저장하지 않고 전파한다", async () => {
    const advisor = await StaffingAdvisor.create(database, organizations, {
      listNodes: async () => {
        throw new Error("organization-list-infrastructure-failure");
      },
    } as never);

    await expect(
      advisor.assess(context, {
        commandId: crypto.randomUUID(),
        workId: "work-infrastructure-failure",
        strategyGenerationId: "strategy-infrastructure-failure",
        tasks: [task("infrastructure", ["database"], ["assurance"])],
      }),
    ).rejects.toThrow("organization-list-infrastructure-failure");
    const [[assessments], [gaps], [events]] = await Promise.all([
      database.query<[{ count: number }[]]>("SELECT count() AS count FROM staffing_assessment GROUP ALL;"),
      database.query<[{ count: number }[]]>("SELECT count() AS count FROM staffing_gap GROUP ALL;"),
      database.query<[{ count: number }[]]>(
        "SELECT count() AS count FROM strategy_event WHERE event_type = 'staffing_gap_detected' GROUP ALL;",
      ),
    ]);
    expect(assessments[0]?.count ?? 0).toBe(0);
    expect(gaps[0]?.count ?? 0).toBe(0);
    expect(events[0]?.count ?? 0).toBe(0);
  });

  it("Staffing transaction 안에서 바뀐 Agent 상태를 다시 읽어 stale recommendation을 저장하지 않는다", async () => {
    await graph.execute(context, {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      kind: "install-profile",
      profileId: "staffing-snapshot-race",
      profileVersion: "1.0.0",
      nodes: [
        {
          handle: "staffing-snapshot-race",
          name: "Snapshot Race",
          responsibility: "경쟁 상태 검증",
          outputs: ["Review"],
          capabilities: ["race-capability"],
          parentHandle: "delivery-coordination",
          scope: "persistent",
          role: "operator",
        },
      ],
    });
    const transactionalGraph = {
      async listNodes(tenant: TenantContext, executor?: QueryExecutor) {
        if (!executor) return await graph.listNodes(tenant);
        await executor.query(
          "UPDATE organization_node SET status = 'inactive' WHERE organization_id = $organization_id AND handle = $handle;",
          { organization_id: tenant.organizationId, handle: "staffing-snapshot-race" },
        );
        const [nodes] = await executor.query<[Awaited<ReturnType<OrganizationGraphService["listNodes"]>>]>(
          "SELECT node_id, organization_id, handle, name, responsibility, outputs, capabilities, parent_handle, scope, work_id, builtin, status, role, created_at FROM organization_node WHERE organization_id = $organization_id ORDER BY handle ASC;",
          { organization_id: tenant.organizationId },
        );
        return nodes;
      },
      verifyActiveNode: graph.verifyActiveNode.bind(graph),
    };
    const advisor = await StaffingAdvisor.create(database, organizations, transactionalGraph);

    const result = await advisor.assess(context, {
      commandId: crypto.randomUUID(),
      workId: "work-snapshot-race",
      strategyGenerationId: "strategy-snapshot-race",
      tasks: [task("race", ["race-capability"], [])],
    });

    expect(result.recommendations).toEqual([]);
    expect(result.gaps).toEqual([
      expect.objectContaining({ taskKey: "race", reason: "missing_recommendation", capability: "race-capability" }),
    ]);
  });

  it("같은 command의 32개 동시 요청은 assessment·gap·event를 정확히 한 번만 저장한다", async () => {
    const advisor = await StaffingAdvisor.create(database, organizations, graph);
    const input = {
      commandId: crypto.randomUUID(),
      workId: "work-concurrent",
      strategyGenerationId: "strategy-concurrent",
      tasks: [task("concurrent", ["concurrent-capability"], [])],
    };

    const results = await Promise.all(Array.from({ length: 32 }, async () => await advisor.assess(context, input)));

    expect(new Set(results.map((result) => result.assessmentId)).size).toBe(1);
    const [[assessments], [gaps], [events]] = await Promise.all([
      database.query<[{ count: number }[]]>(
        "SELECT count() AS count FROM staffing_assessment WHERE organization_id = $organization_id AND command_id = $command_id GROUP ALL;",
        { organization_id: context.organizationId, command_id: input.commandId },
      ),
      database.query<[{ count: number }[]]>(
        "SELECT count() AS count FROM staffing_gap WHERE organization_id = $organization_id AND work_id = $work_id GROUP ALL;",
        { organization_id: context.organizationId, work_id: input.workId },
      ),
      database.query<[{ count: number }[]]>(
        "SELECT count() AS count FROM strategy_event WHERE organization_id = $organization_id AND work_id = $work_id AND event_type = 'staffing_gap_detected' GROUP ALL;",
        { organization_id: context.organizationId, work_id: input.workId },
      ),
    ]);
    expect(assessments[0]?.count).toBe(1);
    expect(gaps[0]?.count).toBe(1);
    expect(events[0]?.count).toBe(1);
  });

  it("같은 tenant의 같은 commandId에 다른 staffing payload를 거부한다", async () => {
    const advisor = await StaffingAdvisor.create(database, organizations, graph);
    const commandId = crypto.randomUUID();
    await advisor.assess(context, {
      commandId,
      workId: "work-payload",
      strategyGenerationId: "strategy-payload",
      tasks: [task("first", ["first-capability"], [])],
    });

    await expect(
      advisor.assess(context, {
        commandId,
        workId: "work-payload",
        strategyGenerationId: "strategy-payload",
        tasks: [task("second", ["second-capability"], [])],
      }),
    ).rejects.toThrow("같은 commandId");
  });

  it("같은 commandId의 staffing assessment를 tenant별로 격리한다", async () => {
    const identity = await IdentityService.create(database);
    const other = await identity.registerPersonalUser({ email: "staffing-other@example.com", displayName: "Other" });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );
    await graph.bootstrap(otherContext);
    const advisor = await StaffingAdvisor.create(database, organizations, graph);
    const commandId = crypto.randomUUID();
    const input = {
      commandId,
      workId: "work-tenant",
      strategyGenerationId: "strategy-tenant",
      tasks: [task("tenant", ["tenant-capability"], [])],
    };

    const [first, second] = await Promise.all([advisor.assess(context, input), advisor.assess(otherContext, input)]);

    expect(first.assessmentId).not.toBe(second.assessmentId);
    const [records] = await database.query<[{ organization_id: string }[]]>(
      "SELECT organization_id FROM staffing_assessment WHERE command_id = $command_id ORDER BY organization_id ASC;",
      { command_id: commandId },
    );
    expect(records.map((record) => record.organization_id)).toEqual(
      [context.organizationId, otherContext.organizationId].sort(),
    );
  });
});
