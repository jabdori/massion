import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

export const BASE_COMMIT = "65922bd706580a0962b6eda81c6fa3d63b36b6a8";
export const SAFETY_COMMIT = "9b049f72a96457c46139811f86d36589f073df64";
export const EXPECTED_DIFF_PATH_COUNT = 337;
export const SLICE_IDS = ["1", "2", "3", "4", "5", "6", "7", "8A", "8B", "9", "10", "11", "12", "13", "14", "15"];

const ALLOWED_STATUSES = new Set(["candidate", "partial", "not-implemented", "superseded"]);
const LOCKFILE_PATH = "pnpm-lock.yaml";
const LOCKFILE_OWNERS = ["2", "3", "5", "11", "12"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function manifestPath(root) {
  return join(root, "docs", "phases", "30-surface-parity-agent-ux", "reconciliation-manifest.json");
}

export function reconciliationManifestPath(root) {
  return manifestPath(root);
}

export async function loadReconciliationManifest(root, overridePath = manifestPath(root)) {
  const content = await readFile(overridePath, "utf8");
  return JSON.parse(content);
}

async function gitText(root, args) {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

async function commitExists(root, commit) {
  try {
    await gitText(root, ["cat-file", "-e", `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export async function listSafetyDiffPaths(root, baseCommit = BASE_COMMIT, safetyCommit = SAFETY_COMMIT) {
  const output = await gitText(root, ["diff", "--name-status", baseCommit, safetyCommit]);
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t").at(-1))
    .filter((path) => typeof path === "string" && path.length > 0);
}

function slicesFrom(manifest, errors) {
  if (!isRecord(manifest) || !Array.isArray(manifest.slices)) {
    errors.push("원장 slices 배열이 없습니다");
    return [];
  }
  return manifest.slices;
}

function validPrimaryPaths(slice, errors) {
  if (!isRecord(slice)) {
    errors.push("원장 slice 항목이 객체가 아닙니다");
    return [];
  }
  if (
    !Array.isArray(slice.primaryPaths) ||
    !slice.primaryPaths.every((path) => typeof path === "string" && path.length > 0)
  ) {
    errors.push(`${String(slice.id)}: primaryPaths가 유효하지 않습니다`);
    return [];
  }
  return slice.primaryPaths;
}

function validateSliceMetadata(manifest, slices, errors) {
  if (!isRecord(manifest)) {
    errors.push("원장 JSON 최상위가 객체가 아닙니다");
    return;
  }
  if (manifest.schema !== "massion.phase30.reconciliation.v1") errors.push("원장 schema가 유효하지 않습니다");
  if (manifest.baseCommit !== BASE_COMMIT) errors.push("원장 baseCommit이 기준 커밋과 일치하지 않습니다");
  if (manifest.safetyCommit !== SAFETY_COMMIT) errors.push("원장 safetyCommit이 안전 커밋과 일치하지 않습니다");
  if (manifest.expectedDiffPathCount !== EXPECTED_DIFF_PATH_COUNT) {
    errors.push(`원장 expectedDiffPathCount가 ${String(EXPECTED_DIFF_PATH_COUNT)}이 아닙니다`);
  }

  const ids = slices.map((slice) => (isRecord(slice) ? slice.id : undefined));
  if (ids.length !== SLICE_IDS.length || ids.some((id, index) => id !== SLICE_IDS[index])) {
    errors.push(`허용되지 않은 slice 순서 또는 ID: ${ids.map(String).join(", ")}`);
  }
  for (const slice of slices) {
    if (!isRecord(slice)) continue;
    if (typeof slice.purpose !== "string" || slice.purpose.length === 0)
      errors.push(`${String(slice.id)}: 목적이 없습니다`);
    if (!ALLOWED_STATUSES.has(slice.status))
      errors.push(`${String(slice.id)}: 허용되지 않은 상태 ${String(slice.status)}`);
    if (
      !Array.isArray(slice.verification) ||
      !slice.verification.every((command) => typeof command === "string" && command.length > 0)
    ) {
      errors.push(`${String(slice.id)}: 검증 명령이 유효하지 않습니다`);
    }
  }
}

function validateLockfilePolicy(manifest, slices, errors) {
  if (!isRecord(manifest) || !isRecord(manifest.lockfilePolicy)) {
    errors.push("pnpm-lock.yaml 재생성 정책이 없습니다");
    return;
  }
  const policy = manifest.lockfilePolicy;
  if (policy.path !== LOCKFILE_PATH) errors.push("lockfile 정책 경로가 pnpm-lock.yaml이 아닙니다");
  if (policy.primarySlice !== "2") errors.push("pnpm-lock.yaml primary slice는 2여야 합니다");
  if (policy.regenerateCommand !== "pnpm install --lockfile-only") {
    errors.push("pnpm-lock.yaml 재생성 명령이 정확하지 않습니다");
  }
  if (policy.safetyCommitWholeFileCopy !== "forbidden") {
    errors.push("안전 커밋의 pnpm-lock.yaml 전체 복사 금지가 명시되지 않았습니다");
  }
  if (!Array.isArray(policy.owners) || policy.owners.join(",") !== LOCKFILE_OWNERS.join(",")) {
    errors.push("pnpm-lock.yaml 소유 slice가 2, 3, 5, 11, 12와 일치하지 않습니다");
  }

  const primaryOwners = [];
  for (const slice of slices) {
    if (!isRecord(slice)) continue;
    if (validPrimaryPaths(slice, errors).includes(LOCKFILE_PATH)) primaryOwners.push(slice.id);
  }
  if (primaryOwners.length !== 1 || primaryOwners[0] !== "2") {
    errors.push("pnpm-lock.yaml은 slice 2에만 primary path로 배정해야 합니다");
  }
}

function validateAnchorShape(manifest, errors) {
  if (!isRecord(manifest) || !Array.isArray(manifest.sharedHunkAnchors)) {
    errors.push("공용 hunk anchor 목록이 없습니다");
    return [];
  }
  const anchors = manifest.sharedHunkAnchors;
  const seenPaths = new Set();
  for (const entry of anchors) {
    if (!isRecord(entry)) {
      errors.push("공용 hunk anchor 항목이 객체가 아닙니다");
      continue;
    }
    if (typeof entry.path !== "string" || entry.path.length === 0) {
      errors.push("공용 hunk anchor 경로가 유효하지 않습니다");
      continue;
    }
    if (seenPaths.has(entry.path)) errors.push(`공용 hunk anchor 경로가 중복되었습니다: ${entry.path}`);
    seenPaths.add(entry.path);
    if (!SLICE_IDS.includes(entry.primarySlice)) errors.push(`${entry.path}: primarySlice가 유효하지 않습니다`);
    if (!Array.isArray(entry.owners) || entry.owners.length === 0) {
      errors.push(`${entry.path}: hunk owner가 없습니다`);
      continue;
    }
    const ownerIds = new Set();
    for (const owner of entry.owners) {
      if (!isRecord(owner) || !SLICE_IDS.includes(owner.slice)) {
        errors.push(`${entry.path}: 허용되지 않은 hunk owner`);
        continue;
      }
      if (ownerIds.has(owner.slice)) errors.push(`${entry.path}: hunk owner가 중복되었습니다: ${owner.slice}`);
      ownerIds.add(owner.slice);
      if (
        !Array.isArray(owner.anchors) ||
        owner.anchors.length === 0 ||
        !owner.anchors.every((anchor) => typeof anchor === "string" && anchor.length > 0)
      ) {
        errors.push(`${entry.path}: ${owner.slice}의 hunk anchor가 유효하지 않습니다`);
      }
    }
    if (!ownerIds.has(entry.primarySlice)) errors.push(`${entry.path}: primarySlice가 hunk owner에 없습니다`);
  }
  return anchors;
}

export function validateManifestCoverage(manifest, safetyPaths) {
  const errors = [];
  const slices = slicesFrom(manifest, errors);
  validateSliceMetadata(manifest, slices, errors);

  if (!Array.isArray(safetyPaths)) {
    errors.push("안전 스냅샷 변경 경로 목록이 유효하지 않습니다");
    return errors.sort();
  }
  const expected = new Set(safetyPaths);
  if (safetyPaths.length !== EXPECTED_DIFF_PATH_COUNT || expected.size !== EXPECTED_DIFF_PATH_COUNT) {
    errors.push(`안전 스냅샷 변경 경로는 고유 ${String(EXPECTED_DIFF_PATH_COUNT)}개여야 합니다`);
  }

  const owners = new Map();
  for (const slice of slices) {
    const primaryPaths = validPrimaryPaths(slice, errors);
    for (const path of primaryPaths) {
      const current = owners.get(path) ?? [];
      current.push(isRecord(slice) ? slice.id : undefined);
      owners.set(path, current);
    }
  }
  for (const [path, ownerIds] of owners) {
    if (ownerIds.length > 1) errors.push(`중복 primary path: ${path} (${ownerIds.map(String).join(", ")})`);
    if (!expected.has(path)) errors.push(`초과 primary path: ${path}`);
  }
  for (const path of expected) {
    if (!owners.has(path)) errors.push(`누락 primary path: ${path}`);
  }

  const finalSlice = slices.find((slice) => isRecord(slice) && slice.id === "15");
  if (!isRecord(finalSlice) || validPrimaryPaths(finalSlice, errors).length !== 0) {
    errors.push("slice 15의 primary path는 0개여야 합니다");
  }
  validateLockfilePolicy(manifest, slices, errors);
  validateAnchorShape(manifest, errors);
  return [...new Set(errors)].sort();
}

async function validateAnchorContents(root, manifest, safetyPaths) {
  const errors = [];
  const anchors = validateAnchorShape(manifest, errors);
  const expected = new Set(safetyPaths);
  const safetyCommit =
    isRecord(manifest) && typeof manifest.safetyCommit === "string" ? manifest.safetyCommit : SAFETY_COMMIT;
  for (const entry of anchors) {
    if (!isRecord(entry) || typeof entry.path !== "string" || !expected.has(entry.path)) {
      if (isRecord(entry) && typeof entry.path === "string")
        errors.push(`${entry.path}: safety diff에 없는 공용 hunk anchor`);
      continue;
    }
    let content;
    try {
      content = await gitText(root, ["show", `${safetyCommit}:${entry.path}`]);
    } catch {
      errors.push(`${entry.path}: 안전 커밋에서 hunk anchor 파일을 읽을 수 없습니다`);
      continue;
    }
    for (const owner of entry.owners ?? []) {
      if (!isRecord(owner) || !Array.isArray(owner.anchors)) continue;
      for (const anchor of owner.anchors) {
        if (typeof anchor === "string" && !content.includes(anchor)) {
          errors.push(`${entry.path}: ${String(owner.slice)} hunk anchor가 안전 커밋에 없습니다: ${anchor}`);
        }
      }
    }
  }
  return [...new Set(errors)].sort();
}

export async function validatePhase30Reconciliation(root) {
  const errors = [];
  let manifest;
  try {
    manifest = await loadReconciliationManifest(root);
  } catch (error) {
    errors.push(`원장을 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}`);
    return errors;
  }

  for (const commit of [BASE_COMMIT, SAFETY_COMMIT]) {
    if (!(await commitExists(root, commit))) errors.push(`필수 커밋이 존재하지 않습니다: ${commit}`);
  }
  if (errors.length > 0) return errors;

  let safetyPaths;
  try {
    safetyPaths = await listSafetyDiffPaths(root, BASE_COMMIT, SAFETY_COMMIT);
  } catch (error) {
    errors.push(`안전 스냅샷 diff를 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}`);
    return errors;
  }
  errors.push(...validateManifestCoverage(manifest, safetyPaths));
  errors.push(...(await validateAnchorContents(root, manifest, safetyPaths)));
  return [...new Set(errors)].sort();
}

async function main() {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const root = resolve(scriptDirectory, "..");
  const errors = await validatePhase30Reconciliation(root);
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`ERROR ${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Phase 30 정합성 원장 검증 통과 (${String(EXPECTED_DIFF_PATH_COUNT)} paths)\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
