import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const SHA_PIN = /uses:\s+[\w./-]+@[a-f0-9]{40}(?:\s+#.*)?$/mu;

test("release workflow는 tag gate·OIDC attestation·SBOM·max provenance를 고정한다", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const uses = workflow.match(/^\s*uses:.*$/gmu) ?? [];

  assert.ok(uses.length >= 8, "release action 단계가 누락됐습니다");
  for (const line of uses) assert.match(line, SHA_PIN, `action을 commit SHA로 고정해야 합니다: ${line.trim()}`);
  assert.match(workflow, /tags:\s*\["v1\.0\.0"\]/u);
  assert.match(workflow, /id-token:\s*write/u);
  assert.match(workflow, /attestations:\s*write/u);
  assert.match(workflow, /provenance:\s*mode=max/u);
  assert.match(workflow, /sbom:\s*true/u);
  assert.match(workflow, /pnpm verify\b/u);
  assert.match(workflow, /pnpm verify:security\b/u);
  assert.match(workflow, /pnpm verify:hardening\b/u);
  assert.match(workflow, /pnpm verify:release\b/u);
});

test("Compose image는 공개 registry digest로 교체할 수 있고 release bundle이 변수 계약을 기록한다", async () => {
  const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
  const builder = await readFile(new URL("./build-release.mjs", import.meta.url), "utf8");

  assert.match(compose, /MASSION_IMAGE/u);
  assert.match(compose, /MASSION_SURREALDB_IMAGE/u);
  assert.match(compose, /MASSION_CADDY_IMAGE/u);
  assert.match(builder, /MASSION_IMAGE/u);
  assert.match(builder, /MASSION_SURREALDB_IMAGE/u);
  assert.match(builder, /MASSION_CADDY_IMAGE/u);
});
