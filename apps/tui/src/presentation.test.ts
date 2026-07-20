import { describe, expect, it } from "vitest";

import { present, safeTerminalText } from "./presentation.js";
import { createTuiState, reduceTuiState } from "./state.js";
import { testSnapshot } from "./state.test.js";
import { decodeSnapshot } from "./wire.js";

describe("TUI presentation", () => {
  it("ANSI·control sequence를 화면 문자열에서 제거한다", () => {
    expect(safeTerminalText("정상\u001b[31m위험\u0007")).toBe("정상�[31m위험�");
  });

  it("일곱 view가 같은 snapshot에서 친화적 화면 이름으로 안내한다", () => {
    const friendlyLabels: Readonly<Record<string, string>> = {
      overview: "개요",
      agents: "협업",
      works: "작업",
      chat: "대화",
      approvals: "확인",
      operations: "운영",
      subscriptions: "구독",
    };
    let state = reduceTuiState(createTuiState(), { type: "snapshot.loaded", snapshot: decodeSnapshot(testSnapshot) });
    for (const view of ["overview", "agents", "works", "chat", "approvals", "operations", "subscriptions"] as const) {
      state = reduceTuiState(state, { type: "view.selected", view });
      const output = present(state);
      // 숫자 키 없이 친화적 화면 이름을 표시한다
      expect(output.navigation).toContain(friendlyLabels[view]);
      expect(output.navigation).not.toContain("[1");
      expect(output.footer).toContain("n 새 작업");
      expect(output.list.length + output.detail.length).toBeGreaterThan(20);
    }
  });

  it("승인함이 비어 있어도 자동 정책의 정상 상태임을 설명한다", () => {
    const empty = decodeSnapshot({ ...testSnapshot, pendingApprovals: [] });
    let state = reduceTuiState(createTuiState(), { type: "snapshot.loaded", snapshot: empty });
    state = reduceTuiState(state, { type: "view.selected", view: "approvals" });
    expect(present(state).list).toContain("자동 반영 정책");
  });

  it("업무가 비어 있으면 외부 명령 대신 TUI 안의 새 업무 동작을 안내한다", () => {
    const empty = decodeSnapshot({ ...testSnapshot, works: [], tasks: [], assignments: [], executions: [], rooms: [] });
    let state = reduceTuiState(createTuiState(), { type: "snapshot.loaded", snapshot: empty });
    state = reduceTuiState(state, { type: "view.selected", view: "works" });

    const output = present(state);
    expect(output.list).toContain("n 키");
    expect(output.list).not.toContain("massion run");
  });

  it("작업 홈은 4단계 진행 바와 친화적 상태를 표시하고 자세히 보기로 기술 정보를 보여준다", () => {
    let state = reduceTuiState(createTuiState(), { type: "snapshot.loaded", snapshot: decodeSnapshot(testSnapshot) });
    state = reduceTuiState(state, { type: "view.selected", view: "works" });

    const friendly = present(state);
    // 친화적 진행 바: 사용자용 4단계 라벨이 모두 표시된다
    expect(friendly.detail).toContain("요청 이해");
    expect(friendly.detail).toContain("자료와 계획 준비");
    expect(friendly.detail).toContain("작업 진행");
    expect(friendly.detail).toContain("결과 확인");
    // running → "진행 중이에요" 친화적 상태 라벨
    expect(friendly.detail).toContain("진행 중이에요");
    expect(friendly.detail).toContain("최근 소식");

    // 자세히 보기(D)를 켜면 기술 상세로 전환된다
    state = reduceTuiState(state, { type: "inspector.toggled" });
    const technical = present(state);
    expect(technical.detail).toContain("작업(Task)");
    expect(technical.detail).toContain("실행(Execution)");
    expect(technical.navigation).toContain("자세히 보기");
  });

  it("승인 상세에 실행 파일·비밀 제거 인수·작업 경로와 제공자 이유를 표시한다", () => {
    let state = reduceTuiState(createTuiState(), { type: "snapshot.loaded", snapshot: decodeSnapshot(testSnapshot) });
    state = reduceTuiState(state, { type: "view.selected", view: "approvals" });

    const output = present(state);
    expect(output.detail).toContain("명령 실행");
    expect(output.detail).toContain("git");
    expect(output.detail).toContain("status --short");
    expect(output.detail).toContain("/workspace/project");
    expect(output.detail).toContain("변경 상태 확인");
  });

  it("구독 화면은 공개 필드만 표시하고 조회별 오류와 알 수 없는 할당량을 구분한다", () => {
    let state = reduceTuiState(createTuiState(), { type: "snapshot.loaded", snapshot: decodeSnapshot(testSnapshot) });
    state = reduceTuiState(state, { type: "view.selected", view: "subscriptions" });
    state = reduceTuiState(state, {
      type: "query.loaded",
      key: "subscriptionAccounts",
      value: [
        {
          accountId: "account-1",
          providerId: "openai-codex",
          alias: "업무용 Codex",
          scope: "personal",
          canManage: true,
          status: "active",
          version: 2,
          connectorStatus: "ready",
          token: "never-render-token",
          ownerUserId: "never-render-owner",
          profileFingerprint: "never-render-fingerprint",
          publicKey: "never-render-key",
        },
      ],
    });
    state = reduceTuiState(state, { type: "subscription.tab.selected", tab: "accounts" });
    state = reduceTuiState(state, {
      type: "query.failed",
      key: "subscriptionQuota",
      error: "할당량 서비스에 연결할 수 없습니다",
    });

    const output = present(state);
    const serialized = `${output.navigation}\n${output.list}\n${output.detail}\n${output.footer}`;
    expect(serialized).toContain("업무용 Codex");
    expect(serialized).toContain("할당량 확인 불가");
    expect(serialized).toContain("subscriptionQuota: 할당량 서비스에 연결할 수 없습니다");
    for (const forbidden of [
      "never-render-token",
      "never-render-owner",
      "never-render-fingerprint",
      "never-render-key",
    ])
      expect(serialized).not.toContain(forbidden);
  });

  it("Provider 탭은 실제 연결 위치와 runtime 격리·성숙도를 표시한다", () => {
    let state = reduceTuiState(createTuiState(), { type: "snapshot.loaded", snapshot: decodeSnapshot(testSnapshot) });
    state = reduceTuiState(state, { type: "view.selected", view: "subscriptions" });
    state = reduceTuiState(state, {
      type: "query.loaded",
      key: "subscriptionProviders",
      value: [
        {
          providerId: "github-copilot",
          displayName: "GitHub Copilot ACP",
          availability: "experimental",
          executionKind: "agent-runtime",
          connectionSurface: "edge-only",
          authKinds: ["cli-profile"],
          modelDiscovery: "protocol",
          quotaDiscovery: "none",
          officialDocumentation: "https://docs.github.com/",
          runtimeCapabilities: {
            accountIsolation: "single-os-keyring-account",
            maturity: "experimental",
            approvalModes: ["automatic", "deny"],
          },
        },
      ],
    });

    const output = present(state);
    expect(output.detail).toContain("연결 위치           edge-only");
    expect(output.detail).toContain("계정 격리           single-os-keyring-account");
    expect(output.detail).toContain("실행 성숙도         experimental");
    expect(output.detail).toContain("실행 승인 범위      automatic, deny");
  });

  it("정책 탭은 Provider별 승인 범위를 표시하고 공개 연결이 없으면 변경 경로를 숨긴다", () => {
    let state = reduceTuiState(createTuiState(), { type: "snapshot.loaded", snapshot: decodeSnapshot(testSnapshot) });
    state = reduceTuiState(state, { type: "view.selected", view: "subscriptions" });
    state = reduceTuiState(state, { type: "subscription.tab.selected", tab: "policy" });
    state = reduceTuiState(state, {
      type: "query.loaded",
      key: "subscriptionProviders",
      value: [
        {
          providerId: "google-antigravity-cli",
          displayName: "Google Antigravity CLI",
          connectionSurface: "unavailable",
          credentialPolicies: ["adaptive"],
          runtimeCapabilities: {},
        },
      ],
    });
    state = reduceTuiState(state, {
      type: "query.loaded",
      key: "subscriptionPolicy",
      value: [
        {
          providerId: "google-antigravity-cli",
          credentialPolicy: "adaptive",
          approvalMode: "review",
          version: 1,
        },
      ],
    });

    const output = present(state);
    expect(output.detail).toContain("도구 승인 방식      review (현재 연결에서 사용 불가)");
    expect(output.detail).toContain("선택 가능 승인      미지원");
    expect(output.detail).toContain("공개 연결           미지원");
    expect(output.detail).not.toContain("e: 정책 변경");
  });

  it("Codex 서버 계정이 연결되면 서버 전용 review 승인 방식을 정책 선택 범위에 표시한다", () => {
    let state = reduceTuiState(createTuiState(), { type: "snapshot.loaded", snapshot: decodeSnapshot(testSnapshot) });
    state = reduceTuiState(state, { type: "view.selected", view: "subscriptions" });
    state = reduceTuiState(state, { type: "subscription.tab.selected", tab: "policy" });
    state = reduceTuiState(state, {
      type: "query.loaded",
      key: "subscriptionProviders",
      value: [
        {
          providerId: "openai-codex",
          displayName: "OpenAI Codex",
          connectionSurface: "server-and-edge",
          credentialPolicies: ["adaptive"],
          runtimeCapabilities: {
            approvalModes: ["automatic", "deny"],
            approvalModesBySurface: {
              server: ["automatic", "review", "deny"],
              edge: ["automatic", "deny"],
            },
          },
        },
      ],
    });
    state = reduceTuiState(state, {
      type: "query.loaded",
      key: "subscriptionAccounts",
      value: [{ accountId: "codex-server", providerId: "openai-codex", connectorLocation: "server" }],
    });
    state = reduceTuiState(state, {
      type: "query.loaded",
      key: "subscriptionPolicy",
      value: [{ providerId: "openai-codex", credentialPolicy: "adaptive", approvalMode: "review", version: 1 }],
    });

    const output = present(state);
    expect(output.detail).toContain("도구 승인 방식      review");
    expect(output.detail).toContain("선택 가능 승인      automatic, review, deny");
  });
});
