import { GovernanceApprovalRequiredError } from "@massion/governance";
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
  objective: "기능 구현",
  acceptance_criteria_json: JSON.stringify([{ statement: "테스트가 통과한다" }]),
  recommended_agent_handles: ["software-engineering.backend-specialist"],
  revision: 1,
};
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

describe("CoreSoftwareTaskAdapter", () => {
  it("배정→TDD→승인 대기 후 같은 Delivery를 승인 ID로 최종화한다", async () => {
    const calls: string[] = [];
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
        propose: async (_context: unknown, input: { acceptanceCriteria: readonly string[] }) => {
          calls.push(`propose:${input.acceptanceCriteria[0]}`);
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
      commandId: "software-command",
      correlationId: "software-correlation",
      workId: "software-work",
      task,
      request,
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
  });

  it("취소 시 Delivery를 terminal로 전이한 뒤 격리 workspace 복구 정리를 실행한다", async () => {
    const calls: string[] = [];
    const delivery = { deliveryId: "delivery-2", version: 3, status: "red_verified" };
    const adapter = new CoreSoftwareTaskAdapter({
      works: {},
      deliveries: {
        findByStartCommand: async () => delivery,
        transition: async (_context: unknown, input: { target: string }) => {
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
      commandId: "software-command-2",
      workId: "software-work",
      task: task as never,
      request,
    });
    expect(calls).toEqual(["cancelled", "recover"]);
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
});
