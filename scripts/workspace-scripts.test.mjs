import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

test("공유 빌드 산출물을 사용하는 workspace 검증을 순차 실행한다", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  for (const script of ["typecheck", "test", "build"]) {
    assert.match(
      packageJson.scripts[script],
      /--workspace-concurrency=1/,
      `${script}가 공유 dist 산출물 경쟁을 만들 수 있습니다`,
    );
  }
});

test("CLI 형식 검사는 Application 선언 파일을 먼저 빌드한다", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../apps/cli/package.json", import.meta.url), "utf8"));

  assert.match(packageJson.scripts.typecheck, /^pnpm build-deps && /);
});
