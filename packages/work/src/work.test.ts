import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { canTransitionWork, WorkService, type WorkStatus } from "./work.js";

describe("Request와 Work 상태 머신", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let service: WorkService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    service = await WorkService.create(database, organizations);
  });

  afterEach(async () => database.close());

  it("Request와 draft Work, 첫 Event를 원자 생성한다", async () => {
    const result = await service.createWork(context, {
      commandId: crypto.randomUUID(),
      text: "제품을 구현해주세요",
      surface: "cli",
      organizationVersionId: "organization-version-1",
    });

    expect(result.request.text).toBe("제품을 구현해주세요");
    expect(result.work).toMatchObject({ status: "draft", revision: 1 });
    expect(result.event).toMatchObject({ sequence: 1, event_type: "work_created" });
  });

  it("명세의 모든 Work 상태 전이 간선을 정확히 허용한다", () => {
    const expected: Readonly<Record<WorkStatus, readonly WorkStatus[]>> = {
      draft: ["planned", "cancelled"],
      planned: ["ready", "cancelled"],
      ready: ["running", "cancelled"],
      running: ["waiting_approval", "verifying", "failed", "cancelled"],
      waiting_approval: ["running", "cancelled"],
      verifying: ["completed", "failed", "cancelled"],
      completed: [],
      failed: ["retrying", "replanning", "cancelled"],
      retrying: ["running", "cancelled"],
      replanning: ["planned", "cancelled"],
      cancelled: [],
    };
    const statuses = Object.keys(expected) as WorkStatus[];
    for (const current of statuses) {
      for (const target of statuses)
        expect(canTransitionWork(current, target)).toBe(expected[current].includes(target));
    }
  });

  it("같은 command는 같은 결과를 반환하고 다른 payload 재사용은 거부한다", async () => {
    const input = { commandId: crypto.randomUUID(), text: "요청", surface: "web", organizationVersionId: "org-v1" };
    const first = await service.createWork(context, input);
    const repeated = await service.createWork(context, input);

    expect(repeated.work.work_id).toBe(first.work.work_id);
    await expect(service.createWork(context, { ...input, text: "다른 요청" })).rejects.toThrow("다른 명령");
  });

  it("유효한 PlanVersion 없이는 planned가 될 수 없고 금지 전이를 거부한다", async () => {
    const created = await service.createWork(context, {
      commandId: crypto.randomUUID(),
      text: "요청",
      surface: "tui",
      organizationVersionId: "org-v1",
    });

    await expect(
      service.transition(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: 1,
        target: "planned",
      }),
    ).rejects.toThrow("PlanVersion");
    const planned = await service.addPlan(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: 1,
      content: { objective: "완성" },
    });
    const transitioned = await service.transition(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: planned.work.revision,
      target: "planned",
    });

    expect(transitioned.work.status).toBe("planned");
    await expect(
      service.transition(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: transitioned.work.revision,
        target: "running",
      }),
    ).rejects.toThrow("허용되지 않은 Work 상태 전이");
  });

  it("같은 revision의 동시 변경은 하나만 commit하고 Event sequence를 보존한다", async () => {
    const created = await service.createWork(context, {
      commandId: crypto.randomUUID(),
      text: "요청",
      surface: "api",
      organizationVersionId: "org-v1",
    });
    const commands = ["첫 계획", "둘째 계획"].map((objective) =>
      service.addPlan(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: 1,
        content: { objective },
      }),
    );

    const results = await Promise.allSettled(commands);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await service.listEvents(context, created.work.work_id)).map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("cross-tenant 접근을 거부하고 저장소 우회 위반을 준수 검사로 찾는다", async () => {
    const created = await service.createWork(context, {
      commandId: crypto.randomUUID(),
      text: "검사",
      surface: "api",
      organizationVersionId: "org-v1",
    });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const other = await identity.registerPersonalUser({ email: "other@example.com", displayName: "Other" });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );

    await expect(
      service.getWork({ ...otherContext, organizationId: context.organizationId }, created.work.work_id),
    ).rejects.toThrow("TenantContext");
    await expect(
      database.query(
        "UPDATE work SET status = 'completed' WHERE organization_id = $organization_id AND work_id = $work_id;",
        { organization_id: context.organizationId, work_id: created.work.work_id },
      ),
    ).rejects.toThrow("허용되지 않은 Work 상태 전이");
    await database.query(
      "UPDATE work SET revision = 99 WHERE organization_id = $organization_id AND work_id = $work_id;",
      {
        organization_id: context.organizationId,
        work_id: created.work.work_id,
      },
    );
    const findings = await service.auditWork(context, created.work.work_id);

    expect(findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(["revision"]));
  });
});
