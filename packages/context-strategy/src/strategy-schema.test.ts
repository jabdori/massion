import { describe, expect, it } from "vitest";

import { validateStrategyPlan, type StrategyPlan } from "./index.js";

export const VALID_STRATEGY_PLAN: StrategyPlan = {
  objective: "Massion 완제품을 구현한다",
  summary: "설계, 구현과 검증을 순서대로 수행한다",
  scopeIn: ["Context & Strategy"],
  scopeOut: ["Repository Index"],
  assumptions: ["Phase 8 완료"],
  unknowns: ["외부 근거 추가 조사"],
  acceptanceCriteria: [
    {
      key: "criterion-tests",
      statement: "전체 테스트가 통과한다",
      method: "test",
      evidenceKinds: ["test-report"],
      planLevel: false,
    },
  ],
  risks: [
    {
      key: "risk-migration",
      description: "migration 충돌",
      likelihood: "low",
      impact: "high",
      mitigation: "고정 ID와 checksum을 검증한다",
      requiresApproval: false,
    },
  ],
  tasks: [
    {
      key: "design",
      title: "설계",
      objective: "계약을 고정한다",
      criterionKeys: [],
      dependencyKeys: [],
      requiredCapabilities: ["architecture"],
      recommendedAgentHandles: ["context-strategy"],
      parallelizable: false,
    },
    {
      key: "verify",
      title: "검증",
      objective: "테스트를 실행한다",
      criterionKeys: ["criterion-tests"],
      dependencyKeys: ["design"],
      requiredCapabilities: ["testing"],
      recommendedAgentHandles: ["assurance"],
      parallelizable: false,
    },
  ],
  evidenceRequests: [{ key: "evidence-runtime", question: "Runtime 계약이 최신인가", required: true }],
};

function required<Value>(value: Value | undefined, label: string): Value {
  if (value === undefined) throw new Error(`테스트 fixture가 없습니다: ${label}`);
  return value;
}

describe("StrategyPlan schema", () => {
  it("유효한 계획을 정규화한다", () => {
    expect(validateStrategyPlan(VALID_STRATEGY_PLAN)).toEqual(VALID_STRATEGY_PLAN);
  });

  it("존재하지 않는 criterion과 dependency를 거부한다", () => {
    expect(() =>
      validateStrategyPlan({
        ...VALID_STRATEGY_PLAN,
        tasks: [{ ...required(VALID_STRATEGY_PLAN.tasks[0], "first task"), criterionKeys: ["missing"] }],
      }),
    ).toThrow("criterion");
    expect(() =>
      validateStrategyPlan({
        ...VALID_STRATEGY_PLAN,
        tasks: [{ ...required(VALID_STRATEGY_PLAN.tasks[0], "first task"), dependencyKeys: ["missing"] }],
      }),
    ).toThrow("dependency");
  });

  it("Task cycle과 중복 key를 거부한다", () => {
    expect(() =>
      validateStrategyPlan({
        ...VALID_STRATEGY_PLAN,
        tasks: [
          { ...required(VALID_STRATEGY_PLAN.tasks[0], "first task"), dependencyKeys: ["verify"] },
          required(VALID_STRATEGY_PLAN.tasks[1], "second task"),
        ],
      }),
    ).toThrow("cycle");
    expect(() =>
      validateStrategyPlan({
        ...VALID_STRATEGY_PLAN,
        tasks: [
          required(VALID_STRATEGY_PLAN.tasks[0], "first task"),
          { ...required(VALID_STRATEGY_PLAN.tasks[0], "first task") },
        ],
      }),
    ).toThrow("중복");
  });

  it("critical risk는 mitigation과 사람 승인을 요구한다", () => {
    expect(() =>
      validateStrategyPlan({
        ...VALID_STRATEGY_PLAN,
        risks: [
          {
            ...required(VALID_STRATEGY_PLAN.risks[0], "first risk"),
            impact: "critical",
            mitigation: "",
            requiresApproval: false,
          },
        ],
      }),
    ).toThrow("critical");
  });
});
