import { describe, expect, it } from "vitest";

import { compileAssuranceCriteria, type CriterionBindingCoverage } from "./criteria.js";
import { selectAssuranceProfile } from "./profile.js";

const plan = {
  acceptanceCriteria: [
    {
      key: "criterion:tests",
      statement: "테스트를 통과한다",
      method: "test",
      evidenceKinds: ["command"],
      planLevel: false,
    },
    {
      key: "criterion:approval",
      statement: "소유자가 결과를 승인한다",
      method: "human",
      evidenceKinds: ["attestation"],
      planLevel: true,
    },
  ],
};

function bindings(...extra: CriterionBindingCoverage[]): CriterionBindingCoverage[] {
  return [
    { criterionKey: "criterion:tests", method: "test", requiredEvidenceKinds: ["command"] },
    { criterionKey: "criterion:approval", method: "human", requiredEvidenceKinds: ["attestation"] },
    { criterionKey: "profile:acceptance:coverage", method: "evidence", requiredEvidenceKinds: ["check-result"] },
    ...extra,
  ];
}

describe("Assurance criterion compiler", () => {
  it("Plan stable key와 수동 Task key를 누락 없이 결정적으로 compile한다", () => {
    const compiled = compileAssuranceCriteria({
      planContentJson: JSON.stringify(plan),
      tasks: [
        {
          taskId: "task-b",
          status: "completed",
          acceptanceCriteriaJson: JSON.stringify(["문서를 갱신한다"]),
        },
        {
          taskId: "task-a",
          status: "completed",
          acceptanceCriteriaJson: JSON.stringify([plan.acceptanceCriteria[0]]),
        },
      ],
      profile: selectAssuranceProfile([]),
      bindings: bindings({
        criterionKey: "task:task-b:0",
        method: "inspection",
        requiredEvidenceKinds: ["document"],
      }),
    });

    expect(compiled.map((criterion) => criterion.criterionKey)).toEqual([
      "criterion:approval",
      "criterion:tests",
      "profile:acceptance:coverage",
      "task:task-b:0",
    ]);
    expect(compiled.find((criterion) => criterion.criterionKey === "criterion:tests")?.taskIds).toEqual(["task-a"]);
    expect(compiled.find((criterion) => criterion.criterionKey === "task:task-b:0")).toMatchObject({
      source: "task",
      statement: "문서를 갱신한다",
      method: "inspection",
    });
  });

  it("중복 충돌, binding 누락, method 불일치와 상한 초과를 거부한다", () => {
    expect(() =>
      compileAssuranceCriteria({
        planContentJson: JSON.stringify(plan),
        tasks: [
          {
            taskId: "task-a",
            status: "completed",
            acceptanceCriteriaJson: JSON.stringify([{ ...plan.acceptanceCriteria[0], statement: "다른 문장" }]),
          },
        ],
        profile: selectAssuranceProfile([]),
        bindings: bindings(),
      }),
    ).toThrow("충돌");
    expect(() =>
      compileAssuranceCriteria({
        planContentJson: JSON.stringify(plan),
        tasks: [],
        profile: selectAssuranceProfile([]),
        bindings: bindings().filter((binding) => binding.criterionKey !== "criterion:approval"),
      }),
    ).toThrow("binding이 없습니다");
    expect(() =>
      compileAssuranceCriteria({
        planContentJson: JSON.stringify(plan),
        tasks: [],
        profile: selectAssuranceProfile([]),
        bindings: bindings().map((binding) =>
          binding.criterionKey === "criterion:tests" ? { ...binding, method: "metric" as const } : binding,
        ),
      }),
    ).toThrow("method");
    const tooMany = Array.from({ length: 101 }, (_, index) => ({
      taskId: `task-${String(index)}`,
      status: "completed" as const,
      acceptanceCriteriaJson: JSON.stringify([`criterion ${String(index)}`]),
    }));
    expect(() =>
      compileAssuranceCriteria({
        planContentJson: JSON.stringify({ acceptanceCriteria: [] }),
        tasks: tooMany,
        profile: { ...selectAssuranceProfile([]), criteria: [] },
        bindings: tooMany.map((task) => ({
          criterionKey: `task:${task.taskId}:0`,
          method: "evidence" as const,
          requiredEvidenceKinds: [],
        })),
      }),
    ).toThrow("100개");
    expect(() =>
      compileAssuranceCriteria({
        planContentJson: JSON.stringify(plan),
        tasks: [],
        profile: selectAssuranceProfile([]),
        bindings: [
          ...bindings(),
          {
            criterionKey: "criterion:tests",
            method: "test",
            requiredEvidenceKinds: Array.from({ length: 20 }, (_, index) => `extra-${String(index)}`),
          },
        ],
      }),
    ).toThrow("evidence kind");
  });

  it("cancelled-only non-plan criterion만 명시적 사유로 제외한다", () => {
    const compiled = compileAssuranceCriteria({
      planContentJson: JSON.stringify(plan),
      tasks: [
        {
          taskId: "task-cancelled",
          status: "cancelled",
          acceptanceCriteriaJson: JSON.stringify([plan.acceptanceCriteria[0]]),
        },
      ],
      profile: selectAssuranceProfile([]),
      bindings: bindings(),
      exclusions: {
        "criterion:tests": {
          rule: "cancelled-task-only",
          reason: "기능 범위가 취소됐습니다",
          actorId: "context-strategy",
        },
      },
    });

    expect(compiled.find((criterion) => criterion.criterionKey === "criterion:tests")).toMatchObject({
      status: "excluded",
      exclusionRule: "cancelled-task-only",
      exclusionActorId: "context-strategy",
    });
    expect(() =>
      compileAssuranceCriteria({
        planContentJson: JSON.stringify(plan),
        tasks: [],
        profile: selectAssuranceProfile([]),
        bindings: bindings(),
        exclusions: {
          "criterion:approval": {
            rule: "cancelled-task-only",
            reason: "제외",
            actorId: "context-strategy",
          },
        },
      }),
    ).toThrow("plan-level");
    expect(() =>
      compileAssuranceCriteria({
        planContentJson: JSON.stringify(plan),
        tasks: [
          {
            taskId: "task-cancelled",
            status: "cancelled",
            acceptanceCriteriaJson: JSON.stringify([plan.acceptanceCriteria[0]]),
          },
        ],
        profile: selectAssuranceProfile([]),
        bindings: bindings(),
        exclusions: {
          "criterion:tests": {
            rule: "cancelled-task-only",
            reason: "x".repeat(1_001),
            actorId: "context-strategy",
          },
        },
      }),
    ).toThrow("1000자");
  });
});
