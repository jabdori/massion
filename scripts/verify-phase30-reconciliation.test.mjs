import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SAFETY_COMMIT,
  loadReconciliationManifest,
  parseReconciliationArguments,
  reconciliationManifestPath,
  validateManifestCoverage,
  validatePhase30Reconciliation,
} from "./verify-phase30-reconciliation.mjs";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const safetySnapshotAvailable =
  spawnSync("git", ["-C", ROOT, "cat-file", "-e", `${SAFETY_COMMIT}^{commit}`], { stdio: "ignore" }).status === 0;
const strictSafetySkip = safetySnapshotAvailable
  ? false
  : "로컬 안전 스냅샷 참조가 없는 clean clone에서는 strict 검증을 실행하지 않습니다";

test("일반 clean clone은 로컬 안전 참조 없이 원장 테스트를 통과한다", async (context) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "massion-phase30-public-clean-clone-"));
  context.after(async () => await rm(fixtureRoot, { recursive: true, force: true }));

  const cloneRoot = join(fixtureRoot, "repository");
  const clone = spawnSync("git", ["clone", "--quiet", "--no-local", ROOT, cloneRoot], { encoding: "utf8" });
  assert.equal(clone.status, 0, `stdout:\n${clone.stdout}\nstderr:\n${clone.stderr}`);

  const testPath = join("scripts", "verify-phase30-reconciliation.test.mjs");
  const slice1aPlanPath = join(
    "docs",
    "phases",
    "30-surface-parity-agent-ux",
    "slice-1a-remote-surrealdb-implementation-plan.md",
  );
  await writeFile(join(cloneRoot, testPath), await readFile(join(ROOT, testPath), "utf8"));
  await writeFile(join(cloneRoot, slice1aPlanPath), await readFile(join(ROOT, slice1aPlanPath), "utf8"));
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-skip-pattern=^일반 clean clone은 로컬 안전 참조 없이 원장 테스트를 통과한다$", testPath],
    { cwd: cloneRoot, encoding: "utf8", env: environment },
  );

  assert.doesNotMatch(result.stderr, /run\(\) is being called recursively/u);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
});

test("안전 스냅샷의 337개 변경 경로를 원장이 정확히 한 번씩 배정한다", { skip: strictSafetySkip }, async () => {
  const errors = await validatePhase30Reconciliation(ROOT, { requireSafety: true });
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

  const errors = validateManifestCoverage(await loadReconciliationManifest(ROOT, manifestPath));
  assert.ok(errors.some((error) => error.includes("중복 primary path")));
  assert.ok(errors.some((error) => error.includes("누락 primary path")));
});

test("정적 원장 검증은 안전 diff status·path 목록의 SHA-256 변조를 거부한다", async () => {
  const manifest = JSON.parse(JSON.stringify(await loadReconciliationManifest(ROOT)));
  manifest.safetyDiff.entries[0] = manifest.safetyDiff.entries[0].replace(/^M\t/u, "A\t");

  const errors = validateManifestCoverage(manifest);
  assert.ok(errors.some((error) => error.includes("SHA-256 digest")));
});

test("정적 원장 검증은 목록과 원장 SHA를 함께 바꾼 변조도 거부한다", async () => {
  const manifest = JSON.parse(JSON.stringify(await loadReconciliationManifest(ROOT)));
  manifest.safetyDiff.entries[0] = manifest.safetyDiff.entries[0].replace(/^M\t/u, "A\t");
  manifest.safetyDiff.sha256 = createHash("sha256")
    .update(`${manifest.safetyDiff.entries.join("\n")}\n`, "utf8")
    .digest("hex");

  const errors = validateManifestCoverage(manifest);
  assert.ok(errors.some((error) => error.includes("기준 SHA-256")));
});

test("안전 커밋이 없는 임시 clean-clone 성격 경로에서도 정적 원장 검증을 통과한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "massion-phase30-clean-clone-"));
  const phase = join(root, "docs", "phases", "30-surface-parity-agent-ux");
  await mkdir(phase, { recursive: true });
  await writeFile(
    join(phase, "reconciliation-manifest.json"),
    await readFile(reconciliationManifestPath(ROOT), "utf8"),
  );

  assert.deepEqual(await validatePhase30Reconciliation(root), []);
});

test("심볼릭 링크 절대 경로의 strict 실행은 누락된 안전 커밋을 보고한다", async (context) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "massion-phase30-symlink-entrypoint-"));
  context.after(async () => await rm(fixtureRoot, { recursive: true, force: true }));

  const cleanCloneRoot = join(fixtureRoot, "clean-clone");
  const symlinkedCloneRoot = join(fixtureRoot, "symlinked-clean-clone");
  const sourceScript = join(ROOT, "scripts", "verify-phase30-reconciliation.mjs");
  const targetScript = join(cleanCloneRoot, "scripts", "verify-phase30-reconciliation.mjs");
  const manifest = join(cleanCloneRoot, "docs", "phases", "30-surface-parity-agent-ux", "reconciliation-manifest.json");
  await mkdir(dirname(targetScript), { recursive: true });
  await mkdir(dirname(manifest), { recursive: true });
  await writeFile(targetScript, await readFile(sourceScript, "utf8"));
  await writeFile(manifest, await readFile(reconciliationManifestPath(ROOT), "utf8"));
  await symlink(cleanCloneRoot, symlinkedCloneRoot, "dir");

  const result = spawnSync(
    process.execPath,
    [join(symlinkedCloneRoot, "scripts", "verify-phase30-reconciliation.mjs"), "--require-safety"],
    { encoding: "utf8" },
  );

  assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /필수 커밋이 존재하지 않습니다: 9b049f72a96457c46139811f86d36589f073df64/u);
});

test("문자열만 있는 모호한 hunk anchor를 정적 검증에서 거부한다", async () => {
  const manifest = JSON.parse(JSON.stringify(await loadReconciliationManifest(ROOT)));
  const owner = manifest.sharedHunkAnchors[0].owners[0];
  owner.meaning = undefined;
  owner.startLine = undefined;
  owner.endLine = undefined;
  owner.before = undefined;
  owner.match = undefined;
  owner.after = undefined;

  const errors = validateManifestCoverage(manifest);
  assert.ok(errors.some((error) => error.includes("정확한 위치 hunk anchor")));
});

test("공용 hunk의 전체 경로와 owner 집합 누락을 정적 검증에서 거부한다", async () => {
  const manifest = JSON.parse(JSON.stringify(await loadReconciliationManifest(ROOT)));
  manifest.sharedHunkAnchors = [];

  const errors = validateManifestCoverage(manifest);
  assert.ok(errors.some((error) => error.includes("공용 hunk anchor 경로 수")));
  assert.ok(errors.some((error) => error.includes("필수 공용 hunk anchor 경로가 없습니다")));
});

test("공용 hunk의 필수 owner가 하나라도 빠지면 정적 검증에서 거부한다", async () => {
  const manifest = JSON.parse(JSON.stringify(await loadReconciliationManifest(ROOT)));
  manifest.sharedHunkAnchors[0].owners.pop();

  const errors = validateManifestCoverage(manifest);
  assert.ok(errors.some((error) => error.includes("필수 공용 hunk owner 집합이 일치하지 않습니다")));
});

test("공용 hunk primarySlice는 primary path의 실제 소유 slice와 일치해야 한다", async () => {
  const manifest = JSON.parse(JSON.stringify(await loadReconciliationManifest(ROOT)));
  manifest.sharedHunkAnchors[0].primarySlice = "4";

  const errors = validateManifestCoverage(manifest);
  assert.ok(errors.some((error) => error.includes("primary path 소유 slice와 일치하지 않습니다")));
});

test("안전 커밋 strict 검증은 잘못된 hunk 전후 문맥을 거부한다", { skip: strictSafetySkip }, async () => {
  const source = await loadReconciliationManifest(ROOT);
  const manifest = JSON.parse(JSON.stringify(source));
  manifest.sharedHunkAnchors[0].owners[0].before = "잘못된 이전 문맥";
  const directory = await mkdtemp(join(tmpdir(), "massion-phase30-anchor-"));
  const manifestPath = join(directory, "reconciliation-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);

  const errors = await validatePhase30Reconciliation(ROOT, { requireSafety: true, manifestPath });
  assert.ok(errors.some((error) => error.includes("이전 문맥")));
});

test("안전 커밋 strict 검증은 추가 hunk 밖의 정확해 보이는 위치도 거부한다", { skip: strictSafetySkip }, async () => {
  const source = await loadReconciliationManifest(ROOT);
  const manifest = JSON.parse(JSON.stringify(source));
  const owner = manifest.sharedHunkAnchors[0].owners[0];
  owner.startLine = 1;
  owner.endLine = 1;
  owner.before = "";
  owner.match = 'import { randomUUID } from "node:crypto";';
  owner.after = "";
  const directory = await mkdtemp(join(tmpdir(), "massion-phase30-anchor-range-"));
  const manifestPath = join(directory, "reconciliation-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);

  const errors = await validatePhase30Reconciliation(ROOT, { requireSafety: true, manifestPath });
  assert.ok(errors.some((error) => error.includes("변경 범위")));
});

test(
  "안전 커밋 strict 검증은 반복되는 전후 문맥의 모호한 hunk owner를 거부한다",
  { skip: strictSafetySkip },
  async () => {
    const source = await loadReconciliationManifest(ROOT);
    const manifest = JSON.parse(JSON.stringify(source));
    const owner = manifest.sharedHunkAnchors[0].owners[0];
    owner.startLine = 205;
    owner.endLine = 205;
    owner.before = "        { cause: error },";
    owner.match = "      );";
    owner.after = "    }";
    const directory = await mkdtemp(join(tmpdir(), "massion-phase30-anchor-ambiguous-"));
    const manifestPath = join(directory, "reconciliation-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);

    const errors = await validatePhase30Reconciliation(ROOT, { requireSafety: true, manifestPath });
    assert.ok(errors.some((error) => error.includes("유일하지 않습니다")));
  },
);

test("Phase 30 구현 계획은 독립 복구 근거가 없는 완료 체크박스를 사용하지 않는다", async () => {
  const plan = await readFile(
    join(ROOT, "docs", "phases", "30-surface-parity-agent-ux", "implementation-plan.md"),
    "utf8",
  );
  assert.doesNotMatch(plan, /^\s*[-*+]\s+\[[xX]\]\s/m);
});

test("Slice 1A 깨끗한 복제본의 릴리스 복구 검증은 pnpm CI 모드로 실행한다", async () => {
  const plan = await readFile(
    join(ROOT, "docs", "phases", "30-surface-parity-agent-ux", "slice-1a-remote-surrealdb-implementation-plan.md"),
    "utf8",
  );

  assert.match(plan, /^env -u SURREAL_TEST_URL CI=true pnpm verify:release artifacts\/release-1\.0\.0$/mu);
});

test("엄격한 안전 스냅샷 비교는 명시적 --require-safety 인자로만 켠다", () => {
  assert.deepEqual(parseReconciliationArguments([]), { requireSafety: false });
  assert.deepEqual(parseReconciliationArguments(["--require-safety"]), { requireSafety: true });
  assert.throws(() => parseReconciliationArguments(["--unknown"]), /지원하지 않는 원장 검증 인자/u);
});
