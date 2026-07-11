import { describe, expect, it } from "vitest";

import { renderCliOutput } from "./render.js";

describe("mass output", () => {
  it("사람용 의미 우선 표와 설명을 만든다", () => {
    const output = renderCliOutput([{ workId: "work-1", status: "running" }], "human", { tty: false });
    expect(output).toContain("workId");
    expect(output).toContain("running");
  });

  it("json은 한 개, jsonl은 배열 항목별 한 줄만 출력한다", () => {
    expect(renderCliOutput({ ok: true }, "json", { tty: false })).toBe('{"ok":true}\n');
    expect(renderCliOutput([{ n: 1 }, { n: 2 }], "jsonl", { tty: false })).toBe('{"n":1}\n{"n":2}\n');
  });

  it("control·ANSI injection을 제거하고 NO_COLOR를 존중한다", () => {
    const output = renderCliOutput({ status: "\u001b[31mdanger\u0000" }, "human", { tty: true, noColor: true });
    expect(output).toContain("danger");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u0000");
  });
});
