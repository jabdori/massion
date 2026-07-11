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
});
