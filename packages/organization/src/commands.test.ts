import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { OrganizationGraphService, type OrganizationCommand } from "./organization.js";

type CommandInput<Command> = Command extends unknown ? Omit<Command, "commandId" | "expectedVersion"> : never;

describe("버전 기반 조직 명령", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let graph: OrganizationGraphService;
  let version: number;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    graph = await OrganizationGraphService.create(database, organizations);
    version = Number((await graph.bootstrap(context)).version.version);
  });

  afterEach(async () => database.close());

  async function execute(command: CommandInput<OrganizationCommand>) {
    const result = await graph.execute(context, {
      ...command,
      commandId: crypto.randomUUID(),
      expectedVersion: version,
    } as OrganizationCommand);
    version = Number(result.version.version);
    return result;
  }

  async function create(handle: string, parentHandle = "delivery-coordination") {
    return await execute({
      kind: "create",
      handle,
      name: handle,
      responsibility: `${handle} 책임`,
      parentHandle,
      scope: "persistent",
    });
  }

  it("상태·이동·역할·승격을 각각 새 version으로 적용한다", async () => {
    const created = await create("engineering");
    const createdAt = String(created.nodes.find((node) => node.handle === "engineering")?.created_at);
    await create("backend", "engineering");
    await execute({ kind: "deactivate", handle: "backend" });
    await execute({ kind: "activate", handle: "backend" });
    await execute({ kind: "move", handle: "backend", parentHandle: "evidence-research" });
    await execute({ kind: "change-role", handle: "backend", role: "coordinator" });
    const result = await execute({ kind: "promote", handle: "backend", role: "orchestrator" });

    const backend = result.nodes.find((node) => node.handle === "backend");
    expect(backend).toMatchObject({ parent_handle: "evidence-research", status: "active", role: "orchestrator" });
    expect(String(result.nodes.find((node) => node.handle === "engineering")?.created_at)).toBe(createdAt);
    expect(version).toBe(8);
    await expect(execute({ kind: "promote", handle: "backend", role: "operator" })).rejects.toThrow("높은 역할");
  });

  it("자기 하위로 이동하는 cycle과 잘못된 work scope를 거부한다", async () => {
    await create("engineering");
    await create("backend", "engineering");

    await expect(execute({ kind: "move", handle: "engineering", parentHandle: "backend" })).rejects.toThrow("cycle");
    await expect(
      execute({
        kind: "create",
        handle: "temporary",
        name: "Temporary",
        responsibility: "임시",
        parentHandle: "delivery-coordination",
        scope: "work",
      }),
    ).rejects.toThrow("workId");
    await expect(execute({ kind: "deactivate", handle: "engineering" })).rejects.toThrow("부모는 active");
  });

  it("split은 선택한 자식을 새 노드로 옮기고 merge는 자식을 생존 노드로 옮긴다", async () => {
    await create("engineering");
    await create("backend", "engineering");
    await create("frontend", "engineering");
    let result = await execute({
      kind: "split",
      sourceHandle: "engineering",
      newHandle: "platform",
      name: "Platform",
      responsibility: "플랫폼",
      childHandles: ["backend"],
      referencePlan: [],
    });
    expect(result.nodes.find((node) => node.handle === "backend")?.parent_handle).toBe("platform");

    result = await execute({
      kind: "merge",
      survivorHandle: "engineering",
      sourceHandle: "platform",
      referencePlan: [],
    });
    expect(result.nodes.find((node) => node.handle === "backend")?.parent_handle).toBe("engineering");
    expect(result.nodes.find((node) => node.handle === "platform")?.status).toBe("retired");
  });

  it("retire와 restore를 수행하고 과거 snapshot으로 revert해도 새 version을 만든다", async () => {
    await create("engineering");
    const createdVersion = version;
    await execute({ kind: "retire", handle: "engineering" });
    await execute({ kind: "restore", handle: "engineering" });
    await execute({ kind: "change-role", handle: "engineering", role: "coordinator" });
    const reverted = await execute({ kind: "revert", targetVersion: createdVersion });

    expect(reverted.nodes.find((node) => node.handle === "engineering")).toMatchObject({
      status: "active",
      role: "operator",
    });
    expect(Number(reverted.version.version)).toBe(6);
    expect(reverted.version.command_kind).toBe("revert");
    expect(reverted.impact.nodeHandles).toContain("engineering");
  });

  it("영향 분석에 모든 하위 노드와 등록된 참조를 포함한다", async () => {
    await create("engineering");
    await create("backend", "engineering");
    await graph.registerReference(context, "backend", "skill", "typescript");
    await graph.registerReference(context, "engineering", "work", "work-1");

    const impact = await graph.analyzeImpact(context, ["engineering"]);

    expect(impact.nodeHandles).toEqual(["backend", "engineering"]);
    expect(impact.references.map((reference) => `${reference.kind}:${reference.target_id}`).sort()).toEqual([
      "skill:typescript",
      "work:work-1",
    ]);
    await expect(graph.analyzeImpact(context, ["missing"])).rejects.toThrow("대상 노드");
  });

  it("split과 merge는 source 참조 처리 계획을 강제하고 원자 이동한다", async () => {
    await create("engineering");
    const reference = await graph.registerReference(context, "engineering", "task", "task-1");

    await expect(
      execute({
        kind: "split",
        sourceHandle: "engineering",
        newHandle: "platform",
        name: "Platform",
        responsibility: "플랫폼",
        childHandles: [],
        referencePlan: [],
      }),
    ).rejects.toThrow("참조 처리 계획");
    const split = await execute({
      kind: "split",
      sourceHandle: "engineering",
      newHandle: "platform",
      name: "Platform",
      responsibility: "플랫폼",
      childHandles: [],
      referencePlan: [{ referenceId: reference.reference_id, action: "move", targetHandle: "platform" }],
    });

    expect(split.version.version).toBe(3);
    expect((await graph.analyzeImpact(context, ["platform"])).references[0]?.target_id).toBe("task-1");
  });

  it("다른 tenant의 Context로 그래프를 읽거나 변경하지 못한다", async () => {
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const other = await identity.registerPersonalUser({ email: "other@example.com", displayName: "Other" });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );

    await expect(graph.listNodes({ ...otherContext, organizationId: context.organizationId })).rejects.toThrow(
      "TenantContext",
    );
  });

  it("준수 검사는 변형과 고아 관계를 보고하되 자동 수정하지 않는다", async () => {
    await create("engineering");
    await create("backend", "engineering");
    await database.query(
      "UPDATE organization_node SET name = 'Changed' WHERE organization_id = $organization_id AND handle = 'governance'; UPDATE organization_node SET parent_handle = 'missing' WHERE organization_id = $organization_id AND handle = 'growth'; UPDATE organization_node SET parent_handle = 'backend' WHERE organization_id = $organization_id AND handle = 'engineering';",
      { organization_id: context.organizationId },
    );

    const findings = await graph.auditCompliance(context);

    expect(findings.map((finding) => `${finding.code}:${finding.handle}`)).toEqual(
      expect.arrayContaining(["core-office:governance", "core-office:growth", "orphan:growth"]),
    );
    expect(findings.some((finding) => finding.code === "cycle" && finding.handle === "engineering")).toBe(true);
    expect((await graph.listNodes(context)).find((node) => node.handle === "governance")?.name).toBe("Changed");
  });

  it("같은 version의 동시 변경은 하나만 commit한다", async () => {
    const results = await Promise.allSettled([
      graph.execute(context, {
        commandId: crypto.randomUUID(),
        expectedVersion: 1,
        kind: "create",
        handle: "one",
        name: "One",
        responsibility: "One",
        parentHandle: "delivery-coordination",
        scope: "persistent",
      }),
      graph.execute(context, {
        commandId: crypto.randomUUID(),
        expectedVersion: 1,
        kind: "create",
        handle: "two",
        name: "Two",
        responsibility: "Two",
        parentHandle: "delivery-coordination",
        scope: "persistent",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await graph.listNodes(context)).toHaveLength(9);
  });
});
