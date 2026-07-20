import { describe, expect, it } from "vitest";

import {
  AGENT_ROLES,
  DESIGN_TOKENS,
  USER_STAGES,
  WORK_STATUS_TOKENS,
  agentRoleToken,
  userStageForInternal,
  userStageIndex,
  userStageProgress,
  workStatusToken,
} from "./design-tokens.js";

describe("Massion 공통 디자인 토큰", () => {
  it("모든 Work 상태에 심볼·기술 라벨·사용자 라벨·의미 색상이 있다", () => {
    for (const status of ["ready", "running", "awaiting-approval", "blocked", "failed", "completed", "cancelled"]) {
      const token = workStatusToken(status);
      expect(token.symbol).toBeTruthy();
      expect(token.label).toBeTruthy();
      expect(token.friendlyLabel).toBeTruthy();
      expect(token.semantic).toBeTruthy();
    }
  });

  it("알 수 없는 상태도 기본 토큰을 반환한다", () => {
    const token = workStatusToken("unknown-state");
    expect(token.symbol).toBe("?");
    expect(token.friendlyLabel).toBe("unknown-state");
  });

  it("내부 6단계를 사용자용 4단계로 번역한다", () => {
    expect(USER_STAGES.length).toBe(4);
    expect(userStageForInternal("intake").id).toBe("understand");
    expect(userStageForInternal("evidence").id).toBe("prepare");
    expect(userStageForInternal("delivery").id).toBe("work");
    expect(userStageForInternal("assurance").id).toBe("verify");
  });

  it("사용자 단계 진행도를 계산한다", () => {
    expect(userStageProgress("delivery", "understand")).toBe("completed");
    expect(userStageProgress("delivery", "work")).toBe("current");
    expect(userStageProgress("delivery", "verify")).toBe("pending");
  });

  it("Agent 역할에 사용자 친화적 라벨이 있다", () => {
    expect(agentRoleToken("representative").friendlyLabel).toBe("요청 정리 담당");
    expect(agentRoleToken("assurance").friendlyLabel).toBe("결과 검토 담당");
  });

  it("Light theme이 기본이고 따뜻한 색상을 사용한다", () => {
    expect(DESIGN_TOKENS.light.canvas).not.toBe("#FFFFFF");
    expect(DESIGN_TOKENS.status.running).toBeTruthy();
  });
});
