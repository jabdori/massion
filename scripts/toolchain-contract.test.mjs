import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const PNPM_VERSION = "11.13.0";
const root = new URL("../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

test("pnpm 11 실행 계약은 manifest·workspace·CI·Docker·개발 안내에서 일치한다", async () => {
  const [manifestText, workspace, dockerfile, caddyDockerfile, ci, release, readme] = await Promise.all([
    read("package.json"),
    read("pnpm-workspace.yaml"),
    read("Dockerfile"),
    read("deploy/caddy/Dockerfile"),
    read(".github/workflows/ci.yml"),
    read(".github/workflows/release.yml"),
    read("README.md"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.packageManager, `pnpm@${PNPM_VERSION}`);
  assert.equal(manifest.pnpm, undefined, "pnpm 11에서는 root pnpm 설정을 pnpm-workspace.yaml에 둬야 합니다");
  assert.match(workspace, /^overrides:\n {2}"@opentelemetry\/core": 2\.8\.0\n {2}uuid: 11\.1\.1$/mu);
  assert.match(workspace, /^allowBuilds: \{ protobufjs: false \}$/mu);
  assert.doesNotMatch(workspace, /onlyBuiltDependencies/u);

  for (const source of [dockerfile, caddyDockerfile]) {
    assert.match(source, new RegExp(`pnpm@${PNPM_VERSION}`, "u"));
    assert.doesNotMatch(source, /pnpm@10\.30\.3/u);
  }
  for (const workflow of [ci, release]) {
    assert.match(workflow, new RegExp(`corepack prepare pnpm@${PNPM_VERSION} --activate`, "u"));
    assert.doesNotMatch(workflow, /pnpm@10\.30\.3/u);
  }
  assert.match(readme, new RegExp(`pnpm ${PNPM_VERSION}`, "u"));
  assert.match(readme, new RegExp(`corepack prepare pnpm@${PNPM_VERSION} --activate`, "u"));
});
