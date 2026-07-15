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

test("tmux와 자식 프로세스를 쓰는 script 검증은 test 파일을 순차 실행한다", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.match(
    packageJson.scripts.test,
    /^node --test --test-concurrency=1 scripts\/\*\.test\.mjs && /,
    "script 검증이 동시에 실행되면 tmux 기반 UAT의 시간 제한이 불안정해질 수 있습니다",
  );
});

test("CLI의 실제 자식 프로세스 E2E는 worker 하나에서 실행한다", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../apps/cli/package.json", import.meta.url), "utf8"));

  assert.match(
    packageJson.scripts.test,
    /vitest run src --maxWorkers=1$/,
    "CLI child E2E는 다른 test file과 동시에 실행하면 시간 제한이 불안정해질 수 있습니다",
  );
});

test("Software Engineering의 Git·자식 프로세스 검증은 worker 하나에서 실행한다", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../packages/software-engineering/package.json", import.meta.url), "utf8"),
  );

  assert.match(
    packageJson.scripts.test,
    /vitest run src --maxWorkers=1$/,
    "Software Engineering의 Git·자식 프로세스 검증은 다른 test file과 동시에 실행하면 격리 상태가 불안정해질 수 있습니다",
  );
});

test("CLI 형식 검사는 Application 선언 파일을 먼저 빌드한다", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../apps/cli/package.json", import.meta.url), "utf8"));

  assert.match(packageJson.scripts.typecheck, /^pnpm build-deps && /);
});
