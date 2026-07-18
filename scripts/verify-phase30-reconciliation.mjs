import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
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
const SAFETY_DIFF_FORMAT = "git-name-status-v1";
const SAFETY_DIFF_SHA256 = "5c1ba8c1fe67e232caa36e1594a7469841281e726954d5d6d4bfb2fc66ab1351";
const REQUIRED_SHARED_HUNKS = new Map([
  ["apps/cli/src/commands.ts", { primarySlice: "3", owners: ["3", "4", "7", "8A", "10"] }],
  ["apps/cli/src/parser.ts", { primarySlice: "3", owners: ["3", "4", "7", "8A", "10"] }],
  ["apps/cli/src/execution.ts", { primarySlice: "3", owners: ["3", "10"] }],
  ["apps/server/src/product.ts", { primarySlice: "7", owners: ["4", "5", "6", "7"] }],
  ["packages/foundation/src/index.ts", { primarySlice: "2", owners: ["2", "13"] }],
  ["packages/foundation/package.json", { primarySlice: "2", owners: ["2"] }],
  ["packages/application/src/adapters/domain.ts", { primarySlice: "7", owners: ["4", "7", "8A", "9"] }],
  ["packages/application/src/adapters/read-model.ts", { primarySlice: "7", owners: ["7", "8A"] }],
  ["packages/application/src/query-registry.ts", { primarySlice: "7", owners: ["4", "5", "6", "7", "8A", "8B", "9"] }],
  ["packages/application/src/read-model.ts", { primarySlice: "7", owners: ["7", "8A"] }],
  ["packages/application/src/product.ts", { primarySlice: "6", owners: ["5", "6"] }],
  ["packages/application/src/event-projector.ts", { primarySlice: "7", owners: ["7", "8B"] }],
  ["packages/application/src/snapshot.ts", { primarySlice: "7", owners: ["7", "8A"] }],
  ["packages/application/src/remote.contract.test.ts", { primarySlice: "7", owners: ["7", "8A"] }],
  ["packages/runtime/src/execution-store.ts", { primarySlice: "6", owners: ["6", "7"] }],
  ["packages/runtime/src/schema.ts", { primarySlice: "6", owners: ["6", "7"] }],
  ["packages/runtime/src/voltagent-runner.ts", { primarySlice: "6", owners: ["6", "9"] }],
  ["packages/runtime/src/embedded-agent-runtime.ts", { primarySlice: "7", owners: ["6", "7"] }],
  ["packages/runtime/src/index.ts", { primarySlice: "6", owners: ["6", "7"] }],
  ["packages/work/src/work.ts", { primarySlice: "7", owners: ["7", "8A"] }],
  ["pnpm-lock.yaml", { primarySlice: "2", owners: ["2", "3", "5", "11", "12"] }],
  ["docs/phases/30-surface-parity-agent-ux/design.md", { primarySlice: "14", owners: ["14"] }],
  ["docs/phases/30-surface-parity-agent-ux/implementation-plan.md", { primarySlice: "14", owners: ["14"] }],
  ["docs/phases/30-surface-parity-agent-ux/review.md", { primarySlice: "14", owners: ["14"] }],
]);
const REQUIRED_SHARED_HUNK_PATH_COUNT = REQUIRED_SHARED_HUNKS.size;
const REQUIRED_SHARED_HUNK_OWNER_COUNT = [...REQUIRED_SHARED_HUNKS.values()].reduce(
  (count, requirement) => count + requirement.owners.length,
  0,
);

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
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], { maxBuffer: 32 * 1024 * 1024 });
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

function canonicalSafetyDiff(entries) {
  return `${entries.join("\n")}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseSafetyDiffEntry(entry) {
  if (typeof entry !== "string") return undefined;
  const separator = entry.indexOf("\t");
  if (separator <= 0 || separator === entry.length - 1) return undefined;
  const status = entry.slice(0, separator);
  const path = entry.slice(separator + 1);
  if (!/^(?:[ADM]|[RC][0-9]+)$/u.test(status) || path.includes("\n") || path.length === 0) return undefined;
  return { status, path };
}

export async function listSafetyDiffEntries(root, baseCommit = BASE_COMMIT, safetyCommit = SAFETY_COMMIT) {
  const output = await gitText(root, ["diff", "--name-status", baseCommit, safetyCommit]);
  return output.trimEnd().length === 0 ? [] : output.trimEnd().split("\n");
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

function safetyDiffEntries(manifest, errors) {
  if (!isRecord(manifest) || !isRecord(manifest.safetyDiff)) {
    errors.push("안전 스냅샷 status·path 목록이 없습니다");
    return [];
  }
  const safetyDiff = manifest.safetyDiff;
  if (safetyDiff.format !== SAFETY_DIFF_FORMAT) errors.push("안전 스냅샷 목록 형식이 유효하지 않습니다");
  if (!Array.isArray(safetyDiff.entries)) {
    errors.push("안전 스냅샷 status·path entries가 유효하지 않습니다");
    return [];
  }
  if (safetyDiff.entries.length !== EXPECTED_DIFF_PATH_COUNT) {
    errors.push(`안전 스냅샷 status·path entries는 ${String(EXPECTED_DIFF_PATH_COUNT)}개여야 합니다`);
  }
  const parsed = [];
  const paths = new Set();
  for (const [index, entry] of safetyDiff.entries.entries()) {
    const value = parseSafetyDiffEntry(entry);
    if (!value) {
      errors.push(`안전 스냅샷 ${String(index + 1)}번 entry의 status·path가 유효하지 않습니다`);
      continue;
    }
    if (paths.has(value.path)) errors.push(`안전 스냅샷 path가 중복되었습니다: ${value.path}`);
    paths.add(value.path);
    parsed.push(value);
  }
  if (paths.size !== EXPECTED_DIFF_PATH_COUNT) {
    errors.push(`안전 스냅샷 path는 고유 ${String(EXPECTED_DIFF_PATH_COUNT)}개여야 합니다`);
  }
  const expectedDigest = sha256(canonicalSafetyDiff(safetyDiff.entries));
  if (typeof safetyDiff.sha256 !== "string" || safetyDiff.sha256 !== expectedDigest) {
    errors.push("안전 스냅샷 status·path SHA-256 digest가 일치하지 않습니다");
  }
  if (safetyDiff.sha256 !== SAFETY_DIFF_SHA256 || expectedDigest !== SAFETY_DIFF_SHA256) {
    errors.push("안전 스냅샷 status·path 목록의 기준 SHA-256이 일치하지 않습니다");
  }
  return parsed;
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

function exactAnchor(owner) {
  if (!isRecord(owner)) return undefined;
  const hasExactShape =
    typeof owner.meaning === "string" &&
    owner.meaning.length > 0 &&
    Number.isSafeInteger(owner.startLine) &&
    owner.startLine >= 1 &&
    Number.isSafeInteger(owner.endLine) &&
    owner.endLine >= owner.startLine &&
    typeof owner.before === "string" &&
    typeof owner.match === "string" &&
    owner.match.length > 0 &&
    typeof owner.after === "string";
  if (!hasExactShape || Object.hasOwn(owner, "anchors")) return undefined;
  return owner;
}

function validateAnchorShape(manifest, safetyPaths, errors) {
  if (!isRecord(manifest) || !Array.isArray(manifest.sharedHunkAnchors)) {
    errors.push("공용 hunk anchor 목록이 없습니다");
    return [];
  }
  const anchors = manifest.sharedHunkAnchors;
  const expected = new Set(safetyPaths);
  const seenPaths = new Set();
  const observed = new Map();
  if (anchors.length !== REQUIRED_SHARED_HUNK_PATH_COUNT) {
    errors.push(`공용 hunk anchor 경로 수는 ${String(REQUIRED_SHARED_HUNK_PATH_COUNT)}개여야 합니다`);
  }
  for (const entry of anchors) {
    if (!isRecord(entry)) {
      errors.push("공용 hunk anchor 항목이 객체가 아닙니다");
      continue;
    }
    if (typeof entry.path !== "string" || entry.path.length === 0) {
      errors.push("공용 hunk anchor 경로가 유효하지 않습니다");
      continue;
    }
    if (!expected.has(entry.path)) errors.push(`${entry.path}: safety diff에 없는 공용 hunk anchor`);
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
      if (!exactAnchor(owner))
        errors.push(`${entry.path}: ${owner.slice}의 정확한 위치 hunk anchor가 유효하지 않습니다`);
    }
    if (!ownerIds.has(entry.primarySlice)) errors.push(`${entry.path}: primarySlice가 hunk owner에 없습니다`);
    if (!observed.has(entry.path)) observed.set(entry.path, { primarySlice: entry.primarySlice, ownerIds });
  }
  for (const [path, requirement] of REQUIRED_SHARED_HUNKS) {
    const actual = observed.get(path);
    if (!actual) {
      errors.push(`${path}: 필수 공용 hunk anchor 경로가 없습니다`);
      continue;
    }
    if (actual.primarySlice !== requirement.primarySlice) {
      errors.push(`${path}: 필수 공용 hunk primarySlice가 일치하지 않습니다`);
    }
    if (
      actual.ownerIds.size !== requirement.owners.length ||
      requirement.owners.some((owner) => !actual.ownerIds.has(owner))
    ) {
      errors.push(`${path}: 필수 공용 hunk owner 집합이 일치하지 않습니다`);
    }
  }
  for (const path of observed.keys()) {
    if (!REQUIRED_SHARED_HUNKS.has(path)) errors.push(`${path}: 허용되지 않은 공용 hunk anchor 경로`);
  }
  const ownerCount = [...observed.values()].reduce((count, entry) => count + entry.ownerIds.size, 0);
  if (ownerCount !== REQUIRED_SHARED_HUNK_OWNER_COUNT) {
    errors.push(`공용 hunk owner 수는 ${String(REQUIRED_SHARED_HUNK_OWNER_COUNT)}개여야 합니다`);
  }
  return anchors;
}

export function validateManifestCoverage(manifest) {
  const errors = [];
  const slices = slicesFrom(manifest, errors);
  validateSliceMetadata(manifest, slices, errors);
  const safetyEntries = safetyDiffEntries(manifest, errors);
  const expected = new Set(safetyEntries.map((entry) => entry.path));

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
  const anchors = validateAnchorShape(manifest, expected, errors);
  for (const entry of anchors) {
    if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.primarySlice !== "string") continue;
    const primaryOwners = owners.get(entry.path);
    if (primaryOwners?.length === 1 && primaryOwners[0] !== entry.primarySlice) {
      errors.push(`${entry.path}: hunk primarySlice가 primary path 소유 slice와 일치하지 않습니다`);
    }
  }
  return [...new Set(errors)].sort();
}

function parseAddedHunkRanges(diff) {
  const ranges = [];
  for (const line of diff.split("\n")) {
    const match = line.match(/^@@ -[^ ]+ \+([0-9]+)(?:,([0-9]+))? @@/u);
    if (!match) continue;
    const start = Number(match[1]);
    const length = Number(match[2] ?? "1");
    if (length > 0) ranges.push({ start, end: start + length - 1 });
  }
  return ranges;
}

function matchesExactContext(lines, owner) {
  const matchLines = owner.match.split("\n");
  if (matchLines.length !== owner.endLine - owner.startLine + 1) return { matches: 0, expectedStartMatches: false };
  let matches = 0;
  let expectedStartMatches = false;
  for (let start = 1; start <= lines.length - matchLines.length + 1; start += 1) {
    const before = start === 1 ? "" : lines[start - 2];
    const afterIndex = start - 1 + matchLines.length;
    const after = afterIndex >= lines.length ? "" : lines[afterIndex];
    const match = lines.slice(start - 1, start - 1 + matchLines.length).join("\n");
    if (before === owner.before && match === owner.match && after === owner.after) {
      matches += 1;
      if (start === owner.startLine) expectedStartMatches = true;
    }
  }
  return { matches, expectedStartMatches };
}

async function validateAnchorContents(root, manifest, errors) {
  if (!isRecord(manifest) || !Array.isArray(manifest.sharedHunkAnchors)) return;
  for (const entry of manifest.sharedHunkAnchors) {
    if (!isRecord(entry) || typeof entry.path !== "string" || !Array.isArray(entry.owners)) continue;
    let content;
    let diff;
    try {
      [content, diff] = await Promise.all([
        gitText(root, ["show", `${SAFETY_COMMIT}:${entry.path}`]),
        gitText(root, ["diff", "--unified=0", BASE_COMMIT, SAFETY_COMMIT, "--", entry.path]),
      ]);
    } catch {
      errors.push(`${entry.path}: 안전 커밋의 hunk 위치를 읽을 수 없습니다`);
      continue;
    }
    const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
    const ranges = parseAddedHunkRanges(diff);
    for (const rawOwner of entry.owners) {
      const owner = exactAnchor(rawOwner);
      if (!owner) continue;
      if (owner.endLine > lines.length) {
        errors.push(`${entry.path}: ${owner.slice} hunk 끝 행이 안전 파일 범위를 벗어납니다`);
        continue;
      }
      const actualBefore = owner.startLine === 1 ? "" : lines[owner.startLine - 2];
      const actualMatch = lines.slice(owner.startLine - 1, owner.endLine).join("\n");
      const actualAfter = owner.endLine === lines.length ? "" : lines[owner.endLine];
      if (owner.before !== actualBefore)
        errors.push(`${entry.path}: ${owner.slice} hunk 이전 문맥이 일치하지 않습니다`);
      if (owner.match !== actualMatch) errors.push(`${entry.path}: ${owner.slice} hunk 본문이 일치하지 않습니다`);
      if (owner.after !== actualAfter) errors.push(`${entry.path}: ${owner.slice} hunk 다음 문맥이 일치하지 않습니다`);
      if (!ranges.some((range) => owner.startLine >= range.start && owner.endLine <= range.end)) {
        errors.push(`${entry.path}: ${owner.slice} hunk 위치가 base→safety 변경 범위에 없습니다`);
      }
      const context = matchesExactContext(lines, owner);
      if (!context.expectedStartMatches || context.matches !== 1) {
        errors.push(`${entry.path}: ${owner.slice} hunk line·전후 문맥이 유일하지 않습니다`);
      }
    }
  }
}

async function validateStrictSafetyEvidence(root, manifest, errors) {
  for (const commit of [BASE_COMMIT, SAFETY_COMMIT]) {
    if (!(await commitExists(root, commit))) errors.push(`필수 커밋이 존재하지 않습니다: ${commit}`);
  }
  if (errors.length > 0) return;

  let actualEntries;
  try {
    actualEntries = await listSafetyDiffEntries(root, BASE_COMMIT, SAFETY_COMMIT);
  } catch (error) {
    errors.push(`안전 스냅샷 diff를 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const expectedEntries =
    isRecord(manifest) && isRecord(manifest.safetyDiff) && Array.isArray(manifest.safetyDiff.entries)
      ? manifest.safetyDiff.entries
      : [];
  if (
    actualEntries.length !== expectedEntries.length ||
    actualEntries.some((entry, index) => entry !== expectedEntries[index])
  ) {
    errors.push("안전 스냅샷의 실제 status·path 목록이 원장과 일치하지 않습니다");
  }
  const digest = sha256(canonicalSafetyDiff(actualEntries));
  if (!isRecord(manifest) || !isRecord(manifest.safetyDiff) || manifest.safetyDiff.sha256 !== digest) {
    errors.push("안전 스냅샷의 실제 status·path SHA-256 digest가 원장과 일치하지 않습니다");
  }
  if (digest !== SAFETY_DIFF_SHA256) {
    errors.push("안전 스냅샷의 실제 status·path 목록 기준 SHA-256이 일치하지 않습니다");
  }
  await validateAnchorContents(root, manifest, errors);
}

export async function validatePhase30Reconciliation(root, options = {}) {
  const errors = [];
  const requireSafety = options.requireSafety === true;
  const overridePath = typeof options.manifestPath === "string" ? options.manifestPath : undefined;
  let manifest;
  try {
    manifest = await loadReconciliationManifest(root, overridePath);
  } catch (error) {
    errors.push(`원장을 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}`);
    return errors;
  }
  errors.push(...validateManifestCoverage(manifest));
  if (requireSafety && errors.length === 0) await validateStrictSafetyEvidence(root, manifest, errors);
  return [...new Set(errors)].sort();
}

export function parseReconciliationArguments(argv) {
  if (!Array.isArray(argv)) throw new Error("원장 검증 인자가 유효하지 않습니다");
  let requireSafety = false;
  for (const argument of argv) {
    if (argument === "--require-safety") {
      requireSafety = true;
      continue;
    }
    throw new Error(`지원하지 않는 원장 검증 인자입니다: ${String(argument)}`);
  }
  return { requireSafety };
}

async function main() {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const root = resolve(scriptDirectory, "..");
  let options;
  try {
    options = parseReconciliationArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`ERROR ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  const errors = await validatePhase30Reconciliation(root, options);
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`ERROR ${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    options.requireSafety
      ? `Phase 30 정합성 원장 strict 검증 통과 (${String(EXPECTED_DIFF_PATH_COUNT)} paths)\n`
      : `Phase 30 정합성 원장 정적 검증 통과 (${String(EXPECTED_DIFF_PATH_COUNT)} paths)\n`,
  );
}

async function isDirectExecution() {
  if (!process.argv[1]) return false;
  const invokedPath = resolve(process.argv[1]);
  const modulePath = fileURLToPath(import.meta.url);
  try {
    const [canonicalInvokedPath, canonicalModulePath] = await Promise.all([
      realpath(invokedPath),
      realpath(modulePath),
    ]);
    return canonicalInvokedPath === canonicalModulePath;
  } catch {
    return invokedPath === modulePath;
  }
}

if (await isDirectExecution()) {
  await main();
}
