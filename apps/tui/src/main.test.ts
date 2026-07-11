import { describe, expect, it } from "vitest";

import { parseTuiArguments, runTui } from "./main.js";

describe("TUI executable", () => {
  it("profile과 config만 인자로 받고 token 인자를 제공하지 않는다", () => {
    expect(parseTuiArguments(["--profile", "team", "--config", "/tmp/config.json"])).toEqual({
      profile: "team",
      configPath: "/tmp/config.json",
      help: false,
    });
    expect(() => parseTuiArguments(["--token", "secret"])).toThrow(/알 수 없는/u);
  });

  it("help는 profile이나 renderer 없이 출력한다", async () => {
    let output = "";
    await expect(runTui(["--help"], { write: (value) => (output += value) })).resolves.toBe(0);
    expect(output).toContain("massion-tui");
    expect(output).toContain("mass init");
  });
});
