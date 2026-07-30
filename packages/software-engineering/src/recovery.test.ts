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
  EngineeringPathLeaseOwnershipError,
  EngineeringPathLeaseStore,
  GitWorkspaceManager,
  validateUnifiedPatch,
  type DeliveryPrerequisiteReader,
  type EngineeringDeliveryStatus,
} from "./index.js";

const execFileAsync = promisify(execFile);

describe("Interrupted Engineering Delivery recovery", { timeout: 60_000 }, () => {
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
    await leases.acquire(context, {
      commandId: "wrong-root-lease",
      deliveryId: current.deliveryId,
      repositoryId: "repository-1",
      pathPrefixes: ["src"],
      ttlMs: 60_000,
    });

    await expect(
      new EngineeringDeliveryRecovery(deliveries, manager, leases, metrics).recover(context, {
        commandId: "recover-wrong-root",
        deliveryId: current.deliveryId,
        repositoryRoot: workspaceRoot,
        repositoryId: "repository-1",
        preserveLeaseCommandId: "wrong-root-lease",
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

  it("lease가 없는 non-terminal Delivery도 owner ID 없이는 상태와 workspace를 보존하고 거부한다", async () => {
    const current = await delivery("workspace-no-lease", "preparing");
    const workspace = await manager.prepare({ repositoryRoot, baseRevision, deliveryId: current.deliveryId });
    const resume = vi.fn().mockResolvedValue(undefined);

    await expect(
      new EngineeringDeliveryRecovery(deliveries, manager, leases, metrics, { resume }).recover(context, {
        commandId: "recover-workspace-no-lease",
        deliveryId: current.deliveryId,
        repositoryRoot,
        repositoryId: "repository-1",
      }),
    ).rejects.toBeInstanceOf(EngineeringPathLeaseOwnershipError);

    expect((await deliveries.get(context, current.deliveryId)).status).toBe("preparing");
    expect(await leases.list(context, "repository-1")).toEqual([]);
    expect(await access(workspace.workspacePath).then(() => true)).toBe(true);
    expect(resume).not.toHaveBeenCalled();
    await manager.remove(workspace);
  });

  it("active lease의 owner ID가 없으면 delivery·lease·workspace를 그대로 보존하고 거부한다", async () => {
    const current = await delivery("workspace-owner-missing", "preparing");
    const workspace = await manager.prepare({ repositoryRoot, baseRevision, deliveryId: current.deliveryId });
    await leases.acquire(context, {
      commandId: "workspace-owner-missing-lease",
      deliveryId: current.deliveryId,
      repositoryId: "repository-1",
      pathPrefixes: ["src"],
      ttlMs: 60_000,
    });
    const resume = vi.fn().mockResolvedValue(undefined);

    await expect(
      new EngineeringDeliveryRecovery(deliveries, manager, leases, metrics, { resume }).recover(context, {
        commandId: "recover-workspace-owner-missing",
        deliveryId: current.deliveryId,
        repositoryRoot,
        repositoryId: "repository-1",
      }),
    ).rejects.toBeInstanceOf(EngineeringPathLeaseOwnershipError);

    expect((await deliveries.get(context, current.deliveryId)).status).toBe("preparing");
    expect((await leases.list(context, "repository-1"))[0]?.status).toBe("active");
    expect(await access(workspace.workspacePath).then(() => true)).toBe(true);
    expect(resume).not.toHaveBeenCalled();
    await manager.remove(workspace);
  });

  it("expired cleanup owner는 workspace·owned reset·release 뒤 event 실패를 중복 파괴 없이 재생한다", async () => {
    const { current, workspace } = await recoverableDelivery("workspace-owner-match", "test_applied");
    const { lease } = await leases.acquire(context, {
      commandId: "workspace-owner-match-lease",
      deliveryId: current.deliveryId,
      repositoryId: "repository-1",
      pathPrefixes: ["src"],
      ttlMs: 1_000,
    });
    const other = await delivery("workspace-owner-other", "preparing");
    await leases.acquire(context, {
      commandId: "workspace-owner-other-lease",
      deliveryId: other.deliveryId,
      repositoryId: "repository-1",
      pathPrefixes: ["docs"],
      ttlMs: 60_000,
    });
    await database.query(
      "UPDATE engineering_path_lease SET status = 'expired', version = $version WHERE organization_id = $organization_id AND lease_id = $lease_id;",
      { organization_id: context.organizationId, lease_id: lease.leaseId, version: lease.version + 1 },
    );
    const calls: string[] = [];
    const removeWorkspace = manager.removeDeliveryWorkspaceIfExists.bind(manager);
    vi.spyOn(manager, "removeDeliveryWorkspaceIfExists").mockImplementation(async (input) => {
      calls.push("workspace");
      await removeWorkspace(input);
    });
    const resetForRetry = deliveries.resetForRetry.bind(deliveries);
    vi.spyOn(deliveries, "resetForRetry").mockImplementation(async (resetContext, input) => {
      calls.push("reset");
      expect(input.ownership).toEqual({ leaseId: lease.leaseId, ownerCommandId: lease.acquireCommandId });
      return await resetForRetry(resetContext, input);
    });
    const release = leases.release.bind(leases);
    const releaseSpy = vi.spyOn(leases, "release").mockImplementation(async (releaseContext, input) => {
      calls.push("release");
      expect(input).toMatchObject({
        commandId: `${current.startCommandId}:recovery-release-lease:${lease.leaseId}`,
        leaseId: lease.leaseId,
        deliveryId: current.deliveryId,
        expectedAcquireCommandId: lease.acquireCommandId,
      });
      return await release(releaseContext, input);
    });
    const recordRecoveryEvent = deliveries.recordRecoveryEvent.bind(deliveries);
    vi.spyOn(deliveries, "recordRecoveryEvent")
      .mockImplementationOnce(async () => {
        calls.push("event");
        throw new Error("event unavailable");
      })
      .mockImplementation(async (eventContext, input) => {
        calls.push("event-retry");
        await recordRecoveryEvent(eventContext, input);
      });
    const recovery = new EngineeringDeliveryRecovery(deliveries, manager, leases, metrics);
    const recoveryInput = {
      commandId: "recover-workspace-owner-match",
      deliveryId: current.deliveryId,
      repositoryRoot,
      repositoryId: "repository-1",
      cleanupLeaseCommandId: lease.acquireCommandId,
    } as const;

    await expect(recovery.recover(context, recoveryInput)).rejects.toThrow("event unavailable");

    expect(calls).toEqual(["workspace", "reset", "release", "event"]);
    expect((await deliveries.get(context, current.deliveryId)).status).toBe("preparing");
    expect(
      Object.fromEntries(
        (await leases.list(context, "repository-1")).map((candidate) => [candidate.acquireCommandId, candidate.status]),
      ),
    ).toMatchObject({
      "workspace-owner-match-lease": "released",
      "workspace-owner-other-lease": "active",
    });
    await expect(access(workspace.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(recovery.recover(context, recoveryInput)).resolves.toMatchObject({
      result: "resume_required",
      delivery: { status: "preparing" },
    });
    expect(calls).toEqual(["workspace", "reset", "release", "event", "event-retry"]);
    expect(
      Object.fromEntries(
        (await leases.list(context, "repository-1")).map((candidate) => [candidate.acquireCommandId, candidate.status]),
      ),
    ).toMatchObject({
      "workspace-owner-match-lease": "released",
      "workspace-owner-other-lease": "active",
    });
    releaseSpy.mockRestore();

    const partial = await recoverableDelivery("released-intermediate", "test_applied");
    const { lease: partialLease } = await leases.acquire(context, {
      commandId: "released-intermediate-lease",
      deliveryId: partial.current.deliveryId,
      repositoryId: "repository-1",
      pathPrefixes: ["src/intermediate"],
      ttlMs: 60_000,
    });
    await leases.release(context, {
      commandId: "released-intermediate-release",
      leaseId: partialLease.leaseId,
      deliveryId: partial.current.deliveryId,
      expectedAcquireCommandId: partialLease.acquireCommandId,
    });
    await expect(
      recovery.recover(context, {
        commandId: "recover-released-intermediate",
        deliveryId: partial.current.deliveryId,
        repositoryRoot,
        repositoryId: "repository-1",
        cleanupLeaseCommandId: partialLease.acquireCommandId,
      }),
    ).rejects.toBeInstanceOf(EngineeringPathLeaseOwnershipError);
    expect((await deliveries.get(context, partial.current.deliveryId)).status).toBe("test_applied");
    expect(await access(partial.workspace.workspacePath).then(() => true)).toBe(true);
    await manager.remove(partial.workspace);
  });

  it("불일치하는 cleanup owner는 정리를 거부한다", async () => {
    const current = await delivery("workspace-owner-mismatch", "preparing");
    const workspace = await manager.prepare({ repositoryRoot, baseRevision, deliveryId: current.deliveryId });
    await leases.acquire(context, {
      commandId: "workspace-owner-mismatch-lease",
      deliveryId: current.deliveryId,
      repositoryId: "repository-1",
      pathPrefixes: ["src"],
      ttlMs: 60_000,
    });
    const recovery = new EngineeringDeliveryRecovery(deliveries, manager, leases, metrics);

    await expect(
      recovery.recover(context, {
        commandId: "recover-workspace-owner-wrong",
        deliveryId: current.deliveryId,
        repositoryRoot,
        repositoryId: "repository-1",
        cleanupLeaseCommandId: "workspace-owner-wrong-lease",
      }),
    ).rejects.toBeInstanceOf(EngineeringPathLeaseOwnershipError);

    expect((await deliveries.get(context, current.deliveryId)).status).toBe("preparing");
    expect(
      (await leases.list(context, "repository-1")).filter((lease) => lease.deliveryId === current.deliveryId),
    ).toEqual([expect.objectContaining({ acquireCommandId: "workspace-owner-mismatch-lease", status: "active" })]);
    expect(await access(workspace.workspacePath).then(() => true)).toBe(true);
    await manager.remove(workspace);
  });

  it("RED·implementation crash 상태를 continuation에 정확히 위임한다", async () => {
    const statuses = ["test_applied", "red_verified", "implementation_applied"] as const;
    const resume = vi.fn().mockResolvedValue(undefined);
    for (const status of statuses) {
      const { current, workspace } = await recoverableDelivery(status, status);
      const ownerCommandId = `recover-${status}-lease`;
      await leases.acquire(context, {
        commandId: ownerCommandId,
        deliveryId: current.deliveryId,
        repositoryId: "repository-1",
        pathPrefixes: [`src/${status}`],
        ttlMs: 60_000,
      });
      const recovered = await new EngineeringDeliveryRecovery(deliveries, manager, leases, metrics, { resume }).recover(
        context,
        {
          commandId: `recover-${status}`,
          deliveryId: current.deliveryId,
          repositoryRoot,
          repositoryId: "repository-1",
          preserveLeaseCommandId: ownerCommandId,
        },
      );
      expect(recovered.result).toBe("resumed");
      await manager.remove(workspace);
    }
    expect(resume.mock.calls.map((call) => call[1].status)).toEqual(statuses);
  }, 60_000);

  it("resume_required rollback은 workspace를 지우되 preserve owner lease를 active로 유지한다", async () => {
    const { current, workspace } = await recoverableDelivery("preserve-retry", "test_applied");
    const ownerCommandId = "preserve-retry-lease";
    await leases.acquire(context, {
      commandId: ownerCommandId,
      deliveryId: current.deliveryId,
      repositoryId: "repository-1",
      pathPrefixes: ["src"],
      ttlMs: 60_000,
    });

    const recovered = await new EngineeringDeliveryRecovery(deliveries, manager, leases, metrics).recover(context, {
      commandId: "recover-preserve-retry",
      deliveryId: current.deliveryId,
      repositoryRoot,
      repositoryId: "repository-1",
      preserveLeaseCommandId: ownerCommandId,
    });

    expect(recovered).toMatchObject({ result: "resume_required", delivery: { status: "preparing" } });
    expect(
      (await leases.list(context, "repository-1")).find((lease) => lease.deliveryId === current.deliveryId),
    ).toMatchObject({ acquireCommandId: ownerCommandId, status: "active" });
    await expect(access(workspace.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("expired preserve owner는 workspace와 Delivery를 바꾸기 전에 거부한다", async () => {
    const { current, workspace } = await recoverableDelivery("preserve-expired", "test_applied");
    const ownerCommandId = "preserve-expired-lease";
    const { lease } = await leases.acquire(context, {
      commandId: ownerCommandId,
      deliveryId: current.deliveryId,
      repositoryId: "repository-1",
      pathPrefixes: ["src/expired"],
      ttlMs: 1_000,
    });
    await database.query(
      "UPDATE engineering_path_lease SET status = 'expired', version = $version WHERE organization_id = $organization_id AND lease_id = $lease_id;",
      { organization_id: context.organizationId, lease_id: lease.leaseId, version: lease.version + 1 },
    );
    const removeWorkspace = vi.spyOn(manager, "removeDeliveryWorkspaceIfExists");
    const resetForRetry = vi.spyOn(deliveries, "resetForRetry");

    await expect(
      new EngineeringDeliveryRecovery(deliveries, manager, leases, metrics).recover(context, {
        commandId: "recover-preserve-expired",
        deliveryId: current.deliveryId,
        repositoryRoot,
        repositoryId: "repository-1",
        preserveLeaseCommandId: ownerCommandId,
      }),
    ).rejects.toBeInstanceOf(EngineeringPathLeaseOwnershipError);

    expect(removeWorkspace).not.toHaveBeenCalled();
    expect(resetForRetry).not.toHaveBeenCalled();
    expect((await deliveries.get(context, current.deliveryId)).status).toBe("test_applied");
    expect(await access(workspace.workspacePath).then(() => true)).toBe(true);
    await manager.remove(workspace);
  });

  it("진행 중 만료된 preserve owner는 rollback 직전 workspace와 Delivery를 보존하고 거부한다", async () => {
    const { current, workspace } = await recoverableDelivery("preserve-elapsed", "test_applied");
    const ownerCommandId = "preserve-elapsed-lease";
    const { lease } = await leases.acquire(context, {
      commandId: ownerCommandId,
      deliveryId: current.deliveryId,
      repositoryId: "repository-1",
      pathPrefixes: ["src/elapsed"],
      ttlMs: 1_000,
    });
    const inspectWorkspace = manager.inspectDeliveryWorkspace.bind(manager);
    vi.spyOn(manager, "inspectDeliveryWorkspace").mockImplementationOnce(async (input) => {
      const snapshot = await inspectWorkspace(input);
      await database.query(
        "UPDATE engineering_path_lease SET expires_at = type::datetime($expires_at) WHERE organization_id = $organization_id AND lease_id = $lease_id;",
        {
          organization_id: context.organizationId,
          lease_id: lease.leaseId,
          expires_at: new Date(Date.now() - 1_000).toISOString(),
        },
      );
      return snapshot;
    });
    const removeWorkspace = vi.spyOn(manager, "removeDeliveryWorkspaceIfExists");
    const resetForRetry = vi.spyOn(deliveries, "resetForRetry");

    await expect(
      new EngineeringDeliveryRecovery(deliveries, manager, leases, metrics).recover(context, {
        commandId: "recover-preserve-elapsed",
        deliveryId: current.deliveryId,
        repositoryRoot,
        repositoryId: "repository-1",
        preserveLeaseCommandId: ownerCommandId,
      }),
    ).rejects.toBeInstanceOf(EngineeringPathLeaseOwnershipError);

    expect(removeWorkspace).not.toHaveBeenCalled();
    expect(resetForRetry).not.toHaveBeenCalled();
    expect((await deliveries.get(context, current.deliveryId)).status).toBe("test_applied");
    expect(await access(workspace.workspacePath).then(() => true)).toBe(true);
    await manager.remove(workspace);
  });

  it("resetForRetry는 active·expired 단일 owner만 허용하고 0·복수·불일치를 거부한다", async () => {
    const noActive = await delivery("retry-owner-none", "test_applied");
    await expect(
      deliveries.resetForRetry(context, {
        commandId: "retry-owner-boundary-no-active",
        deliveryId: noActive.deliveryId,
        expectedVersion: noActive.version,
        ownership: { leaseId: "missing-lease", ownerCommandId: "missing-owner" },
      }),
    ).rejects.toThrow("active path lease가 있는 Delivery는 rollback할 수 없습니다");

    const active = await delivery("retry-owner-active", "test_applied");
    const { lease: activeLease } = await leases.acquire(context, {
      commandId: "retry-owner-boundary-lease",
      deliveryId: active.deliveryId,
      repositoryId: "repository-1",
      pathPrefixes: ["src/active"],
      ttlMs: 60_000,
    });
    const rejectedOwnerships = [
      { leaseId: "wrong-lease", ownerCommandId: activeLease.acquireCommandId },
      { leaseId: activeLease.leaseId, ownerCommandId: "wrong-owner" },
    ] as const;

    for (const [index, ownership] of rejectedOwnerships.entries()) {
      await expect(
        deliveries.resetForRetry(context, {
          commandId: `retry-owner-boundary-rejected-${index}`,
          deliveryId: active.deliveryId,
          expectedVersion: active.version,
          ownership,
        }),
      ).rejects.toThrow("active path lease가 있는 Delivery는 rollback할 수 없습니다");
    }

    await expect(
      deliveries.resetForRetry(context, {
        commandId: "retry-owner-boundary-accepted",
        deliveryId: active.deliveryId,
        expectedVersion: active.version,
        ownership: { leaseId: activeLease.leaseId, ownerCommandId: activeLease.acquireCommandId },
      }),
    ).resolves.toMatchObject({ delivery: { status: "preparing" } });
    expect(
      (await leases.list(context, "repository-1")).find((candidate) => candidate.leaseId === activeLease.leaseId),
    ).toMatchObject({ status: "active" });

    const expired = await delivery("retry-owner-expired", "test_applied");
    const { lease: expiredLease } = await leases.acquire(context, {
      commandId: "retry-owner-expired-lease",
      deliveryId: expired.deliveryId,
      repositoryId: "repository-1",
      pathPrefixes: ["src/expired"],
      ttlMs: 1_000,
    });
    await database.query(
      "UPDATE engineering_path_lease SET status = 'expired', version = $version WHERE organization_id = $organization_id AND lease_id = $lease_id;",
      {
        organization_id: context.organizationId,
        lease_id: expiredLease.leaseId,
        version: expiredLease.version + 1,
      },
    );
    expect(
      (await leases.list(context, "repository-1")).find((candidate) => candidate.leaseId === expiredLease.leaseId),
    ).toMatchObject({ status: "expired" });
    await expect(
      deliveries.resetForRetry(context, {
        commandId: "retry-owner-expired-accepted",
        deliveryId: expired.deliveryId,
        expectedVersion: expired.version,
        ownership: { leaseId: expiredLease.leaseId, ownerCommandId: expiredLease.acquireCommandId },
      }),
    ).resolves.toMatchObject({ delivery: { status: "preparing" } });

    const multiple = await delivery("retry-owner-multiple", "test_applied");
    await database.query("REMOVE INDEX engineering_path_lease_delivery ON engineering_path_lease;");
    const { lease: firstLease } = await leases.acquire(context, {
      commandId: "retry-owner-multiple-first",
      deliveryId: multiple.deliveryId,
      repositoryId: "repository-1",
      pathPrefixes: ["src/multiple-first"],
      ttlMs: 60_000,
    });
    await leases.acquire(context, {
      commandId: "retry-owner-multiple-second",
      deliveryId: multiple.deliveryId,
      repositoryId: "repository-1",
      pathPrefixes: ["src/multiple-second"],
      ttlMs: 60_000,
    });
    await expect(
      deliveries.resetForRetry(context, {
        commandId: "retry-owner-multiple-rejected",
        deliveryId: multiple.deliveryId,
        expectedVersion: multiple.version,
        ownership: { leaseId: firstLease.leaseId, ownerCommandId: firstLease.acquireCommandId },
      }),
    ).rejects.toThrow("active path lease가 있는 Delivery는 rollback할 수 없습니다");
  });

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
    await leases.acquire(context, {
      commandId: "mismatch-lease",
      deliveryId: current.deliveryId,
      repositoryId: "repository-1",
      pathPrefixes: ["src"],
      ttlMs: 60_000,
    });
    const resume = vi.fn().mockResolvedValue(undefined);

    const recovered = await new EngineeringDeliveryRecovery(deliveries, manager, leases, metrics, { resume }).recover(
      context,
      {
        commandId: "recover-mismatch",
        deliveryId: current.deliveryId,
        repositoryRoot,
        repositoryId: "repository-1",
        cleanupLeaseCommandId: "mismatch-lease",
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
        cleanupLeaseCommandId: "continuation-terminal-lease",
      },
    );

    expect(recovered).toMatchObject({ result: "resumed", delivery: { status: "failed" } });
    expect((await leases.list(context, "repository-1"))[0]?.status).toBe("released");
    await expect(access(workspace.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

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
      cleanupLeaseCommandId: "commit-lease",
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
      cleanupLeaseCommandId: "commit-lease",
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
  }, 60_000);

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
    await leases.acquire(context, {
      commandId: "branch-mismatch-lease",
      deliveryId: current.deliveryId,
      repositoryId: "repository-1",
      pathPrefixes: ["src"],
      ttlMs: 60_000,
    });

    const recovered = await new EngineeringDeliveryRecovery(deliveries, manager, leases, metrics).recover(context, {
      commandId: "recover-branch-mismatch",
      deliveryId: current.deliveryId,
      repositoryRoot,
      repositoryId: "repository-1",
      cleanupLeaseCommandId: "branch-mismatch-lease",
    });

    expect(recovered).toMatchObject({ result: "cleaned_terminal", delivery: { status: "failed" } });
    expect(recovered.delivery.error?.category).toBe("recovery_branch_mismatch");
    await expect(access(staged.workspace.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

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
      cleanupLeaseCommandId: "branch-parent-lease",
    });

    expect(recovered).toMatchObject({ result: "cleaned_terminal", delivery: { status: "failed" } });
    expect(recovered.delivery.error?.category).toBe("recovery_branch_invalid");
    expect((await leases.list(context, "repository-1"))[0]?.status).toBe("released");
    await expect(access(staged.workspace.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

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
        cleanupLeaseCommandId: `${terminal}-lease`,
      });
      expect(recovered.result).toBe("cleaned_terminal");
      expect((await leases.list(context, "repository-1"))[0]?.status).toBe("released");
      await expect(access(workspace.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
