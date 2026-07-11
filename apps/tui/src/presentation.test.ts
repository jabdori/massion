import { describe, expect, it } from "vitest";

import { present, safeTerminalText } from "./presentation.js";
import { createTuiState, reduceTuiState } from "./state.js";
import { testSnapshot } from "./state.test.js";
import { decodeSnapshot } from "./wire.js";

describe("TUI presentation", () => {
  it("ANSI·control sequence를 화면 문자열에서 제거한다", () => {
    expect(safeTerminalText("정상\u001b[31m위험\u0007")).toBe("정상�[31m위험�");
  });

  it("여섯 view가 같은 snapshot에서 사람 의미를 먼저 표시한다", () => {
    let state = reduceTuiState(createTuiState(), { type: "snapshot.loaded", snapshot: decodeSnapshot(testSnapshot) });
    for (const view of ["overview", "agents", "works", "chat", "approvals", "operations"] as const) {
      state = reduceTuiState(state, { type: "view.selected", view });
      const output = present(state);
      expect(output.navigation).toContain(
        `[${String(["overview", "agents", "works", "chat", "approvals", "operations"].indexOf(view) + 1)}`,
      );
      expect(output.list.length + output.detail.length).toBeGreaterThan(20);
    }
  });

  it("승인함이 비어 있어도 자동 정책의 정상 상태임을 설명한다", () => {
    const empty = decodeSnapshot({ ...testSnapshot, pendingApprovals: [] });
    let state = reduceTuiState(createTuiState(), { type: "snapshot.loaded", snapshot: empty });
    state = reduceTuiState(state, { type: "view.selected", view: "approvals" });
    expect(present(state).list).toContain("자동 반영 정책");
  });
});
