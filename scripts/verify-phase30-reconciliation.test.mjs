import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  listSafetyDiffPaths,
  loadReconciliationManifest,
  validateManifestCoverage,
  validatePhase30Reconciliation,
} from "./verify-phase30-reconciliation.mjs";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));

test("안전 스냅샷의 337개 변경 경로를 원장이 정확히 한 번씩 배정한다", async () => {
  const errors = await validatePhase30Reconciliation(ROOT);
  assert.deepEqual(errors, []);

  const manifest = await loadReconciliationManifest(ROOT);
  const assigned = manifest.slices.flatMap((slice) => slice.primaryPaths);
  assert.equal(new Set(assigned).size, 337);
  assert.equal(assigned.length, 337);
});

test("임시 원장에서 중복 배정과 누락을 거부한다", async () => {
  const source = await loadReconciliationManifest(ROOT);
  const manifest = JSON.parse(JSON.stringify(source));
  const first = manifest.slices.find((slice) => slice.id === "1");
  const second = manifest.slices.find((slice) => slice.id === "2");
  assert.ok(first);
  assert.ok(second);

  const duplicated = first.primaryPaths[0];
  assert.equal(typeof duplicated, "string");
  second.primaryPaths.push(duplicated);
  first.primaryPaths.splice(1, 1);

  const directory = await mkdtemp(join(tmpdir(), "massion-phase30-manifest-"));
  const manifestPath = join(directory, "reconciliation-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);

  const paths = await listSafetyDiffPaths(ROOT, source.baseCommit, source.safetyCommit);
  const errors = validateManifestCoverage(await loadReconciliationManifest(ROOT, manifestPath), paths);
  assert.ok(errors.some((error) => error.includes("중복 primary path")));
  assert.ok(errors.some((error) => error.includes("누락 primary path")));
});
