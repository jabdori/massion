import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import {
  EngineeringDeliveryRecovery,
  EngineeringDeliveryStore,
  EngineeringMetricStore,
  EngineeringPathLeaseStore,
  GitWorkspaceManager,
  validateUnifiedPatch,
  type DeliveryPrerequisiteReader,
  type EngineeringDeliveryStatus,
} from "./index.js";

const execFileAsync = promisify(execFile);

describe("Interrupted Engineering Delivery recovery", () => {
  let root: string;
  let repositoryRoot: string;
  let workspaceRoot: string;
  let baseRevision: string;
  let database: MassionDatabase;
  let context: TenantContext;
  let deliveries: EngineeringDeliveryStore;
  let leases: EngineeringPathLeaseStore;
  let manager: GitWorkspaceManager;
  let metrics: EngineeringMetricStore;

  async function git(args: readonly string[], cwd = repositoryRoot): Promise<string> {
    const result = await execFileAsync("git", [...args], { cwd, encoding: "utf8" });
    return result.stdout.trim();
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "massion-recovery-"));
    repositoryRoot = join(root, "repository");
    workspaceRoot = join(root, "workspaces");
    await mkdir(join(repositoryRoot, "src"), { recursive: true });
    await mkdir(workspaceRoot);
    await git(["init", "--initial-branch=main"]);
    await git(["config", "user.name", "Test User"]);
    await git(["config", "user.email", "test@example.com"]);
    await writeFile(join(repositoryRoot, "src/value.ts"), "export const value = 1;\n");
    await git(["add", "."]);
    await git(["commit", "-m", "initial"]);
    baseRevision = await git(["rev-parse", "HEAD"]);
    const repositoryRootRealPathHash = createHash("sha256")
      .update(await realpath(repositoryRoot))
      .digest("hex");

    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "recovery@example.com", displayName: "Recovery" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const prerequisites: DeliveryPrerequisiteReader = {
      getWork: async (_context, workId) => ({ organizationId: context.organizationId, workId, status: "running" }),
      getTask: async (_context, workId, taskId) => ({
        organizationId: context.organizationId,
        workId,
        taskId,
        status: "running",
      }),
      getAssignment: async (_context, workId, assignmentId) => ({
        organizationId: context.organizationId,
        workId,
        taskId: assignmentId.replace("assignment", "task"),
        assignmentId,
        agentHandle: "software-engineering.backend-specialist",
        status: "assigned",
      }),
      getRepository: async () => ({
        organizationId: context.organizationId,
        repositoryId: "repository-1",
        status: "active",
        rootRealPathHash: repositoryRootRealPathHash,
      }),
      getRepositoryRevision: async () => ({
        organizationId: context.organizationId,
        repositoryId: "repository-1",
        repositoryRevisionId: "revision-1",
        providerRevision: baseRevision,
        dirty: false,
        rootRealPathHash: repositoryRootRealPathHash,
      }),
    };
    deliveries = await EngineeringDeliveryStore.create(database, organizations, prerequisites);
    leases = await EngineeringPathLeaseStore.create(database, organizations);
    manager = await GitWorkspaceManager.create({ workspaceRoot });
    metrics = await EngineeringMetricStore.create(database, organizations);
  });

  it("등록 repository와 다른 실제 root 경로는 delivery 상태를 바꾸기 전에 거부한다", async () => {
    const { current, workspace } = await recoverableDelivery("wrong-root", "test_applied");

    await expect(
      new EngineeringDeliveryRecovery(deliveries, manager, leases, metrics).recover(context, {
        commandId: "recover-wrong-root",
        deliveryId: current.deliveryId,
        repositoryRoot: workspaceRoot,
        repositoryId: "repository-1",
      }),
    ).rejects.toThrow("root real path hash");
    expect((await deliveries.get(context, current.deliveryId)).status).toBe("test_applied");
    expect(await access(workspace.workspacePath).then(() => true)).toBe(true);
    await manager.remove(workspace);
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { recursive: true, force: true });
  });

  async function delivery(suffix: string, target: EngineeringDeliveryStatus) {
    let current = (
      await deliveries.start(context, {
        commandId: `start-${suffix}`,
        workId: `work-${suffix}`,
        taskId: `task-${suffix}`,
        assignmentId: `assignment-${suffix}`,
        repositoryId: "repository-1",
        repositoryRevisionId: "revision-1",
        baseRevision,
        agentHandle: "software-engineering.backend-specialist",
        profileVersion: "1.0.0",
      })
    ).delivery;
    const steps = [
      ["test_applied", { testPatchHash: "1".repeat(64) }],
      ["red_verified", { redEvidenceId: "red" }],
      ["implementation_applied", { implementationPatchHash: "2".repeat(64) }],
      ["green_verified", { greenEvidenceId: "green" }],
    ] as const;
    for (const [status, extra] of steps) {
      if (current.status === target) break;
      current = (
        await deliveries.transition(context, {
          commandId: `${suffix}-${status}`,
          deliveryId: current.deliveryId,
          expectedVersion: current.version,
          target: status,
          ...extra,
        })
      ).delivery;
    }
    return current;
  }

  async function recoverableDelivery(
    suffix: string,
    target: "test_applied" | "red_verified" | "implementation_applied",
  ) {
    let current = await delivery(suffix, "preparing");
    const workspace = await manager.prepare({ repositoryRoot, baseRevision, deliveryId: current.deliveryId });
    const testApplied = await manager.applyPatch(
      workspace,
      validateUnifiedPatch(
        `diff --git a/src/value.ts b/src/value.ts
--- a/src/value.ts
+++ b/src/value.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 99;
`,
        { allowedPaths: ["src"] },
      ),
    );
    current = (
      await deliveries.transition(context, {
        commandId: `${suffix}-test-applied-real`,
        deliveryId: current.deliveryId,
        expectedVersion: current.version,
        target: "test_applied",
        workspaceId: current.deliveryId,
        testPatchHash: testApplied.changeSetHash,
      })
    ).delivery;
    if (target === "test_applied") return { current, workspace };
    current = (
      await deliveries.transition(context, {
        commandId: `${suffix}-red-verified-real`,
        deliveryId: current.deliveryId,
        expectedVersion: current.version,
        target: "red_verified",
        redEvidenceId: "red",
      })
    ).delivery;
    if (target === "red_verified") return { current, workspace };
    const implementationApplied = await manager.applyPatch(
      workspace,
      validateUnifiedPatch(
        `diff --git a/src/value.ts b/src/value.ts
--- a/src/value.ts
+++ b/src/value.ts
@@ -1 +1 @@
-export const value = 99;
+export const value = 2;
`,
        { allowedPaths: ["src"] },
      ),
    );
    current = (
      await deliveries.transition(context, {
        commandId: `${suffix}-implementation-applied-real`,
        deliveryId: current.deliveryId,
        expectedVersion: current.version,
        target: "implementation_applied",
        implementationPatchHash: implementationApplied.changeSetHash,
      })
    ).delivery;
    return { current, workspace };
  }

  it("workspace 생성 직후 crash는 delivery를 실패 처리하고 workspace·lease를 정리한다", async () => {
    const current = await delivery("workspace", "preparing");
    const workspace = await manager.prepare({ repositoryRoot, baseRevision, deliveryId: current.deliveryId });
    await leases.acquire(context, {
      commandId: "workspace-lease",
      deliveryId: current.deliveryId,
      repositoryId: "repository-1",
      pathPrefixes: ["src"],
      ttlMs: 60_000,
    });
    const resume = vi.fn().mockResolvedValue(undefined);
    const recovered = await new EngineeringDeliveryRecovery(deliveries, manager, leases, metrics, { resume }).recover(
      context,
      {
        commandId: "recover-workspace",
        deliveryId: current.deliveryId,
        repositoryRoot,
        repositoryId: "repository-1",
      },
    );

    expect(recovered).toMatchObject({ result: "cleaned_terminal", delivery: { status: "failed" } });
    expect(recovered.delivery.error?.category).toBe("recovery_preparing_interrupted");
    expect(resume).not.toHaveBeenCalled();
    expect((await leases.list(context, "repository-1"))[0]?.status).toBe("released");
    await expect(access(workspace.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("RED·implementation crash 상태를 continuation에 정확히 위임한다", async () => {
    const statuses = ["test_applied", "red_verified", "implementation_applied"] as const;
    const resume = vi.fn().mockResolvedValue(undefined);
    for (const status of statuses) {
      const { current, workspace } = await recoverableDelivery(status, status);
      const recovered = await new EngineeringDeliveryRecovery(deliveries, manager, leases, metrics, { resume }).recover(
        context,
        {
          commandId: `recover-${status}`,
          deliveryId: current.deliveryId,
          repositoryRoot,
          repositoryId: "repository-1",
        },
      );
      expect(recovered.result).toBe("resumed");
      await manager.remove(workspace);
    }
    expect(resume.mock.calls.map((call) => call[1].status)).toEqual(statuses);
  }, 20_000);

  it("저장된 test patch hash와 staged diff가 다르면 재개하지 않고 실패 처리한다", async () => {
    const current = await delivery("mismatch", "test_applied");
    const workspace = await manager.prepare({ repositoryRoot, baseRevision, deliveryId: current.deliveryId });
    await manager.applyPatch(
      workspace,
      validateUnifiedPatch(
        `diff --git a/src/value.ts b/src/value.ts
--- a/src/value.ts
+++ b/src/value.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 99;
`,
        { allowedPaths: ["src"] },
      ),
    );
    const resume = vi.fn().mockResolvedValue(undefined);

    const recovered = await new EngineeringDeliveryRecovery(deliveries, manager, leases, metrics, { resume }).recover(
      context,
      {
        commandId: "recover-mismatch",
        deliveryId: current.deliveryId,
        repositoryRoot,
        repositoryId: "repository-1",
      },
    );

    expect(recovered).toMatchObject({ result: "cleaned_terminal", delivery: { status: "failed" } });
    expect(recovered.delivery.error?.category).toBe("recovery_workspace_mismatch");
    expect(resume).not.toHaveBeenCalled();
    await expect(access(workspace.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("continuation이 terminal 상태로 전이하면 최신 delivery를 반환하고 workspace·lease를 정리한다", async () => {
    const { current, workspace } = await recoverableDelivery("continuation-terminal", "implementation_applied");
    await leases.acquire(context, {
      commandId: "continuation-terminal-lease",
      deliveryId: current.deliveryId,
      repositoryId: "repository-1",
      pathPrefixes: ["src"],
      ttlMs: 60_000,
    });
    const resume = vi.fn(async (_context: TenantContext, resumed: typeof current) => {
      await deliveries.transition(context, {
        commandId: "continuation-terminal-failed",
        deliveryId: resumed.deliveryId,
        expectedVersion: resumed.version,
        target: "failed",
        error: { category: "continuation_failed", causeId: "c".repeat(64) },
      });
    });

    const recovered = await new EngineeringDeliveryRecovery(deliveries, manager, leases, metrics, { resume }).recover(
      context,
      {
        commandId: "recover-continuation-terminal",
        deliveryId: current.deliveryId,
        repositoryRoot,
        repositoryId: "repository-1",
      },
    );

    expect(recovered).toMatchObject({ result: "resumed", delivery: { status: "failed" } });
    expect((await leases.list(context, "repository-1"))[0]?.status).toBe("released");
    await expect(access(workspace.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("commit 직후 DB crash를 branch parent·changeSet 검증으로 committed 조정한다", async () => {
    const staged = await recoverableDelivery("commit", "implementation_applied");
    const current = (
      await deliveries.transition(context, {
        commandId: "commit-green-real",
        deliveryId: staged.current.deliveryId,
        expectedVersion: staged.current.version,
        target: "green_verified",
        greenEvidenceId: "green",
      })
    ).delivery;
    const commit = await manager.commit(staged.workspace, {
      message: "feat: recover",
      expectedPaths: ["src/value.ts"],
    });
    await leases.acquire(context, {
      commandId: "commit-lease",
      deliveryId: current.deliveryId,
      repositoryId: "repository-1",
      pathPrefixes: ["src"],
      ttlMs: 60_000,
    });

    const recovered = await new EngineeringDeliveryRecovery(deliveries, manager, leases, metrics).recover(context, {
      commandId: "recover-commit",
      deliveryId: current.deliveryId,
      repositoryRoot,
      repositoryId: "repository-1",
    });
    expect(recovered).toMatchObject({
      result: "reconciled_commit",
      delivery: {
        status: "committed",
        branchRef: commit.branchRef,
        commitSha: commit.commitSha,
        changeSetHash: commit.changeSetHash,
      },
    });
    expect(recovered.delivery.validationEvidenceIds).toEqual([]);
    expect(await deliveries.listFileChanges(context, current.deliveryId)).toHaveLength(1);
    expect((await leases.list(context, "repository-1"))[0]?.status).toBe("released");
    await expect(access(staged.workspace.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });

    const replayed = await new EngineeringDeliveryRecovery(deliveries, manager, leases, metrics).recover(context, {
      commandId: "recover-commit",
      deliveryId: current.deliveryId,
      repositoryRoot,
      repositoryId: "repository-1",
    });
    expect(replayed).toMatchObject({ result: "reconciled_commit", delivery: { status: "committed" } });
    expect(await metrics.aggregate(context)).toContainEqual({
      name: "engineering_recovery_total",
      dimensions: { result: "reconciled_commit" },
      value: 1,
    });
    const [recoveryEvents] = await database.query<[{ event_type: string; command_id: string }[]]>(
      "SELECT event_type, command_id FROM engineering_delivery_event WHERE organization_id = $organization_id AND delivery_id = $delivery_id AND event_type = 'engineering_delivery_recovered';",
      { organization_id: context.organizationId, delivery_id: current.deliveryId },
    );
    expect(recoveryEvents).toEqual([{ event_type: "engineering_delivery_recovered", command_id: "recover-commit" }]);
  }, 20_000);

  it("deterministic branch의 tree가 저장된 implementation change set과 다르면 실패 처리한다", async () => {
    const staged = await recoverableDelivery("branch-mismatch", "implementation_applied");
    const current = (
      await deliveries.transition(context, {
        commandId: "branch-mismatch-green",
        deliveryId: staged.current.deliveryId,
        expectedVersion: staged.current.version,
        target: "green_verified",
        greenEvidenceId: "green",
      })
    ).delivery;
    await writeFile(join(staged.workspace.workspacePath, "src/value.ts"), "export const value = 3;\n");
    await git(["add", "src/value.ts"], staged.workspace.workspacePath);
    await git(["switch", "--create", `massion/${current.deliveryId}`], staged.workspace.workspacePath);
    await git(["commit", "--no-verify", "-m", "tampered"], staged.workspace.workspacePath);

    const recovered = await new EngineeringDeliveryRecovery(deliveries, manager, leases, metrics).recover(context, {
      commandId: "recover-branch-mismatch",
      deliveryId: current.deliveryId,
      repositoryRoot,
      repositoryId: "repository-1",
    });

    expect(recovered).toMatchObject({ result: "cleaned_terminal", delivery: { status: "failed" } });
    expect(recovered.delivery.error?.category).toBe("recovery_branch_mismatch");
    await expect(access(staged.workspace.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("deterministic branch의 parent 계보가 잘못되면 실패 처리하고 workspace·lease를 정리한다", async () => {
    const staged = await recoverableDelivery("branch-parent", "implementation_applied");
    const current = (
      await deliveries.transition(context, {
        commandId: "branch-parent-green",
        deliveryId: staged.current.deliveryId,
        expectedVersion: staged.current.version,
        target: "green_verified",
        greenEvidenceId: "green",
      })
    ).delivery;
    await git(["switch", "--create", `massion/${current.deliveryId}`], staged.workspace.workspacePath);
    await git(["commit", "--no-verify", "-m", "first"], staged.workspace.workspacePath);
    await writeFile(join(staged.workspace.workspacePath, "src/extra.ts"), "export const extra = true;\n");
    await git(["add", "src/extra.ts"], staged.workspace.workspacePath);
    await git(["commit", "--no-verify", "-m", "second"], staged.workspace.workspacePath);
    await leases.acquire(context, {
      commandId: "branch-parent-lease",
      deliveryId: current.deliveryId,
      repositoryId: "repository-1",
      pathPrefixes: ["src"],
      ttlMs: 60_000,
    });

    const recovered = await new EngineeringDeliveryRecovery(deliveries, manager, leases, metrics).recover(context, {
      commandId: "recover-branch-parent",
      deliveryId: current.deliveryId,
      repositoryRoot,
      repositoryId: "repository-1",
    });

    expect(recovered).toMatchObject({ result: "cleaned_terminal", delivery: { status: "failed" } });
    expect(recovered.delivery.error?.category).toBe("recovery_branch_invalid");
    expect((await leases.list(context, "repository-1"))[0]?.status).toBe("released");
    await expect(access(staged.workspace.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it.each(["failed", "cancelled"] as const)(
    "%s terminal recovery가 남은 workspace와 active lease를 누수하지 않는다",
    async (terminal) => {
      let current = await delivery(terminal, "preparing");
      const workspace = await manager.prepare({ repositoryRoot, baseRevision, deliveryId: current.deliveryId });
      await leases.acquire(context, {
        commandId: `${terminal}-lease`,
        deliveryId: current.deliveryId,
        repositoryId: "repository-1",
        pathPrefixes: ["src"],
        ttlMs: 60_000,
      });
      current = (
        await deliveries.transition(context, {
          commandId: `${terminal}-terminal`,
          deliveryId: current.deliveryId,
          expectedVersion: current.version,
          target: terminal,
          ...(terminal === "failed" ? { error: { category: "interrupted", causeId: "f".repeat(64) } } : {}),
        })
      ).delivery;
      const recovered = await new EngineeringDeliveryRecovery(deliveries, manager, leases, metrics).recover(context, {
        commandId: `recover-${terminal}`,
        deliveryId: current.deliveryId,
        repositoryRoot,
        repositoryId: "repository-1",
      });
      expect(recovered.result).toBe("cleaned_terminal");
      expect((await leases.list(context, "repository-1"))[0]?.status).toBe("released");
      await expect(access(workspace.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
