import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { join } from "node:path";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

test("깨끗한 clone 검증은 lint 전에 workspace build를 실행한다", async () => {
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  const workflow = packageJson.scripts.verify;

  assert.equal(typeof workflow, "string");
  assert.ok(workflow.indexOf("pnpm build") < workflow.indexOf("pnpm lint"));
});

test("새 repository는 재생성 가능한 로컬 산출물을 추적하지 않는다", async () => {
  const ignore = await readFile(join(repositoryRoot, ".gitignore"), "utf8");

  for (const entry of ["node_modules/", "dist/", "coverage/", ".worktrees/"])
    assert.ok(ignore.split(/\r?\n/u).includes(entry));
});
