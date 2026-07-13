import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("현재 아키텍처 정본의 Mermaid 다이어그램 11개를 구조 검증한다", () => {
  const result = spawnSync(process.execPath, ["scripts/verify-architecture-diagrams.mjs", "--structure-only"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /아키텍처 다이어그램 11개 검증 통과/u);
});
