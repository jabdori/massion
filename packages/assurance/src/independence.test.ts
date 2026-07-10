import { describe, expect, it } from "vitest";

import { verifyAssuranceIndependence, type AssuranceIndependenceInput } from "./independence.js";

function input(): AssuranceIndependenceInput {
  return {
    phase: "start",
    organizationId: "organization-1",
    workId: "work-1",
    verifierHandle: "assurance",
    verifierNodeActive: true,
    verifierExecution: {
      executionId: "execution-assurance",
      organizationId: "organization-1",
      workId: "work-1",
      agentHandle: "assurance",
      status: "running",
    },
    tasks: [
      { taskId: "task-1", status: "completed" },
      { taskId: "task-cancelled", status: "cancelled" },
    ],
    assignments: [
      { taskId: "task-1", agentHandle: "software-implementation", status: "released" },
      { taskId: "task-1", agentHandle: "software-review", status: "assigned" },
      { taskId: "task-cancelled", agentHandle: "cancelled-worker", status: "assigned" },
    ],
    referencedExecutions: [
      {
        executionId: "execution-artifact",
        organizationId: "organization-1",
        workId: "work-1",
        agentHandle: "artifact-author",
        status: "succeeded",
      },
    ],
    artifacts: [
      {
        kind: "code-change",
        createdBy: "software-engineering",
        contentJson: JSON.stringify({
          schemaVersion: "massion.code-change-manifest.v1",
          agentHandle: "software-engineering.backend-specialist",
        }),
      },
    ],
    checkExecutors: [
      {
        kind: "runtime_agent",
        handle: "security-review",
        execution: {
          executionId: "execution-security",
          organizationId: "organization-1",
          workId: "work-1",
          agentHandle: "security-review",
          status: "succeeded",
        },
      },
      { kind: "system_adapter", adapterId: "massion.command.v1" },
    ],
  };
}

describe("Assurance 독립성", () => {
  it("non-cancelled Assignment 전체 계보·artifact execution·code-change delivery Agent를 contributor로 계산한다", () => {
    const result = verifyAssuranceIndependence(input());

    expect(result.contributorHandles).toEqual([
      "artifact-author",
      "software-engineering",
      "software-engineering.backend-specialist",
      "software-implementation",
      "software-review",
    ]);
    expect(result.checkExecutorHandles).toEqual(["security-review"]);
  });

  it.each([
    [{ verifierNodeActive: false }, "활성 Assurance"],
    [{ verifierHandle: "software-review" }, "assurance handle"],
    [{ verifierExecution: { ...input().verifierExecution, organizationId: "organization-2" } }, "organization"],
    [{ verifierExecution: { ...input().verifierExecution, workId: "work-2" } }, "Work"],
    [{ verifierExecution: { ...input().verifierExecution, status: "failed" } }, "queued 또는 running"],
    [{ verifierExecution: { ...input().verifierExecution, agentHandle: "software-implementation" } }, "handle"],
  ] as const)("비활성·다른 tenant/Work/handle/status verifier를 거부한다: %s", (change, error) => {
    expect(() => verifyAssuranceIndependence({ ...input(), ...change } as AssuranceIndependenceInput)).toThrow(error);
  });

  it("Assignment·delivery contributor의 self-review와 contributor check executor를 거부한다", () => {
    expect(() =>
      verifyAssuranceIndependence({
        ...input(),
        assignments: [...input().assignments, { taskId: "task-1", agentHandle: "assurance", status: "released" }],
      }),
    ).toThrow("contributor");
    const selfCheck = input();
    expect(() =>
      verifyAssuranceIndependence({
        ...selfCheck,
        checkExecutors: [
          {
            kind: "runtime_agent",
            handle: "software-engineering.backend-specialist",
            execution: {
              executionId: "execution-self-check",
              organizationId: "organization-1",
              workId: "work-1",
              agentHandle: "software-engineering.backend-specialist",
              status: "succeeded",
            },
          },
        ],
      }),
    ).toThrow("check executor");
  });

  it("판정 단계에서는 verifier Runtime Execution succeeded와 output hash를 요구한다", () => {
    expect(() => verifyAssuranceIndependence({ ...input(), phase: "verdict" })).toThrow("succeeded");
    expect(() =>
      verifyAssuranceIndependence({
        ...input(),
        phase: "verdict",
        verifierExecution: { ...input().verifierExecution, status: "succeeded" },
      }),
    ).toThrow("output hash");
    expect(() =>
      verifyAssuranceIndependence({
        ...input(),
        phase: "verdict",
        verifierExecution: { ...input().verifierExecution, status: "succeeded", outputHash: "a".repeat(64) },
      }),
    ).not.toThrow();
  });
});
