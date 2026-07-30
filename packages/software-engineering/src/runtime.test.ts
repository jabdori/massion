import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import type { StructuredAgentRunner } from "@massion/runtime";
import { createDatabase } from "@massion/storage";

import type { EngineeringDelivery } from "./contracts.js";
import { EngineeringDeliveryStore } from "./delivery-store.js";
import { EngineeringPathLeaseOwnershipError, EngineeringPathLeaseStore } from "./path-lease.js";
import { EngineeringDeliveryRecovery } from "./recovery.js";
import { SoftwarePatchProposalService } from "./runtime.js";
import { TddDeliveryEngine } from "./tdd-delivery.js";

describe("AgentRunner patch proposal 경계", () => {
  const context = { organizationId: "organization-1", userId: "user-1", role: "owner" } as TenantContext;

  it("Structured AgentRunner에는 proposal만 요청하고 filesystem side effect를 노출하지 않는다", async () => {
    const proposal = {
      testPatch: "diff --git a/test.ts b/test.ts\n",
      implementationPatch: "diff --git a/src.ts b/src.ts\n",
      focusedCommand: {
        executable: "node",
        args: ["test.ts"],
        cwd: ".",
        timeoutMs: 1_000,
        maxOutputBytes: 2_048,
        environment: {},
      },
      redFailureMarker: "EXPECTED_FAILURE",
      validationCommands: [],
      commitMessage: "feat: proposal",
    };
    const knowledgeSources = [
      {
        evidenceBriefId: "brief-1",
        indexVersionId: "index-1",
        briefChecksum: "a".repeat(64),
        snippets: [{ citation: "src/runtime.ts:1-1", content: "export const runtime = true;" }],
        estimatedTokens: 8,
      },
    ];
    const executeStructured = vi.fn().mockResolvedValue({
      executionId: "execution-1",
      status: "succeeded",
      output: proposal,
    });
    const runner = { executeStructured } as unknown as StructuredAgentRunner;
    const service = new SoftwarePatchProposalService(runner);
    await expect(
      service.propose(context, {
        commandId: "proposal-1",
        workId: "work-1",
        taskId: "task-1",
        agentHandle: "software-engineering.backend-specialist",
        modelRoute: "coding-balanced",
        correlationId: "delivery-1",
        estimatedTokens: 4_000,
        estimatedCostMicros: 10_000,
        objective: "테스트 우선 변경",
        acceptanceCriteria: ["GREEN"],
        evidenceBriefIds: ["brief-1"],
        knowledgeSources,
        allowedPaths: ["src", "test.ts"],
      }),
    ).resolves.toEqual(proposal);
    expect(executeStructured).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        input: expect.objectContaining({
          evidenceBriefIds: ["brief-1"],
          knowledgeSources,
        }),
      }),
      expect.objectContaining({ name: "software_patch_proposal" }),
    );
    const source = await readFile(new URL("./runtime.ts", import.meta.url), "utf8");
    expect(source).not.toContain("@voltagent/");
  });

  it("실패 execution과 구조가 잘못된 proposal을 거부한다", async () => {
    const runner = {
      executeStructured: vi
        .fn()
        .mockResolvedValueOnce({ executionId: "failed", status: "failed", error: { category: "model" } })
        .mockResolvedValueOnce({ executionId: "invalid", status: "succeeded", output: { testPatch: 1 } }),
    } as unknown as StructuredAgentRunner;
    const service = new SoftwarePatchProposalService(runner);
    const request = {
      commandId: "proposal-1",
      workId: "work-1",
      taskId: "task-1",
      agentHandle: "software-engineering.backend-specialist",
      modelRoute: "coding-balanced",
      correlationId: "delivery-1",
      estimatedTokens: 4_000,
      estimatedCostMicros: 10_000,
      objective: "변경",
      acceptanceCriteria: ["GREEN"],
      evidenceBriefIds: [],
      knowledgeSources: [],
      allowedPaths: ["src"],
    };
    await expect(service.propose(context, request)).rejects.toThrow("proposal execution");
    await expect(service.propose(context, request)).rejects.toThrow("proposal 구조");
  });

  it("모델 부재 execution 결과를 상위 blocked 분류가 읽을 수 있게 원인으로 보존한다", async () => {
    const unavailable = {
      executionId: "unavailable",
      status: "blocked_model_unavailable" as const,
      error: { category: "provider-unavailable", retryable: true, userMessage: "모델 경로가 없습니다" },
    };
    const service = new SoftwarePatchProposalService({
      executeStructured: async () => unavailable,
    } as unknown as StructuredAgentRunner);
    const request = {
      commandId: "proposal-unavailable",
      workId: "work-1",
      taskId: "task-1",
      agentHandle: "software-engineering.backend-specialist",
      modelRoute: "coding-balanced",
      correlationId: "delivery-1",
      estimatedTokens: 4_000,
      estimatedCostMicros: 10_000,
      objective: "변경",
      acceptanceCriteria: ["GREEN"],
      evidenceBriefIds: [],
      knowledgeSources: [],
      allowedPaths: ["src"],
    };

    await expect(service.propose(context, request)).rejects.toMatchObject({ cause: unavailable });
  });
});

describe("Delivery filesystem 소유권 경계", () => {
  const context = { organizationId: "organization-1", userId: "user-1", role: "owner" } as TenantContext;

  it("유효하거나 만료된 이전 owner lease는 정리가 release하기 전까지 새 generation claim을 막는다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "lease-fence@example.com", displayName: "Fence" });
    const tenant = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const deliveries = await EngineeringDeliveryStore.create(database, organizations, {
      getWork: async (_context, workId) => ({ organizationId: tenant.organizationId, workId, status: "running" }),
      getTask: async (_context, workId, taskId) => ({
        organizationId: tenant.organizationId,
        workId,
        taskId,
        status: "running",
      }),
      getAssignment: async (_context, workId, assignmentId) => ({
        organizationId: tenant.organizationId,
        workId,
        taskId: "task-fence",
        assignmentId,
        agentHandle: "software-engineering.backend-specialist",
        status: "assigned",
      }),
      getRepository: async () => ({
        organizationId: tenant.organizationId,
        repositoryId: "repository-fence",
        status: "active",
        rootRealPathHash: "a".repeat(64),
      }),
      getRepositoryRevision: async () => ({
        organizationId: tenant.organizationId,
        repositoryId: "repository-fence",
        repositoryRevisionId: "revision-fence",
        providerRevision: "b".repeat(40),
        dirty: false,
        rootRealPathHash: "a".repeat(64),
      }),
    });
    const delivery = (
      await deliveries.start(tenant, {
        commandId: "run-fence:delivery:task:task-fence:engineering",
        workId: "work-fence",
        taskId: "task-fence",
        assignmentId: "assignment-fence",
        repositoryId: "repository-fence",
        repositoryRevisionId: "revision-fence",
        baseRevision: "b".repeat(40),
        agentHandle: "software-engineering.backend-specialist",
        profileVersion: "1.0.0",
      })
    ).delivery;
    const competingDelivery = (
      await deliveries.start(tenant, {
        commandId: "run-fence-competing:delivery:task:task-fence:engineering",
        workId: "work-fence-competing",
        taskId: "task-fence",
        assignmentId: "assignment-fence-competing",
        repositoryId: "repository-fence",
        repositoryRevisionId: "revision-fence",
        baseRevision: "b".repeat(40),
        agentHandle: "software-engineering.backend-specialist",
        profileVersion: "1.0.0",
      })
    ).delivery;
    let now = new Date("2026-07-30T00:00:00.000Z");
    const leases = await EngineeringPathLeaseStore.create(database, organizations, { now: () => now });
    const previous = (
      await leases.acquire(tenant, {
        commandId: "run-fence:delivery:lease:2:task:task-fence",
        deliveryId: delivery.deliveryId,
        repositoryId: delivery.repositoryId,
        pathPrefixes: ["packages/example"],
        ttlMs: 1_000,
      })
    ).lease;
    const claim = () =>
      leases.claim(tenant, {
        commandId: "run-fence:delivery:lease:3:task:task-fence",
        deliveryId: delivery.deliveryId,
        repositoryId: delivery.repositoryId,
        pathPrefixes: ["packages/example"],
        ttlMs: 1_000,
        ownerGeneration: 3,
      });

    await expect(claim()).rejects.toBeInstanceOf(EngineeringPathLeaseOwnershipError);
    now = new Date("2026-07-30T00:00:01.001Z");
    await expect(claim()).rejects.toBeInstanceOf(EngineeringPathLeaseOwnershipError);
    await expect(leases.list(tenant, delivery.repositoryId)).resolves.toContainEqual(
      expect.objectContaining({ leaseId: previous.leaseId, status: "active" }),
    );
    await database.query(
      "UPDATE engineering_path_lease SET status = 'expired', version = $version WHERE organization_id = $organization_id AND lease_id = $lease_id;",
      { organization_id: tenant.organizationId, lease_id: previous.leaseId, version: previous.version + 1 },
    );
    await expect(
      leases.acquire(tenant, {
        commandId: "run-fence-competing:delivery:lease:1:task:task-fence",
        deliveryId: competingDelivery.deliveryId,
        repositoryId: competingDelivery.repositoryId,
        pathPrefixes: ["packages/example"],
        ttlMs: 1_000,
      }),
    ).rejects.toMatchObject({ name: "EngineeringPathLeaseBusyError" });

    await leases.release(tenant, {
      commandId: "run-fence:delivery:recovery-release",
      leaseId: previous.leaseId,
      deliveryId: delivery.deliveryId,
      expectedAcquireCommandId: previous.acquireCommandId,
    });
    await expect(claim()).resolves.toEqual({
      lease: expect.objectContaining({
        acquireCommandId: "run-fence:delivery:lease:3:task:task-fence",
        status: "active",
      }),
    });
  });

  it("TDD 예외 정리는 owner fence를 다시 확인하고 stale worker의 workspace를 보존한다", async () => {
    const delivery = {
      deliveryId: "delivery-stale-cleanup",
      repositoryId: "repository-stale-cleanup",
      repositoryRootRealPathHash: "a".repeat(64),
      baseRevision: "b".repeat(40),
      startCommandId: "start-stale-cleanup",
      status: "preparing",
      version: 1,
    } as EngineeringDelivery;
    const remove = vi.fn(async () => undefined);
    const transition = vi.fn(async () => ({ delivery: { ...delivery, status: "failed" } }));
    let renewals = 0;
    const engine = new TddDeliveryEngine(
      {
        get: async () => delivery,
        transition,
      } as never,
      {
        verifyRepositoryRoot: async () => undefined,
        prepare: async () => ({ workspacePath: "/workspace/stale" }),
        applyPatch: async () => {
          throw new Error("test patch apply failed");
        },
        remove,
      } as never,
      {
        create: async () => ({ run: async () => ({}) }),
      } as never,
      {
        renew: async () => {
          renewals += 1;
          if (renewals === 4) throw new EngineeringPathLeaseOwnershipError("새 owner가 claim했습니다");
          return { lease: { version: renewals + 1 } };
        },
      } as never,
    );

    await expect(
      engine.execute(context, {
        deliveryId: delivery.deliveryId,
        repositoryRoot: "/repository",
        allowedPaths: ["src", "test"],
        testPaths: ["test"],
        testPatch: `diff --git a/test/value.test.ts b/test/value.test.ts
--- a/test/value.test.ts
+++ b/test/value.test.ts
@@ -1 +1 @@
-expect(value).toBe(1);
+expect(value).toBe(2);
`,
        implementationPatch: `diff --git a/src/value.ts b/src/value.ts
--- a/src/value.ts
+++ b/src/value.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`,
        focusedCommand: {
          executable: "node",
          args: [],
          cwd: ".",
          timeoutMs: 1_000,
          maxOutputBytes: 1_000,
          environment: {},
        },
        redFailureMarker: "EXPECTED_RED",
        validationCommands: [],
        commitMessage: "fix: stale cleanup fence",
        pathLease: {
          leaseId: "lease-stale-cleanup",
          ownerCommandId: "run:delivery:lease:2:task:task",
          version: 1,
          ttlMs: 1_000,
        },
      }),
    ).rejects.toBeInstanceOf(EngineeringPathLeaseOwnershipError);
    expect(remove).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it("장시간 TDD command는 lease heartbeat 상실 즉시 abort된 뒤 종료되고 새 filesystem 작업을 남기지 않는다", async () => {
    let delivery = {
      deliveryId: "delivery-command-heartbeat",
      repositoryId: "repository-command-heartbeat",
      repositoryRootRealPathHash: "a".repeat(64),
      baseRevision: "b".repeat(40),
      startCommandId: "start-command-heartbeat",
      status: "preparing",
      version: 1,
    } as EngineeringDelivery;
    let renewals = 0;
    let commandAborted = false;
    const remove = vi.fn(async () => undefined);
    const engine = new TddDeliveryEngine(
      {
        get: async () => delivery,
        transition: async (_context: unknown, input: { target: EngineeringDelivery["status"] }) => {
          delivery = { ...delivery, status: input.target, version: delivery.version + 1 };
          return { delivery };
        },
      } as never,
      {
        verifyRepositoryRoot: async () => undefined,
        prepare: async () => ({ workspacePath: "/workspace/heartbeat" }),
        applyPatch: async () => ({ changeSetHash: "c".repeat(64) }),
        remove,
      } as never,
      {
        create: async () => ({
          run: async (input: { signal?: AbortSignal }) => {
            await Promise.race([
              new Promise<void>((resolve) => {
                input.signal?.addEventListener(
                  "abort",
                  () => {
                    commandAborted = true;
                    resolve();
                  },
                  { once: true },
                );
              }),
              new Promise<void>((resolve) => setTimeout(resolve, 50)),
            ]);
            return {
              evidence: {
                stage: "red",
                executable: "node",
                argumentsHash: "d".repeat(64),
                environmentHash: "e".repeat(64),
                cwd: ".",
                signal: commandAborted ? "SIGTERM" : undefined,
                stdoutHash: "f".repeat(64),
                stderrHash: "0".repeat(64),
                outputExcerpt: "",
                durationMs: 1,
                timedOut: false,
                outputLimited: false,
                credentialRedacted: false,
              },
              output: "",
            };
          },
        }),
      } as never,
      {
        renew: async () => {
          renewals += 1;
          if (renewals === 6) throw new EngineeringPathLeaseOwnershipError("heartbeat owner를 잃었습니다");
          return { lease: { version: renewals + 1 } };
        },
      } as never,
    );

    await expect(
      engine.execute(context, {
        deliveryId: delivery.deliveryId,
        repositoryRoot: "/repository",
        allowedPaths: ["src", "test"],
        testPaths: ["test"],
        testPatch: `diff --git a/test/value.test.ts b/test/value.test.ts
--- a/test/value.test.ts
+++ b/test/value.test.ts
@@ -1 +1 @@
-expect(value).toBe(1);
+expect(value).toBe(2);
`,
        implementationPatch: `diff --git a/src/value.ts b/src/value.ts
--- a/src/value.ts
+++ b/src/value.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`,
        focusedCommand: {
          executable: "node",
          args: [],
          cwd: ".",
          timeoutMs: 1_000,
          maxOutputBytes: 1_000,
          environment: {},
        },
        redFailureMarker: "EXPECTED_RED",
        validationCommands: [],
        commitMessage: "fix: heartbeat fence",
        pathLease: {
          leaseId: "lease-command-heartbeat",
          ownerCommandId: "run:delivery:lease:2:task:task",
          version: 1,
          ttlMs: 10,
        },
      }),
    ).rejects.toBeInstanceOf(EngineeringPathLeaseOwnershipError);
    expect(commandAborted).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    expect(delivery.status).toBe("test_applied");
  });

  it("process group 회수 실패는 TDD workspace·terminal write를 실행하지 않고 원래 실패를 보존한다", async () => {
    let delivery = {
      deliveryId: "delivery-command-reap-failed",
      repositoryId: "repository-command-reap-failed",
      repositoryRootRealPathHash: "a".repeat(64),
      baseRevision: "b".repeat(40),
      startCommandId: "start-command-reap-failed",
      status: "preparing",
      version: 1,
    } as EngineeringDelivery;
    const remove = vi.fn(async () => undefined);
    const terminalWrites: string[] = [];
    let renewals = 0;
    const reapFailure = new Error("Managed command process group을 완전히 종료하지 못했습니다");
    reapFailure.name = "EngineeringCommandCleanupError";
    const engine = new TddDeliveryEngine(
      {
        get: async () => delivery,
        transition: async (_context: unknown, input: { target: EngineeringDelivery["status"] }) => {
          if (input.target === "failed") terminalWrites.push(input.target);
          delivery = { ...delivery, status: input.target, version: delivery.version + 1 };
          return { delivery };
        },
      } as never,
      {
        verifyRepositoryRoot: async () => undefined,
        prepare: async () => ({ workspacePath: "/workspace/reap-failed" }),
        applyPatch: async () => ({ changeSetHash: "c".repeat(64) }),
        remove,
      } as never,
      {
        create: async () => ({
          run: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            throw reapFailure;
          },
        }),
      } as never,
      {
        renew: async (_context: unknown, input: { expectedVersion: number }) => {
          renewals += 1;
          if (renewals === 6) throw new EngineeringPathLeaseOwnershipError("heartbeat owner도 잃었습니다");
          return { lease: { version: input.expectedVersion + 1 } };
        },
      } as never,
    );

    await expect(
      engine.execute(context, {
        deliveryId: delivery.deliveryId,
        repositoryRoot: "/repository",
        allowedPaths: ["src", "test"],
        testPaths: ["test"],
        testPatch: `diff --git a/test/value.test.ts b/test/value.test.ts
--- a/test/value.test.ts
+++ b/test/value.test.ts
@@ -1 +1 @@
-expect(value).toBe(1);
+expect(value).toBe(2);
`,
        implementationPatch: `diff --git a/src/value.ts b/src/value.ts
--- a/src/value.ts
+++ b/src/value.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`,
        focusedCommand: {
          executable: "node",
          args: [],
          cwd: ".",
          timeoutMs: 1_000,
          maxOutputBytes: 1_000,
          environment: {},
        },
        redFailureMarker: "EXPECTED_RED",
        validationCommands: [],
        commitMessage: "fix: process reap fence",
        pathLease: {
          leaseId: "lease-command-reap-failed",
          ownerCommandId: "run:delivery:lease:2:task:task",
          version: 1,
          ttlMs: 10,
        },
      }),
    ).rejects.toBe(reapFailure);
    expect({ removeCalls: remove.mock.calls.length, terminalWrites }).toEqual({ removeCalls: 0, terminalWrites: [] });
    expect(delivery.status).toBe("test_applied");
  });

  it("retryable Recovery는 workspace 삭제 성공 뒤 lease를 release하고 replay에서 정리를 중복하지 않는다", async () => {
    const delivery = {
      deliveryId: "delivery-cleanup-order",
      repositoryId: "repository-cleanup-order",
      repositoryRootRealPathHash: "a".repeat(64),
      baseRevision: "b".repeat(40),
      startCommandId: "start-cleanup-order",
      status: "preparing",
      version: 1,
    } as EngineeringDelivery;
    const lease = {
      leaseId: "lease-cleanup-order",
      deliveryId: delivery.deliveryId,
      repositoryId: delivery.repositoryId,
      acquireCommandId: "run:delivery:lease:2:task:task",
      status: "active" as const,
      version: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    let replay: { deliveryId: string; result: string } | undefined;
    let deleteAttempts = 0;
    let releaseCalls = 0;
    let metricCalls = 0;
    const recovery = new EngineeringDeliveryRecovery(
      {
        findRecoveryReplay: async () => replay,
        get: async () => delivery,
        recordRecoveryEvent: async (_context: unknown, input: { result: string }) => {
          replay = { deliveryId: delivery.deliveryId, result: input.result };
        },
      } as never,
      {
        verifyRepositoryRoot: async () => undefined,
        removeDeliveryWorkspaceIfExists: async () => {
          deleteAttempts += 1;
          if (deleteAttempts === 1) throw new Error("workspace delete failed");
          return true;
        },
      } as never,
      {
        list: async () => [lease],
        renew: async () => ({ lease: { ...lease, version: lease.version + 1 } }),
        release: async () => {
          releaseCalls += 1;
          Object.assign(lease, { status: "released", version: lease.version + 1 });
          return { lease };
        },
      } as never,
      {
        recordOnce: async () => {
          metricCalls += 1;
        },
      } as never,
    );
    const input = {
      commandId: "cleanup-order-recovery",
      deliveryId: delivery.deliveryId,
      repositoryRoot: "/repository",
      repositoryId: delivery.repositoryId,
      cleanupLeaseCommandId: lease.acquireCommandId,
      leaseTtlMs: 1_000,
    };

    await expect(recovery.recover(context, input)).rejects.toThrow("workspace delete failed");
    expect({ releaseCalls, status: lease.status }).toEqual({ releaseCalls: 0, status: "active" });
    await expect(recovery.recover(context, input)).resolves.toMatchObject({ result: "resume_required" });
    await expect(recovery.recover(context, input)).resolves.toMatchObject({ result: "resume_required" });
    expect({ deleteAttempts, releaseCalls, metricCalls }).toEqual({
      deleteAttempts: 2,
      releaseCalls: 1,
      metricCalls: 1,
    });
  });

  it("만료 Recovery는 workspace 삭제 직전 storage owner가 바뀌면 새 workspace를 삭제하지 않는다", async () => {
    const delivery = {
      deliveryId: "delivery-delete-toctou",
      repositoryId: "repository-delete-toctou",
      repositoryRootRealPathHash: "a".repeat(64),
      baseRevision: "b".repeat(40),
      startCommandId: "start-delete-toctou",
      status: "preparing",
      version: 1,
    } as EngineeringDelivery;
    const oldLease = {
      leaseId: "lease-delete-toctou",
      deliveryId: delivery.deliveryId,
      repositoryId: delivery.repositoryId,
      acquireCommandId: "run:delivery:lease:2:task:task",
      status: "expired" as const,
      version: 2,
      expiresAt: "2000-01-01T00:00:00.000Z",
    };
    const newLease = {
      ...oldLease,
      acquireCommandId: "run:delivery:lease:3:task:task",
      status: "active" as const,
      version: 4,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    let reads = 0;
    const remove = vi.fn(async () => true);
    const release = vi.fn(async () => ({ lease: oldLease }));
    const recovery = new EngineeringDeliveryRecovery(
      {
        findRecoveryReplay: async () => undefined,
        get: async () => delivery,
        recordRecoveryEvent: async () => undefined,
      } as never,
      {
        verifyRepositoryRoot: async () => undefined,
        removeDeliveryWorkspaceIfExists: remove,
      } as never,
      {
        list: async () => {
          reads += 1;
          return [reads <= 3 ? oldLease : newLease];
        },
        renew: async () => {
          throw new Error("expired lease는 renew하지 않습니다");
        },
        release,
      } as never,
    );

    await expect(
      recovery.recover(context, {
        commandId: "recover-delete-toctou",
        deliveryId: delivery.deliveryId,
        repositoryRoot: "/repository",
        repositoryId: delivery.repositoryId,
        cleanupLeaseCommandId: oldLease.acquireCommandId,
        leaseTtlMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(EngineeringPathLeaseOwnershipError);
    expect({ removeCalls: remove.mock.calls.length, releaseCalls: release.mock.calls.length }).toEqual({
      removeCalls: 0,
      releaseCalls: 0,
    });
  });

  it("만료 Recovery는 workspace 삭제 뒤 release 직전 storage owner가 바뀌면 새 lease를 release하지 않는다", async () => {
    const delivery = {
      deliveryId: "delivery-release-toctou",
      repositoryId: "repository-release-toctou",
      repositoryRootRealPathHash: "a".repeat(64),
      baseRevision: "b".repeat(40),
      startCommandId: "start-release-toctou",
      status: "preparing",
      version: 1,
    } as EngineeringDelivery;
    const oldLease = {
      leaseId: "lease-release-toctou",
      deliveryId: delivery.deliveryId,
      repositoryId: delivery.repositoryId,
      acquireCommandId: "run:delivery:lease:2:task:task",
      status: "expired" as const,
      version: 2,
      expiresAt: "2000-01-01T00:00:00.000Z",
    };
    const newLease = {
      ...oldLease,
      acquireCommandId: "run:delivery:lease:3:task:task",
      status: "active" as const,
      version: 4,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    let currentLease = oldLease as typeof oldLease | typeof newLease;
    const remove = vi.fn(async () => {
      currentLease = newLease;
      return true;
    });
    const release = vi.fn(async () => ({ lease: oldLease }));
    const recovery = new EngineeringDeliveryRecovery(
      {
        findRecoveryReplay: async () => undefined,
        get: async () => delivery,
        recordRecoveryEvent: async () => undefined,
      } as never,
      {
        verifyRepositoryRoot: async () => undefined,
        removeDeliveryWorkspaceIfExists: remove,
      } as never,
      {
        list: async () => [currentLease],
        renew: async () => {
          throw new Error("expired lease는 renew하지 않습니다");
        },
        release,
      } as never,
    );

    await expect(
      recovery.recover(context, {
        commandId: "recover-release-toctou",
        deliveryId: delivery.deliveryId,
        repositoryRoot: "/repository",
        repositoryId: delivery.repositoryId,
        cleanupLeaseCommandId: oldLease.acquireCommandId,
        leaseTtlMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(EngineeringPathLeaseOwnershipError);
    expect({ removeCalls: remove.mock.calls.length, releaseCalls: release.mock.calls.length }).toEqual({
      removeCalls: 1,
      releaseCalls: 0,
    });
  });

  it("같은 lease owner라도 workspace 삭제 직전 Delivery status가 바뀌면 삭제하지 않는다", async () => {
    const initial = {
      deliveryId: "delivery-status-toctou",
      organizationId: context.organizationId,
      repositoryId: "repository-status-toctou",
      repositoryRootRealPathHash: "a".repeat(64),
      baseRevision: "b".repeat(40),
      startCommandId: "start-status-toctou",
      status: "preparing",
      version: 1,
    } as EngineeringDelivery;
    let current = initial;
    const lease = {
      leaseId: "lease-status-toctou",
      deliveryId: initial.deliveryId,
      repositoryId: initial.repositoryId,
      acquireCommandId: "run:delivery:lease:2:task:task",
      status: "expired" as const,
      version: 2,
      expiresAt: "2000-01-01T00:00:00.000Z",
    };
    let leaseReads = 0;
    const remove = vi.fn(async () => true);
    const release = vi.fn(async () => ({ lease }));
    const recovery = new EngineeringDeliveryRecovery(
      {
        findRecoveryReplay: async () => undefined,
        get: async () => current,
        recordRecoveryEvent: async () => undefined,
      } as never,
      {
        verifyRepositoryRoot: async () => undefined,
        removeDeliveryWorkspaceIfExists: remove,
      } as never,
      {
        list: async () => {
          leaseReads += 1;
          if (leaseReads === 3) current = { ...initial, status: "cancelled", version: 2 };
          return [lease];
        },
        renew: async () => {
          throw new Error("expired lease는 renew하지 않습니다");
        },
        release,
      } as never,
    );

    await expect(
      recovery.recover(context, {
        commandId: "recover-status-toctou",
        deliveryId: initial.deliveryId,
        repositoryRoot: "/repository",
        repositoryId: initial.repositoryId,
        cleanupLeaseCommandId: lease.acquireCommandId,
        leaseTtlMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(EngineeringPathLeaseOwnershipError);
    expect({ removeCalls: remove.mock.calls.length, releaseCalls: release.mock.calls.length }).toEqual({
      removeCalls: 0,
      releaseCalls: 0,
    });
  });

  it("같은 lease owner라도 workspace 삭제 뒤 Delivery generation이 바뀌면 lease를 release하지 않는다", async () => {
    const initial = {
      deliveryId: "delivery-generation-toctou",
      organizationId: context.organizationId,
      repositoryId: "repository-generation-toctou",
      repositoryRootRealPathHash: "a".repeat(64),
      baseRevision: "b".repeat(40),
      startCommandId: "start-generation-toctou",
      status: "preparing",
      version: 1,
    } as EngineeringDelivery;
    let current = initial;
    const lease = {
      leaseId: "lease-generation-toctou",
      deliveryId: initial.deliveryId,
      repositoryId: initial.repositoryId,
      acquireCommandId: "run:delivery:lease:2:task:task",
      status: "expired" as const,
      version: 2,
      expiresAt: "2000-01-01T00:00:00.000Z",
    };
    const remove = vi.fn(async () => {
      current = { ...initial, version: 2 };
      return true;
    });
    const release = vi.fn(async () => ({ lease }));
    const recovery = new EngineeringDeliveryRecovery(
      {
        findRecoveryReplay: async () => undefined,
        get: async () => current,
        recordRecoveryEvent: async () => undefined,
      } as never,
      {
        verifyRepositoryRoot: async () => undefined,
        removeDeliveryWorkspaceIfExists: remove,
      } as never,
      {
        list: async () => [lease],
        renew: async () => {
          throw new Error("expired lease는 renew하지 않습니다");
        },
        release,
      } as never,
    );

    await expect(
      recovery.recover(context, {
        commandId: "recover-generation-toctou",
        deliveryId: initial.deliveryId,
        repositoryRoot: "/repository",
        repositoryId: initial.repositoryId,
        cleanupLeaseCommandId: lease.acquireCommandId,
        leaseTtlMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(EngineeringPathLeaseOwnershipError);
    expect({ removeCalls: remove.mock.calls.length, releaseCalls: release.mock.calls.length }).toEqual({
      removeCalls: 1,
      releaseCalls: 0,
    });
  });
});
