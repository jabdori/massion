import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { IdentityService, OrganizationService, type PersonalRegistration, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { WorkspaceService } from "./workspace.js";

describe("Workspace 등록·신뢰·tenant 격리", () => {
  let database: MassionDatabase;
  let identity: IdentityService;
  let organizations: OrganizationService;
  let workspaces: WorkspaceService;
  let owner: PersonalRegistration;
  let ownerContext: TenantContext;
  let temporaryRoot: string;

  async function directory(name: string): Promise<string> {
    const path = join(temporaryRoot, name);
    await mkdir(path);
    return path;
  }

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    workspaces = await WorkspaceService.create(database, organizations);
    owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    ownerContext = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    temporaryRoot = await mkdtemp(join(tmpdir(), "massion-workspace-"));
  });

  afterEach(async () => {
    await database.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("절대 경로를 pending 신뢰 상태로 등록하고 디렉토리 이름을 기본 이름으로 쓴다", async () => {
    const path = await directory("shop-api");
    const workspace = await workspaces.register(ownerContext, { path });

    expect(workspace.workspaceId).toBeTruthy();
    expect(workspace.path).toBe(await realpath(path));
    expect(workspace.name).toBe("shop-api");
    expect(workspace.kind).toBe("local-directory");
    expect(workspace.trust).toBe("pending");
    expect(workspace.status).toBe("active");
    expect(workspace.revision).toBe(0);
  });

  it("같은 경로를 다시 등록하면 새로 만들지 않고 기존 Workspace를 반환한다", async () => {
    const path = await directory("shop-api");
    const first = await workspaces.register(ownerContext, { path });
    const second = await workspaces.register(ownerContext, { path: `${path}/` });

    expect(second.workspaceId).toBe(first.workspaceId);
    expect(await workspaces.list(ownerContext)).toHaveLength(1);
  });

  it("Workspace 단건 조회는 전달된 transaction executor를 사용한다", async () => {
    const workspace = await workspaces.register(ownerContext, { path: await directory("transaction-project") });
    const queries: string[] = [];
    const executor: QueryExecutor = {
      query: async <R>(surql: string, bindings?: Record<string, unknown>) => {
        queries.push(surql);
        return await database.query<R>(surql, bindings);
      },
    };

    await expect(workspaces.get(ownerContext, workspace.workspaceId, executor)).resolves.toEqual(workspace);
    expect(queries).toHaveLength(2);
    expect(queries.some((query) => query.includes("FROM workspace"))).toBe(true);
  });

  it("상대 경로와 상위 참조 경로를 거부한다", async () => {
    await expect(workspaces.register(ownerContext, { path: "projects/shop-api" })).rejects.toThrow(
      "Workspace 경로는 절대 경로여야 합니다",
    );
    await expect(workspaces.register(ownerContext, { path: "/home/owner/../etc" })).rejects.toThrow(
      "Workspace 경로에 상위 디렉토리 참조를 쓸 수 없습니다",
    );
  });

  it.each([
    [
      "일반 파일",
      async () => {
        const path = join(temporaryRoot, "notes.txt");
        await writeFile(path, "notes");
        return path;
      },
    ],
    [
      "외부 디렉터리를 가리키는 symlink",
      async () => {
        const target = await directory("external");
        const path = join(temporaryRoot, "linked");
        await symlink(target, path);
        return path;
      },
    ],
  ])("%s는 workspace로 등록하지 않는다", async (_label, createPath) => {
    await expect(workspaces.register(ownerContext, { path: await createPath() })).rejects.toThrow(
      "Workspace 경로는 실제 디렉터리여야 합니다",
    );
  });

  it("expectedRevision이 일치할 때만 신뢰를 결정하고 revision을 올린다", async () => {
    const workspace = await workspaces.register(ownerContext, { path: await directory("shop-api") });

    const trusted = await workspaces.decideTrust(ownerContext, {
      workspaceId: workspace.workspaceId,
      decision: "trusted",
      expectedRevision: workspace.revision,
    });
    expect(trusted.trust).toBe("trusted");
    expect(trusted.revision).toBe(workspace.revision + 1);

    await expect(
      workspaces.decideTrust(ownerContext, {
        workspaceId: workspace.workspaceId,
        decision: "blocked",
        expectedRevision: workspace.revision,
      }),
    ).rejects.toThrow("Workspace revision이 일치하지 않습니다");
  });

  it("다른 조직의 TenantContext는 Workspace를 보거나 신뢰를 결정할 수 없다", async () => {
    const other = await identity.registerPersonalUser({ email: "other@example.com", displayName: "Other" });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );
    const workspace = await workspaces.register(ownerContext, { path: await directory("shop-api") });

    expect(await workspaces.list(otherContext)).toHaveLength(0);
    await expect(workspaces.get(otherContext, workspace.workspaceId)).rejects.toThrow("Workspace를 찾을 수 없습니다");
    await expect(
      workspaces.decideTrust(otherContext, {
        workspaceId: workspace.workspaceId,
        decision: "trusted",
        expectedRevision: workspace.revision,
      }),
    ).rejects.toThrow("Workspace를 찾을 수 없습니다");
  });

  it("touch는 last_used_at을 갱신하고 list는 최근 사용 순으로 반환한다", async () => {
    const first = await workspaces.register(ownerContext, { path: await directory("shop-api") });
    const second = await workspaces.register(ownerContext, { path: await directory("mobile-app") });

    await workspaces.touch(ownerContext, first.workspaceId);
    const listed = await workspaces.list(ownerContext);

    expect(listed.map((workspace) => workspace.workspaceId)).toEqual([first.workspaceId, second.workspaceId]);
  });

  it("archive된 Workspace는 목록에서 제외되고 같은 경로 재등록 시 다시 활성화된다", async () => {
    const path = await directory("shop-api");
    const workspace = await workspaces.register(ownerContext, { path });

    const archived = await workspaces.archive(ownerContext, {
      workspaceId: workspace.workspaceId,
      expectedRevision: workspace.revision,
    });
    expect(archived.status).toBe("archived");
    expect(await workspaces.list(ownerContext)).toHaveLength(0);

    const revived = await workspaces.register(ownerContext, { path });
    expect(revived.workspaceId).toBe(workspace.workspaceId);
    expect(revived.status).toBe("active");
    expect(revived.trust).toBe("pending");
  });
});
