import { GovernanceApprovalRequiredError } from "@massion/governance";
import type { WorkTask } from "@massion/work";
import { describe, expect, it } from "vitest";

import { CoreSoftwareTaskAdapter } from "./core-software-task.js";

const context = {
  userId: "software-user",
  organizationId: "software-org",
  membershipId: "software-member",
  role: "owner" as const,
};
const task = {
  task_id: "software-task",
  organization_id: context.organizationId,
  work_id: "software-work",
  title: "기능 구현",
  objective: "기능 구현",
  acceptance_criteria_json: JSON.stringify([{ statement: "테스트가 통과한다" }]),
  dependency_ids: [],
  recommended_agent_handles: ["software-engineering.backend-specialist"],
  status: "ready",
  revision: 1,
  created_at: "2026-07-30T00:00:00.000Z",
  updated_at: "2026-07-30T00:00:00.000Z",
} satisfies WorkTask;
const request = {
  softwareDelivery: {
    repositoryRoot: "/workspace/repository",
    repositoryId: "repository-1",
    repositoryRevisionId: "revision-1",
    baseRevision: "abc123",
    profileVersion: "1.0.0",
    allowedPaths: ["packages/example"],
    testPaths: ["packages/example/test.ts"],
    evidenceBriefIds: ["brief-1"],
  },
};
const knowledgeSources = [
  {
    evidenceBriefId: "brief-verified",
    indexVersionId: "index-verified",
    briefChecksum: "a".repeat(64),
    snippets: [
      {
        referenceId: "ref-verified",
        citation: "src/verified.ts:1-1",
        relativePath: "src/verified.ts",
        startLine: 1,
        endLine: 1,
        content: "export const verified = true;",
        estimatedTokens: 5,
      },
    ],
    estimatedTokens: 8,
    truncated: false,
  },
];

describe("CoreSoftwareTaskAdapter", () => {
  it("배정→TDD→승인 대기 후 같은 Delivery를 승인 ID로 최종화한다", async () => {
    const calls: string[] = [];
    const proposalInputs: unknown[] = [];
    let existing: { deliveryId: string; status: string } | undefined;
    const adapter = new CoreSoftwareTaskAdapter({
      works: {
        getWork: async () => ({ revision: 1 }),
        listTasks: async () => [{ ...task, revision: 2, status: "running" }],
        assignTask: async () => {
          calls.push("assign");
          return { work: { revision: 2 }, assignment: { assignment_id: "assignment-1" } };
        },
      },
      deliveries: {
        findByStartCommand: async () => existing,
        get: async () => existing,
        transition: async () => ({ delivery: existing }),
      },
      coordinator: {
        start: async () => {
          calls.push("coordinate");
          existing = { deliveryId: "delivery-1", status: "preparing" };
          return { delivery: existing };
        },
      },
      proposals: {
        propose: async (
          _context: unknown,
          input: {
            acceptanceCriteria: readonly string[];
            evidenceBriefIds: readonly string[];
            knowledgeSources: readonly unknown[];
          },
        ) => {
          calls.push(`propose:${input.acceptanceCriteria[0]}`);
          proposalInputs.push(input);
          return {
            testPatch: "test",
            implementationPatch: "implementation",
            focusedCommand: {},
            redFailureMarker: "RED",
            validationCommands: [],
            commitMessage: "feat: implement",
          };
        },
      },
      engine: {
        execute: async () => {
          calls.push("tdd");
          existing = { deliveryId: "delivery-1", status: "committed" };
          return { delivery: existing };
        },
      },
      finalizer: {
        finalize: async (_context: unknown, input: { governanceApprovalId?: string }) => {
          calls.push(`finalize:${input.governanceApprovalId ?? "none"}`);
          if (!input.governanceApprovalId) throw new GovernanceApprovalRequiredError("decision-1", "approval-1");
          return {};
        },
      },
      recovery: { recover: async () => ({ delivery: existing, result: "cleaned_terminal" }) },
    } as never);
    const common = {
      runId: "software-run",
      commandId: "software-command",
      correlationId: "software-correlation",
      workId: "software-work",
      task,
      request,
      knowledgeSources,
    };
    await expect(adapter.executeTask(context, common as never)).resolves.toEqual({
      outcome: "awaiting-approval",
      approvalId: "approval-1",
    });
    await expect(
      adapter.executeTask(context, { ...common, resumeInput: { approvalId: "approval-1" } } as never),
    ).resolves.toEqual({ outcome: "completed" });
    expect(calls).toEqual([
      "assign",
      "coordinate",
      "propose:테스트가 통과한다",
      "tdd",
      "finalize:none",
      "finalize:approval-1",
    ]);
    expect(proposalInputs).toEqual([
      expect.objectContaining({
        estimatedTokens: expect.any(Number),
        evidenceBriefIds: ["brief-verified"],
        knowledgeSources,
      }),
    ]);
    expect((proposalInputs[0] as { estimatedTokens: number }).estimatedTokens).toBeLessThanOrEqual(32_000);
  });

  it("취소 시 Delivery를 terminal로 전이한 뒤 격리 workspace 복구 정리를 실행한다", async () => {
    const calls: string[] = [];
    const delivery = { deliveryId: "delivery-2", version: 3, status: "red_verified" };
    const adapter = new CoreSoftwareTaskAdapter({
      works: {},
      deliveries: {
        findByStartCommand: async () => delivery,
        transition: async (_context: unknown, input: { target: string; error?: unknown }) => {
          if (input.error) throw new Error("cancelled Delivery에는 failed error를 기록하면 안 됩니다");
          calls.push(input.target);
          return { delivery: { ...delivery, status: input.target } };
        },
      },
      recovery: {
        recover: async () => {
          calls.push("recover");
          return { delivery: { ...delivery, status: "cancelled" }, result: "cleaned_terminal" };
        },
      },
    } as never);
    await adapter.cancelTask(context, {
      runId: "software-run-2",
      commandId: "software-command-2",
      workId: "software-work",
      task,
      request,
    });
    expect(calls).toEqual(["cancelled", "recover"]);
  });

  it("1,000 token Work에서 검증된 근거가 proposal baseline을 넘으면 부수 효과 전에 차단한다", async () => {
    let deliveryReads = 0;
    let proposalCalls = 0;
    const adapter = new CoreSoftwareTaskAdapter({
      works: {},
      deliveries: {
        findByStartCommand: async () => {
          deliveryReads += 1;
          return undefined;
        },
      },
      proposals: {
        propose: async () => {
          proposalCalls += 1;
          return {};
        },
      },
    } as never);

    await expect(
      adapter.executeTask(context, {
        runId: "software-low-budget-run",
        commandId: "software-low-budget-command",
        correlationId: "software-low-budget-correlation",
        workId: "software-work",
        task,
        request: { ...request, tokenBudget: 1_000 },
        knowledgeSources,
      }),
    ).resolves.toEqual({ outcome: "blocked", reason: "evidence-invalid" });
    expect(deliveryReads).toBe(0);
    expect(proposalCalls).toBe(0);
  });

  it("Software Delivery 구성이 없으면 Delivery 생성 전에 blocked로 유지한다", async () => {
    let deliveryCalls = 0;
    const adapter = new CoreSoftwareTaskAdapter({
      works: {},
      deliveries: {
        findByStartCommand: async () => {
          deliveryCalls += 1;
          return undefined;
        },
      },
    } as never);

    await expect(
      adapter.executeTask(context, {
        runId: "software-configuration-run",
        commandId: "software-configuration-command",
        correlationId: "software-configuration-correlation",
        workId: "software-work",
        task,
        request: {},
      }),
    ).resolves.toEqual({ outcome: "blocked", reason: "software-delivery-configuration-required" });
    expect(deliveryCalls).toBe(0);
  });

  it.each([
    ["empty allowed paths", { ...request.softwareDelivery, allowedPaths: [] }],
    ["empty test paths", { ...request.softwareDelivery, testPaths: [] }],
    ["malformed allowed paths", { ...request.softwareDelivery, allowedPaths: ["../outside"] }],
  ])("잘못된 Software Delivery 구성(%s)은 Delivery·path lease 전에 결정적으로 차단한다", async (_label, value) => {
    let deliveryReads = 0;
    let leaseCalls = 0;
    const adapter = new CoreSoftwareTaskAdapter({
      works: {},
      deliveries: {
        findByStartCommand: async () => {
          deliveryReads += 1;
          return undefined;
        },
      },
      leases: {
        acquire: async () => {
          leaseCalls += 1;
          return {};
        },
      },
    } as never);

    await expect(
      adapter.executeTask(context, {
        runId: "software-invalid-configuration-run",
        commandId: "software-invalid-configuration-command",
        correlationId: "software-invalid-configuration-correlation",
        workId: "software-work",
        task,
        request: { softwareDelivery: value },
      }),
    ).resolves.toEqual({ outcome: "blocked", reason: "software-delivery-configuration-invalid" });
    expect({ deliveryReads, leaseCalls }).toEqual({ deliveryReads: 0, leaseCalls: 0 });
  });

  it("기존 preparing Delivery의 active path lease를 소유하지 못한 worker는 제안·TDD에 진입하지 않는다", async () => {
    let proposalCalls = 0;
    let tddCalls = 0;
    const delivery = { deliveryId: "delivery-owned", version: 1, status: "preparing" };
    const adapter = new CoreSoftwareTaskAdapter({
      works: {},
      deliveries: { findByStartCommand: async () => delivery },
      leases: {
        acquire: async () => {
          const error = new Error("active lease");
          error.name = "EngineeringPathLeaseBusyError";
          throw error;
        },
      },
      proposals: {
        propose: async () => {
          proposalCalls += 1;
          return {};
        },
      },
      engine: {
        execute: async () => {
          tddCalls += 1;
          return {};
        },
      },
    } as never);

    await expect(
      adapter.executeTask(context, {
        runId: "software-owned-run",
        leaseGeneration: 2,
        commandId: "software-owned-command",
        correlationId: "software-owned-correlation",
        workId: "software-work",
        task,
        request,
      }),
    ).resolves.toEqual({ outcome: "blocked", reason: "software-delivery-owned" });
    expect({ proposalCalls, tddCalls }).toEqual({ proposalCalls: 0, tddCalls: 0 });
  });

  it("새 generation은 이전 owner의 유효한 lease와 파일 작업이 끝날 때까지 takeover하지 않는다", async () => {
    const calls: string[] = [];
    let delivery = {
      deliveryId: "delivery-generation-handoff",
      version: 1,
      status: "preparing",
      startCommandId: "software-generation-run:delivery:task:software-task:engineering",
    };
    const lease = {
      leaseId: "lease-generation-3",
      deliveryId: delivery.deliveryId,
      repositoryId: request.softwareDelivery.repositoryId,
      acquireCommandId: "software-generation-run:delivery:lease:3:task:software-task",
      status: "active",
      version: 7,
    };
    const adapter = new CoreSoftwareTaskAdapter({
      works: {
        getWork: async () => ({ revision: 4 }),
        listTasks: async () => [{ ...task, status: "running", revision: 2 }],
      },
      deliveries: {
        findByStartCommand: async () => delivery,
        get: async () => delivery,
        transition: async () => {
          throw new Error("handoff 경로에서 Delivery를 실패시키면 안 됩니다");
        },
      },
      leases: {
        list: async () => [
          {
            ...lease,
            leaseId: "lease-generation-2",
            acquireCommandId: "software-generation-run:delivery:lease:2:task:software-task",
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        ],
        claim: async (_context: unknown, input: { ownerGeneration: number }) => {
          calls.push(`claim:${String(input.ownerGeneration)}`);
          return { lease };
        },
        renew: async () => {
          calls.push("renew");
          return { lease: { ...lease, version: lease.version + 1 } };
        },
      },
      recovery: {
        recover: async () => {
          calls.push("recover");
          return { delivery, result: "resume_required" };
        },
      },
      proposals: {
        propose: async () => {
          calls.push("proposal");
          return {
            testPatch: "test",
            implementationPatch: "implementation",
            focusedCommand: {},
            redFailureMarker: "RED",
            validationCommands: [],
            commitMessage: "feat: handoff",
          };
        },
      },
      engine: {
        execute: async () => {
          calls.push("tdd");
          delivery = { ...delivery, version: 2, status: "committed" };
          return { delivery };
        },
      },
      finalizer: { finalize: async () => ({}) },
      metrics: { recordOnce: async () => undefined },
    } as never);

    await expect(
      adapter.executeTask(context, {
        runId: "software-generation-run",
        leaseGeneration: 3,
        commandId: "software-generation-command",
        correlationId: "software-generation-correlation",
        workId: "software-work",
        task,
        request,
      }),
    ).resolves.toEqual({ outcome: "blocked", reason: "software-delivery-owned" });
    expect(calls).toEqual([]);
  });

  it("만료 takeover는 이전 TDD 실행 종료를 기다린 뒤 Recovery·새 claim·파일 작업을 시작한다", async () => {
    const calls: string[] = [];
    let delivery = {
      deliveryId: "delivery-expired-handoff",
      version: 1,
      status: "preparing",
      startCommandId: "software-expired-handoff-run:delivery:task:software-task:engineering",
    };
    let lease = {
      leaseId: "lease-expired-owner-2",
      deliveryId: delivery.deliveryId,
      repositoryId: request.softwareDelivery.repositoryId,
      acquireCommandId: "software-expired-handoff-run:delivery:lease:2:task:software-task",
      status: "active",
      version: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    let releaseOldProposal!: () => void;
    let enterOldProposal!: () => void;
    const oldProposalEntered = new Promise<void>((resolve) => {
      enterOldProposal = resolve;
    });
    const oldProposal = new Promise<void>((resolve) => {
      releaseOldProposal = resolve;
    });
    let proposalCalls = 0;
    const adapter = new CoreSoftwareTaskAdapter({
      works: {
        getWork: async () => ({ revision: 4 }),
        listTasks: async () => [{ ...task, status: "running", revision: 2 }],
      },
      deliveries: {
        findByStartCommand: async () => delivery,
        get: async () => delivery,
        transition: async () => {
          throw new Error("handoff worker가 Delivery를 실패시키면 안 됩니다");
        },
      },
      leases: {
        list: async () => [lease],
        claim: async (_context: unknown, input: { commandId: string; ownerGeneration: number }) => {
          calls.push(`claim:${String(input.ownerGeneration)}`);
          if (lease.status === "active" && lease.acquireCommandId !== input.commandId) {
            const error = new Error("이전 lease가 정리되지 않았습니다");
            error.name = "EngineeringPathLeaseOwnershipError";
            throw error;
          }
          if (lease.acquireCommandId === input.commandId) return { lease };
          lease = {
            ...lease,
            leaseId: `lease-expired-owner-${String(input.ownerGeneration)}`,
            acquireCommandId: input.commandId,
            status: "active",
            version: 1,
            expiresAt: "2099-01-01T00:00:00.000Z",
          };
          return { lease };
        },
        renew: async (_context: unknown, input: { leaseId: string }) => {
          if (lease.status !== "active" || lease.leaseId !== input.leaseId) {
            const error = new Error("lease owner가 변경됐습니다");
            error.name = "EngineeringPathLeaseOwnershipError";
            throw error;
          }
          lease = { ...lease, version: lease.version + 1 };
          return { lease };
        },
      },
      recovery: {
        recover: async (
          _context: unknown,
          input: { cleanupLeaseCommandId?: string; preserveLeaseCommandId?: string },
        ) => {
          if (input.cleanupLeaseCommandId) {
            calls.push("recover:expired-owner");
            lease = { ...lease, status: "released", version: lease.version + 1 };
          }
          return { delivery, result: "resume_required" };
        },
      },
      proposals: {
        propose: async () => {
          proposalCalls += 1;
          if (proposalCalls === 1) {
            calls.push("proposal:old-entered");
            enterOldProposal();
            await oldProposal;
            calls.push("proposal:old-returned");
          } else {
            calls.push("proposal:new");
          }
          return {
            testPatch: "test",
            implementationPatch: "implementation",
            focusedCommand: {},
            redFailureMarker: "RED",
            validationCommands: [],
            commitMessage: "fix: expired handoff",
          };
        },
      },
      engine: {
        execute: async () => {
          calls.push("tdd:new");
          delivery = { ...delivery, version: delivery.version + 1, status: "committed" };
          return { delivery };
        },
      },
      finalizer: { finalize: async () => ({}) },
      metrics: { recordOnce: async () => undefined },
    } as never);
    const common = {
      runId: "software-expired-handoff-run",
      commandId: "software-expired-handoff-command",
      correlationId: "software-expired-handoff-correlation",
      workId: "software-work",
      task,
      request,
    };

    const oldExecution = adapter.executeTask(context, { ...common, leaseGeneration: 2 });
    await oldProposalEntered;
    lease = { ...lease, expiresAt: "2000-01-01T00:00:00.000Z" };
    const takeover = adapter.executeTask(context, {
      ...common,
      leaseGeneration: 3,
      commandId: "software-expired-handoff-recovery-command",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const earlyTakeoverSideEffects = calls.filter((call) =>
      ["recover:expired-owner", "claim:3", "proposal:new", "tdd:new"].includes(call),
    );
    releaseOldProposal();

    await expect(oldExecution).resolves.toEqual({ outcome: "blocked", reason: "software-delivery-owned" });
    await expect(takeover).resolves.toEqual({ outcome: "completed" });
    expect(earlyTakeoverSideEffects).toEqual([]);
    expect(calls).toEqual(
      expect.arrayContaining(["proposal:old-returned", "recover:expired-owner", "claim:3", "proposal:new", "tdd:new"]),
    );
  });

  it("process group 회수 실패는 settled 실패를 보존해 새 owner의 Recovery·claim·TDD를 모두 막는다", async () => {
    let delivery = {
      deliveryId: "delivery-reap-failed",
      version: 1,
      status: "preparing",
      startCommandId: "software-reap-failed-run:delivery:task:software-task:engineering",
    };
    let lease = {
      leaseId: "lease-reap-failed",
      deliveryId: delivery.deliveryId,
      repositoryId: request.softwareDelivery.repositoryId,
      acquireCommandId: "software-reap-failed-run:delivery:lease:2:task:software-task",
      status: "active",
      version: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    let proposalCalls = 0;
    let newClaims = 0;
    let cleanupCalls = 0;
    let transitionCalls = 0;
    const reapFailure = new Error("Managed command process group을 완전히 종료하지 못했습니다");
    reapFailure.name = "EngineeringCommandCleanupError";
    const adapter = new CoreSoftwareTaskAdapter({
      works: {},
      deliveries: {
        findByStartCommand: async () => delivery,
        get: async () => delivery,
        transition: async (_context: unknown, input: { target: string }) => {
          transitionCalls += 1;
          delivery = { ...delivery, status: input.target, version: delivery.version + 1 };
          return { delivery };
        },
      },
      leases: {
        list: async () => [lease],
        claim: async (_context: unknown, input: { commandId: string; ownerGeneration: number }) => {
          if (input.ownerGeneration === 3) newClaims += 1;
          if (input.commandId === lease.acquireCommandId) return { lease };
          lease = {
            ...lease,
            acquireCommandId: input.commandId,
            version: lease.version + 1,
            expiresAt: "2099-01-01T00:00:00.000Z",
          };
          return { lease };
        },
        renew: async () => {
          lease = { ...lease, version: lease.version + 1 };
          return { lease };
        },
      },
      recovery: {
        recover: async (_context: unknown, input: { cleanupLeaseCommandId?: string }) => {
          if (input.cleanupLeaseCommandId) cleanupCalls += 1;
          return { delivery, result: "resume_required" };
        },
      },
      proposals: {
        propose: async () => {
          proposalCalls += 1;
          return {
            testPatch: "test",
            implementationPatch: "implementation",
            focusedCommand: {},
            redFailureMarker: "RED",
            validationCommands: [],
            commitMessage: "fix: reap failed",
          };
        },
      },
      engine: { execute: async () => Promise.reject(reapFailure) },
      metrics: { recordOnce: async () => undefined },
    } as never);
    const common = {
      runId: "software-reap-failed-run",
      commandId: "software-reap-failed-command",
      correlationId: "software-reap-failed-correlation",
      workId: "software-work",
      task,
      request,
    };

    await expect(adapter.executeTask(context, { ...common, leaseGeneration: 2 })).resolves.toEqual({
      outcome: "blocked",
      reason: "software-delivery-command-cleanup-failed",
    });
    lease = { ...lease, expiresAt: "2000-01-01T00:00:00.000Z" };
    await expect(
      adapter.executeTask(context, {
        ...common,
        leaseGeneration: 3,
        commandId: "software-reap-failed-takeover-command",
      }),
    ).resolves.toEqual({ outcome: "blocked", reason: "software-delivery-command-cleanup-failed" });
    expect({ proposalCalls, newClaims, cleanupCalls, transitionCalls, status: delivery.status }).toEqual({
      proposalCalls: 1,
      newClaims: 0,
      cleanupCalls: 0,
      transitionCalls: 0,
      status: "preparing",
    });
  });

  it("resume_required 중간 step은 Recovery가 preparing으로 rollback한 뒤 새 owner claim으로 재시작한다", async () => {
    const calls: string[] = [];
    let delivery = {
      deliveryId: "delivery-resume-required",
      version: 5,
      status: "test_applied",
      startCommandId: "software-resume-required-run:delivery:task:software-task:engineering",
    };
    const adapter = new CoreSoftwareTaskAdapter({
      works: {
        getWork: async () => ({ revision: 5 }),
        listTasks: async () => [{ ...task, status: "running", revision: 2 }],
      },
      deliveries: {
        findByStartCommand: async () => delivery,
        get: async () => delivery,
      },
      leases: {
        list: async () => [
          {
            leaseId: "lease-resume-required-old",
            deliveryId: delivery.deliveryId,
            repositoryId: request.softwareDelivery.repositoryId,
            acquireCommandId: "software-resume-required-run:delivery:lease:4:task:software-task",
            status: "active",
            version: 8,
            expiresAt: "2000-01-01T00:00:00.000Z",
          },
        ],
        claim: async () => {
          calls.push("claim");
          return {
            lease: {
              leaseId: "lease-resume-required-new",
              deliveryId: delivery.deliveryId,
              repositoryId: request.softwareDelivery.repositoryId,
              acquireCommandId: "software-resume-required-run:delivery:lease:5:task:software-task",
              status: "active",
              version: 1,
            },
          };
        },
        renew: async () => ({
          lease: {
            leaseId: "lease-resume-required-new",
            deliveryId: delivery.deliveryId,
            repositoryId: request.softwareDelivery.repositoryId,
            acquireCommandId: "software-resume-required-run:delivery:lease:5:task:software-task",
            status: "active",
            version: 2,
          },
        }),
      },
      recovery: {
        recover: async () => {
          calls.push("recover");
          delivery = { ...delivery, version: 6, status: "preparing" };
          return { delivery, result: "resume_required" };
        },
      },
      proposals: {
        propose: async () => ({
          testPatch: "test",
          implementationPatch: "implementation",
          focusedCommand: {},
          redFailureMarker: "RED",
          validationCommands: [],
          commitMessage: "feat: resume",
        }),
      },
      engine: {
        execute: async (_context: unknown, input: { pathLease?: { ownerCommandId?: string } }) => {
          calls.push(`tdd:${input.pathLease?.ownerCommandId ?? "unfenced"}`);
          delivery = { ...delivery, version: 7, status: "committed" };
          return { delivery };
        },
      },
      finalizer: { finalize: async () => ({}) },
      metrics: { recordOnce: async () => undefined },
    } as never);

    await expect(
      adapter.executeTask(context, {
        runId: "software-resume-required-run",
        leaseGeneration: 5,
        commandId: "software-resume-required-command",
        correlationId: "software-resume-required-correlation",
        workId: "software-work",
        task,
        request,
      }),
    ).resolves.toEqual({ outcome: "completed" });
    expect(calls.slice(0, 3)).toEqual([
      "recover",
      "claim",
      "tdd:software-resume-required-run:delivery:lease:5:task:software-task",
    ]);
  });

  it("retryable cleanup 실패는 blocked로 가장하지 않고 metric을 남긴 채 소유권을 보존한다", async () => {
    const metricInputs: unknown[] = [];
    const delivery = {
      deliveryId: "delivery-retryable-cleanup-failure",
      version: 1,
      status: "preparing",
      startCommandId: "software-retryable-cleanup-run:delivery:task:software-task:engineering",
    };
    let recoveryCalls = 0;
    const adapter = new CoreSoftwareTaskAdapter({
      works: {},
      deliveries: {
        findByStartCommand: async () => delivery,
        get: async () => delivery,
      },
      leases: {
        list: async () => [],
        claim: async () => ({
          lease: {
            leaseId: "lease-retryable-cleanup-failure",
            deliveryId: delivery.deliveryId,
            repositoryId: request.softwareDelivery.repositoryId,
            acquireCommandId: "software-retryable-cleanup-run:delivery:lease:2:task:software-task",
            status: "active",
            version: 1,
          },
        }),
        renew: async () => ({
          lease: {
            leaseId: "lease-retryable-cleanup-failure",
            deliveryId: delivery.deliveryId,
            repositoryId: request.softwareDelivery.repositoryId,
            acquireCommandId: "software-retryable-cleanup-run:delivery:lease:2:task:software-task",
            status: "active",
            version: 2,
          },
        }),
      },
      recovery: {
        recover: async () => {
          recoveryCalls += 1;
          if (recoveryCalls === 1) return { delivery, result: "resume_required" };
          throw new Error("retryable cleanup failed");
        },
      },
      proposals: {
        propose: async () => {
          throw new Error("retryable proposal failure", {
            cause: { status: "failed", error: { retryable: true } },
          });
        },
      },
      metrics: {
        recordOnce: async (_context: unknown, _key: string, input: unknown) => {
          metricInputs.push(input);
        },
      },
    } as never);

    await expect(
      adapter.executeTask(context, {
        runId: "software-retryable-cleanup-run",
        leaseGeneration: 2,
        commandId: "software-retryable-cleanup-command",
        correlationId: "software-retryable-cleanup-correlation",
        workId: "software-work",
        task,
        request,
      }),
    ).rejects.toThrow("retryable cleanup failed");
    expect(delivery.status).toBe("preparing");
    expect(metricInputs).toContainEqual(
      expect.objectContaining({ name: "engineering_recovery_total", dimensions: { result: "cleanup_failed" } }),
    );
  });

  it("더 높은 generation이 소유한 Delivery에는 stale generation의 progress·fail·cleanup이 모두 차단된다", async () => {
    let proposalCalls = 0;
    let transitionCalls = 0;
    let recoveryCalls = 0;
    const delivery = {
      deliveryId: "delivery-stale-generation",
      version: 4,
      status: "preparing",
      startCommandId: "software-stale-run:delivery:task:software-task:engineering",
    };
    const adapter = new CoreSoftwareTaskAdapter({
      works: {},
      deliveries: {
        findByStartCommand: async () => delivery,
        transition: async () => {
          transitionCalls += 1;
          return { delivery: { ...delivery, status: "failed" } };
        },
      },
      leases: {
        claim: async () => {
          const error = new Error("stale generation");
          error.name = "EngineeringPathLeaseOwnershipError";
          throw error;
        },
      },
      recovery: {
        recover: async () => {
          recoveryCalls += 1;
          return { delivery, result: "resume_required" };
        },
      },
      proposals: {
        propose: async () => {
          proposalCalls += 1;
          return {};
        },
      },
    } as never);

    await expect(
      adapter.executeTask(context, {
        runId: "software-stale-run",
        leaseGeneration: 2,
        commandId: "software-stale-command",
        correlationId: "software-stale-correlation",
        workId: "software-work",
        task,
        request,
      }),
    ).resolves.toEqual({ outcome: "blocked", reason: "software-delivery-owned" });
    expect({ proposalCalls, transitionCalls, recoveryCalls }).toEqual({
      proposalCalls: 0,
      transitionCalls: 0,
      recoveryCalls: 0,
    });
  });

  it("신규 Delivery의 다른 owner path lease 충돌은 terminal 실패가 아니라 retryable blocked로 남긴다", async () => {
    let delivery = undefined as { deliveryId: string; version: number; status: string } | undefined;
    let failedTransitions = 0;
    const adapter = new CoreSoftwareTaskAdapter({
      works: {
        getWork: async () => ({ revision: 1 }),
        assignTask: async () => ({ work: { revision: 2 }, assignment: { assignment_id: "assignment-contention" } }),
      },
      deliveries: {
        findByStartCommand: async () => delivery,
        transition: async () => {
          failedTransitions += 1;
          return { delivery };
        },
      },
      coordinator: {
        start: async () => {
          delivery = { deliveryId: "delivery-contention", version: 1, status: "preparing" };
          const error = new Error("overlapping path");
          error.name = "EngineeringPathLeaseBusyError";
          throw error;
        },
      },
    } as never);

    await expect(
      adapter.executeTask(context, {
        runId: "software-contention-run",
        leaseGeneration: 1,
        commandId: "software-contention-command",
        correlationId: "software-contention-correlation",
        workId: "software-work",
        task,
        request,
      }),
    ).resolves.toEqual({ outcome: "blocked", reason: "software-delivery-owned" });
    expect(failedTransitions).toBe(0);
    expect(delivery).toMatchObject({ status: "preparing" });
  });

  it.each([
    [true, "blocked"],
    [false, "failed"],
  ] as const)("proposal 실행 실패 retryable=%s를 %s로 분류한다", async (retryable, outcome) => {
    let delivery = {
      deliveryId: `delivery-retryable-${String(retryable)}`,
      version: 1,
      status: "preparing",
      startCommandId: `software-retryable-${String(retryable)}-run:delivery:task:software-task:engineering`,
    };
    let cleanupCalls = 0;
    const adapter = new CoreSoftwareTaskAdapter({
      works: {},
      deliveries: {
        findByStartCommand: async () => delivery,
        get: async () => delivery,
        transition: async (_context: unknown, input: { target: string }) => {
          delivery = { ...delivery, version: delivery.version + 1, status: input.target };
          return { delivery };
        },
      },
      leases: {
        claim: async () => ({
          lease: {
            leaseId: `lease-retryable-${String(retryable)}`,
            deliveryId: delivery.deliveryId,
            repositoryId: request.softwareDelivery.repositoryId,
            acquireCommandId: "owner",
            status: "active",
            version: 1,
          },
        }),
        renew: async () => ({
          lease: {
            leaseId: `lease-retryable-${String(retryable)}`,
            deliveryId: delivery.deliveryId,
            repositoryId: request.softwareDelivery.repositoryId,
            acquireCommandId: "owner",
            status: "active",
            version: 2,
          },
        }),
      },
      recovery: {
        recover: async () => {
          cleanupCalls += 1;
          return { delivery, result: "resume_required" };
        },
      },
      proposals: {
        propose: async () => {
          throw new Error("proposal execution failed", {
            cause: { status: "failed", error: { retryable } },
          });
        },
      },
      metrics: { recordOnce: async () => undefined },
    } as never);

    const result = await adapter.executeTask(context, {
      runId: `software-retryable-${String(retryable)}-run`,
      leaseGeneration: 2,
      commandId: `software-retryable-${String(retryable)}-command`,
      correlationId: `software-retryable-${String(retryable)}-correlation`,
      workId: "software-work",
      task,
      request,
    });
    expect(result.outcome).toBe(outcome);
    expect(delivery.status).toBe(retryable ? "preparing" : "failed");
    expect(cleanupCalls).toBe(retryable ? 2 : 2);
  });

  it("terminal cleanup 실패는 실패 결정을 되돌리지 않고 상태·기간·운영 오류 metric으로 관측한다", async () => {
    const metrics: Array<{ key: string; input: { name: string; value: number; dimensions: unknown } }> = [];
    const delivery = {
      deliveryId: "delivery-cleanup-failed",
      organizationId: context.organizationId,
      workId: "software-work",
      taskId: task.task_id,
      startCommandId: "software-cleanup-failed-run:delivery:task:software-task:engineering",
      version: 3,
      status: "failed",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:01.250Z",
    };
    const adapter = new CoreSoftwareTaskAdapter({
      works: {},
      deliveries: { findByStartCommand: async () => delivery },
      recovery: {
        recover: async () => {
          throw new Error("workspace cleanup failed");
        },
      },
      metrics: {
        recordOnce: async (_context: unknown, key: string, input: never) => {
          metrics.push({ key, input });
        },
      },
    } as never);

    await expect(
      adapter.executeTask(context, {
        runId: "software-cleanup-failed-run",
        commandId: "software-cleanup-failed-command",
        correlationId: "software-cleanup-failed-correlation",
        workId: "software-work",
        task,
        request,
      }),
    ).resolves.toEqual({ outcome: "failed", reason: "software-delivery-failed" });
    expect(metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "delivery:delivery-cleanup-failed:status",
          input: expect.objectContaining({
            name: "engineering_delivery_status_total",
            dimensions: { status: "failed" },
          }),
        }),
        expect.objectContaining({
          key: "delivery:delivery-cleanup-failed:duration",
          input: expect.objectContaining({ name: "engineering_delivery_duration_ms", value: 1_250 }),
        }),
        expect.objectContaining({
          key: "delivery:delivery-cleanup-failed:cleanup-failed",
          input: expect.objectContaining({
            name: "engineering_recovery_total",
            dimensions: { result: "cleanup_failed" },
          }),
        }),
      ]),
    );
  });

  it("Delivery 생성 전 취소 요청이 오면 Engineering delivery를 시작하지 않는다", async () => {
    let releaseWork!: (value: { readonly revision: number }) => void;
    let enteredWork!: () => void;
    const workEntered = new Promise<void>((resolve) => {
      enteredWork = resolve;
    });
    const work = new Promise<{ readonly revision: number }>((resolve) => {
      releaseWork = resolve;
    });
    let startCalls = 0;
    const adapter = new CoreSoftwareTaskAdapter({
      works: {
        getWork: async () => {
          enteredWork();
          return await work;
        },
        assignTask: async () => ({ work: { revision: 2 }, assignment: { assignment_id: "assignment-1" } }),
        listTasks: async () => [],
      },
      deliveries: { findByStartCommand: async () => undefined },
      coordinator: {
        start: async () => {
          startCalls += 1;
          return { delivery: { deliveryId: "delivery-1", status: "preparing" } };
        },
      },
      proposals: { propose: async () => ({}) },
      engine: { execute: async () => ({ delivery: { deliveryId: "delivery-1", status: "failed" } }) },
      finalizer: { finalize: async () => ({}) },
      recovery: { recover: async () => ({}) },
    } as never);
    const common = {
      runId: "software-cancel-before-start-run",
      commandId: "software-cancel-before-start",
      correlationId: "software-cancel-before-start-correlation",
      workId: "software-work",
      task,
      request,
    };

    const executing = adapter.executeTask(context, common as never);
    await workEntered;
    await adapter.cancelTask(context, common as never);
    releaseWork({ revision: 1 });

    await expect(executing).rejects.toThrow("Application run cancelled");
    expect(startCalls).toBe(0);
  });

  it("Delivery 생성 중 취소 요청이 오면 proposal과 TDD를 시작하지 않는다", async () => {
    let releaseStart!: (value: { readonly delivery: { readonly deliveryId: string; readonly status: string } }) => void;
    let enteredStart!: () => void;
    const startEntered = new Promise<void>((resolve) => {
      enteredStart = resolve;
    });
    const start = new Promise<{ readonly delivery: { readonly deliveryId: string; readonly status: string } }>(
      (resolve) => {
        releaseStart = resolve;
      },
    );
    const delivery = { deliveryId: "delivery-2", version: 1, status: "preparing" };
    let findCalls = 0;
    let proposalCalls = 0;
    const transitions: string[] = [];
    const adapter = new CoreSoftwareTaskAdapter({
      works: {
        getWork: async () => ({ revision: 1 }),
        assignTask: async () => ({ work: { revision: 2 }, assignment: { assignment_id: "assignment-2" } }),
        listTasks: async () => [],
      },
      deliveries: {
        findByStartCommand: async () => {
          findCalls += 1;
          return findCalls === 1 ? undefined : delivery;
        },
        transition: async (_context: unknown, value: { readonly target: string }) => {
          transitions.push(value.target);
          delivery.status = value.target;
          delivery.version += 1;
          return { delivery };
        },
      },
      coordinator: {
        start: async () => {
          enteredStart();
          return await start;
        },
      },
      proposals: {
        propose: async () => {
          proposalCalls += 1;
          return {};
        },
      },
      engine: { execute: async () => ({ delivery: { ...delivery, status: "committed" } }) },
      finalizer: { finalize: async () => ({}) },
      recovery: { recover: async () => ({}) },
    } as never);
    const common = {
      runId: "software-cancel-during-start-run",
      commandId: "software-cancel-during-start",
      correlationId: "software-cancel-during-start-correlation",
      workId: "software-work",
      task,
      request,
    };

    const executing = adapter.executeTask(context, common as never);
    await startEntered;
    await adapter.cancelTask(context, common as never);
    releaseStart({ delivery });

    await expect(executing).rejects.toThrow("Application run cancelled");
    expect(transitions).toEqual(["cancelled"]);
    expect(proposalCalls).toBe(0);
  });

  it("코드 제안 중 취소 요청이 오면 TDD 실행을 시작하지 않는다", async () => {
    let releaseProposal!: (value: Record<string, unknown>) => void;
    let enteredProposal!: () => void;
    const proposalEntered = new Promise<void>((resolve) => {
      enteredProposal = resolve;
    });
    const proposal = new Promise<Record<string, unknown>>((resolve) => {
      releaseProposal = resolve;
    });
    const delivery = { deliveryId: "delivery-3", version: 1, status: "preparing" };
    const transitions: string[] = [];
    let tddCalls = 0;
    const adapter = new CoreSoftwareTaskAdapter({
      works: {
        getWork: async () => ({ revision: 1 }),
        listTasks: async () => [],
        assignTask: async () => ({ work: { revision: 2 }, assignment: { assignment_id: "assignment-3" } }),
      },
      deliveries: {
        findByStartCommand: async () => delivery,
        transition: async (_context: unknown, value: { readonly target: string }) => {
          transitions.push(value.target);
          delivery.status = value.target;
          delivery.version += 1;
          return { delivery };
        },
      },
      coordinator: { start: async () => ({ delivery }) },
      proposals: {
        propose: async () => {
          enteredProposal();
          return await proposal;
        },
      },
      engine: {
        execute: async () => {
          tddCalls += 1;
          return { delivery: { ...delivery, status: "committed" } };
        },
      },
      finalizer: { finalize: async () => ({}) },
      recovery: { recover: async () => ({}) },
    } as never);
    const common = {
      runId: "software-cancel-during-proposal-run",
      commandId: "software-cancel-during-proposal",
      correlationId: "software-cancel-during-proposal-correlation",
      workId: "software-work",
      task,
      request,
    };

    const executing = adapter.executeTask(context, common as never);
    await proposalEntered;
    await adapter.cancelTask(context, common as never);
    releaseProposal({});

    await expect(executing).rejects.toThrow("Application run cancelled");
    expect(transitions).toEqual(["cancelled"]);
    expect(tddCalls).toBe(0);
  });

  it.each(["failed", "cancelled"] as const)(
    "이미 terminal %s인 Delivery는 결과를 보존하고 finalizer를 호출하지 않는다",
    async (status) => {
      let finalizerCalls = 0;
      const delivery = { deliveryId: `delivery-terminal-${status}`, version: 3, status };
      const adapter = new CoreSoftwareTaskAdapter({
        works: {},
        deliveries: {
          findByStartCommand: async () => delivery,
          get: async () => delivery,
          transition: async () => {
            throw new Error("terminal Delivery를 변경하면 안 됩니다");
          },
        },
        coordinator: {
          start: async () => {
            throw new Error("terminal Delivery를 다시 만들면 안 됩니다");
          },
        },
        proposals: {
          propose: async () => {
            throw new Error("terminal Delivery의 proposal을 다시 실행하면 안 됩니다");
          },
        },
        engine: {
          execute: async () => {
            throw new Error("terminal Delivery의 TDD를 다시 실행하면 안 됩니다");
          },
        },
        finalizer: {
          finalize: async () => {
            finalizerCalls += 1;
            return {};
          },
        },
        recovery: { recover: async () => ({ delivery, result: "cleaned_terminal" }) },
      } as never);

      await expect(
        adapter.executeTask(context, {
          runId: "software-terminal-run",
          commandId: "software-terminal-command",
          correlationId: "software-terminal-correlation",
          workId: "software-work",
          task,
          request,
        }),
      ).resolves.toEqual({ outcome: status, reason: `software-delivery-${status}` });
      expect(finalizerCalls).toBe(0);
    },
  );

  it("TDD 엔진이 Delivery를 failed로 확정한 뒤 던져도 terminal 결과를 반환한다", async () => {
    let delivery = { deliveryId: "delivery-tdd-failed", version: 1, status: "preparing" };
    let finalizerCalls = 0;
    const adapter = new CoreSoftwareTaskAdapter({
      works: {},
      deliveries: {
        findByStartCommand: async () => delivery,
        get: async () => delivery,
        transition: async () => {
          throw new Error("TDD 엔진이 이미 terminal 상태를 저장했습니다");
        },
      },
      proposals: {
        propose: async () => ({
          testPatch: "test",
          implementationPatch: "implementation",
          focusedCommand: {},
          redFailureMarker: "RED",
          validationCommands: [],
          commitMessage: "feat: fail",
        }),
      },
      engine: {
        execute: async () => {
          delivery = { ...delivery, version: 2, status: "failed" };
          throw new Error("Focused test GREEN이 실패했습니다");
        },
      },
      finalizer: {
        finalize: async () => {
          finalizerCalls += 1;
          return {};
        },
      },
      recovery: { recover: async () => ({ delivery, result: "cleaned_terminal" }) },
    } as never);

    await expect(
      adapter.executeTask(context, {
        runId: "software-tdd-failed-run",
        commandId: "software-tdd-failed-command",
        correlationId: "software-tdd-failed-correlation",
        workId: "software-work",
        task,
        request,
      }),
    ).resolves.toEqual({ outcome: "failed", reason: "software-delivery-failed" });
    expect(finalizerCalls).toBe(0);
  });

  it("모델 부재는 blocked로 유지하고 재시도에서도 같은 Delivery를 이어서 사용한다", async () => {
    const startCommands: string[] = [];
    let coordinatorCalls = 0;
    let proposalCalls = 0;
    let delivery: { deliveryId: string; version: number; status: string } | undefined;
    const adapter = new CoreSoftwareTaskAdapter({
      works: {
        getWork: async () => ({ revision: 2 }),
        listTasks: async () => [{ ...task, status: "running", revision: 2 }],
        assignTask: async () => ({ work: { revision: 2 }, assignment: { assignment_id: "assignment-retry" } }),
      },
      deliveries: {
        findByStartCommand: async (_context: unknown, commandId: string) => {
          startCommands.push(commandId);
          return delivery;
        },
        get: async () => delivery,
        transition: async () => {
          throw new Error("모델 부재는 Delivery를 terminal로 바꾸면 안 됩니다");
        },
      },
      coordinator: {
        start: async () => {
          coordinatorCalls += 1;
          delivery = { deliveryId: "delivery-model-retry", version: 1, status: "preparing" };
          return { delivery };
        },
      },
      proposals: {
        propose: async () => {
          proposalCalls += 1;
          if (proposalCalls === 1) {
            throw new Error("Software patch proposal execution이 실패했습니다: blocked_model_unavailable", {
              cause: { status: "blocked_model_unavailable" },
            });
          }
          return {
            testPatch: "test",
            implementationPatch: "implementation",
            focusedCommand: {},
            redFailureMarker: "RED",
            validationCommands: [],
            commitMessage: "feat: retry",
          };
        },
      },
      engine: {
        execute: async () => {
          delivery = { deliveryId: "delivery-model-retry", version: 2, status: "committed" };
          return { delivery };
        },
      },
      finalizer: { finalize: async () => ({}) },
      recovery: { recover: async () => ({ delivery, result: "cleaned_terminal" }) },
    } as never);
    const common = {
      runId: "software-model-retry-run",
      correlationId: "software-model-retry-correlation",
      workId: "software-work",
      task,
      request,
    };

    await expect(
      adapter.executeTask(context, { ...common, commandId: "software-model-retry-run:delivery:task:software-task" }),
    ).resolves.toEqual({ outcome: "blocked", reason: "model-unavailable" });
    await expect(
      adapter.executeTask(context, {
        ...common,
        commandId: "software-model-retry-run:delivery:retry:attempt-1:task:software-task",
      }),
    ).resolves.toEqual({ outcome: "completed" });
    expect(coordinatorCalls).toBe(1);
    expect(startCommands).toEqual([
      "software-model-retry-run:delivery:task:software-task:engineering",
      "software-model-retry-run:delivery:task:software-task:engineering",
    ]);
  });
});
