import { describe, expect, it } from "vitest";

import { buildDashboard, layoutForTerminal } from "./view-model.js";
import { decodeSnapshot } from "./wire.js";
import { testSnapshot } from "./state.test.js";

describe("TUI view model", () => {
  it("Agent 실행과 비용·승인 상태를 사람이 읽는 dashboard로 집계한다", () => {
    const dashboard = buildDashboard(decodeSnapshot(testSnapshot));
    expect(dashboard).toMatchObject({ runningAgents: 1, pendingApprovals: 1, inputTokens: 10, outputTokens: 5 });
    expect(dashboard.costText).toBe("$0.000025");
  });

  it("폭에 따라 3열·단일 pane을 선택하고 최소 크기를 명시한다", () => {
    expect(layoutForTerminal(140, 40).mode).toBe("wide");
    expect(layoutForTerminal(90, 30).mode).toBe("compact");
    expect(layoutForTerminal(79, 24)).toMatchObject({ mode: "unsupported", requiredWidth: 80, requiredHeight: 24 });
  });
});
