import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { WorkService } from "./work.js";

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
});
