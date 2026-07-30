import { describe, expect, it } from "vitest";

import { parseDesktopLoginArguments } from "./desktop-login.js";

describe("Desktop Codex login entry", () => {
  it("별칭과 계정 의도만 허용하고 Codex Provider는 호출자가 고를 수 없게 한다", () => {
    expect(parseDesktopLoginArguments(["  OpenAI Codex  ", "reuse"])).toEqual({
      alias: "OpenAI Codex",
      newAccount: false,
    });
    expect(parseDesktopLoginArguments(["새 Codex 계정", "new"])).toEqual({
      alias: "새 Codex 계정",
      newAccount: true,
    });

    for (const input of [
      [],
      ["Codex"],
      ["Codex", "reuse", "extra"],
      ["", "reuse"],
      ["bad\nalias", "reuse"],
      ["x".repeat(129), "reuse"],
      ["Codex", "unknown"],
    ]) {
      expect(() => parseDesktopLoginArguments(input)).toThrow("Desktop Codex login 입력");
    }
  });
});
