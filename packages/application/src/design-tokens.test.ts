import { describe, expect, it } from "vitest";

import {
  AGENT_CALL_SIGNS,
  DESIGN_TOKENS,
  USER_STAGES,
  agentIdentityToken,
  agentRoleToken,
  userStageForInternal,
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

  it("Core Office 8팀 전부에 사람이 읽는 역할 라벨이 있다", () => {
    // 빠진 handle은 fallback으로 자기 자신을 돌려주므로 화면에 handle이 그대로 나옵니다.
    // 조용히 통과하는 실패라 여기서 8개를 다 확인합니다.
    const coreOffice = [
      "representative",
      "context-strategy",
      "evidence-research",
      "governance",
      "delivery-coordination",
      "assurance",
      "records-documentation",
      "growth",
    ];
    for (const handle of coreOffice) {
      expect(`${handle} → ${agentRoleToken(handle).friendlyLabel}`).not.toBe(`${handle} → ${handle}`);
    }
    expect(agentRoleToken("representative").friendlyLabel).toBe("사용자 요청 접수");
    expect(agentRoleToken("assurance").friendlyLabel).toBe("독립 검증");
  });

  it("Light theme이 기본이고 따뜻한 색상을 사용한다", () => {
    expect(DESIGN_TOKENS.light.canvas).not.toBe("#FFFFFF");
    expect(DESIGN_TOKENS.status.running).toBeTruthy();
  });
});

describe("에이전트 정체성 토큰", () => {
  it("호출부호는 첫 글자가 서로 겹치지 않는다", () => {
    // 아바타가 한 글자만 보여주므로 이니셜이 겹치면 병렬 실행에서 구분이 불가능해집니다.
    const initials = AGENT_CALL_SIGNS.map((name) => name.slice(0, 1));
    expect(new Set(initials).size).toBe(AGENT_CALL_SIGNS.length);
  });

  it("Core Office는 이름과 색 슬롯을 고정한다", () => {
    expect(agentIdentityToken("representative").name).toBe("Atlas");
    expect(agentIdentityToken("assurance")).toMatchObject({ name: "Iris", accentSlot: 5, builtin: true });
    // 재시작이나 표면 전환으로 이름이 바뀌면 사용자가 같은 에이전트를 알아볼 수 없습니다.
    expect(agentIdentityToken("growth")).toEqual(agentIdentityToken("growth"));
  });

  it("같은 역할이 병렬로 있어도 이름이 갈린다", () => {
    // scope:"work" 임시 조사 노드 둘. 역할은 같고 handle만 다릅니다.
    const first = agentIdentityToken("evidence-research-cohort", "자료 확인 담당");
    const second = agentIdentityToken("evidence-research-pricing", "자료 확인 담당");

    expect(first.roleLabel).toBe(second.roleLabel);
    expect(first.name).not.toBe(second.name);
    expect(first.handle).not.toBe(second.handle);
  });

  it("동적 노드는 Core Office 이름을 빼앗지 않는다", () => {
    const builtinNames = new Set(AGENT_CALL_SIGNS.slice(0, 8));
    for (const handle of ["quant-analysis", "pricing-review", "release-eng", "ext:slack", "a", ""]) {
      expect(builtinNames.has(agentIdentityToken(handle).name)).toBe(false);
    }
  });

  it("색 슬롯은 팔레트 범위 안에 있다", () => {
    for (const handle of ["quant-analysis", "representative", "ext:github", "무작위-핸들"]) {
      const slot = agentIdentityToken(handle).accentSlot;
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(8);
    }
  });
});
