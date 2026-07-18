import { access, readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { reconciliationManifestPath, validatePhase30Reconciliation } from "./verify-phase30-reconciliation.mjs";

const execFileAsync = promisify(execFile);

const TRACE_COLUMNS = [
  "requirement_id",
  "source",
  "phase",
  "design",
  "plan",
  "tests",
  "commits",
  "runtime_events",
  "metrics",
  "status",
  "evidence",
];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function markdownFiles(path) {
  if (!(await exists(path))) return [];
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(child)));
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(child);
  }
  return files;
}

async function validatePhaseFiles(root, errors) {
  const phases = join(root, "docs", "phases");
  if (!(await exists(phases))) {
    errors.push("docs/phases 디렉터리 누락");
    return;
  }
  for (const entry of await readdir(phases, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d{2}-/.test(entry.name)) continue;
    const phase = join(phases, entry.name);
    for (const required of ["design.md", "implementation-plan.md"]) {
      if (!(await exists(join(phase, required)))) errors.push(`${entry.name}: ${required} 누락`);
    }
    const designPath = join(phase, "design.md");
    if (await exists(designPath)) {
      const design = await readFile(designPath, "utf8");
      if (/\*\*상태\*\*:\s*completed/.test(design) && !(await exists(join(phase, "review.md")))) {
        errors.push(`${entry.name}: completed Phase의 review.md 누락`);
      }
    }
    const reviewPath = join(phase, "review.md");
    const planPath = join(phase, "implementation-plan.md");
    if ((await exists(reviewPath)) && (await exists(planPath))) {
      const review = await readFile(reviewPath, "utf8");
      const plan = await readFile(planPath, "utf8");
      if (/\*\*(?:상태|결과)\*\*:\s*completed/.test(review) && /^- \[ \]/m.test(plan)) {
        errors.push(`${entry.name}: completed Phase의 미체크 구현 작업`);
      }
    }
  }
}

async function commitExists(root, commit) {
  try {
    await execFileAsync("git", ["-C", root, "cat-file", "-e", `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function validateTrace(root, errors) {
  const tracePath = join(root, "docs", "generated", "requirements-traceability.tsv");
  if (!(await exists(tracePath))) {
    errors.push("requirements-traceability.tsv 누락");
    return;
  }
  const lines = (await readFile(tracePath, "utf8")).trim().split("\n");
  const header = lines.shift()?.split("\t") ?? [];
  if (header.join("\t") !== TRACE_COLUMNS.join("\t")) errors.push("요구사항 추적표 열 스키마 불일치");
  const seen = new Set();
  for (const [offset, line] of lines.entries()) {
    const row = line.split("\t");
    const lineNumber = offset + 2;
    if (row.length !== TRACE_COLUMNS.length) {
      errors.push(`요구사항 추적표 ${lineNumber}행 열 개수 불일치`);
      continue;
    }
    const id = row[0];
    if (!/^REQ-(?:[A-Z][A-Z0-9]*-)+\d{3}$/.test(id)) errors.push(`잘못된 요구사항 ID: ${id}`);
    if (seen.has(id)) errors.push(`중복 요구사항 ID: ${id}`);
    seen.add(id);
    const completed = row[9] === "completed";
    for (const column of completed ? [3, 4, 5, 10] : [3, 4]) {
      for (const value of row[column].split(",")) {
        if (value !== "not-applicable" && value !== "pending" && !(await exists(join(root, value)))) {
          errors.push(`${id}: 존재하지 않는 추적 경로 ${value}`);
        }
      }
    }
    if (completed) {
      for (const commit of row[6].split(",")) {
        if (commit !== "not-applicable" && commit !== "pending" && !(await commitExists(root, commit))) {
          errors.push(`${id}: 존재하지 않는 추적 커밋 ${commit}`);
        }
      }
    }
  }
}

async function validateMarkdown(root, errors) {
  const docs = join(root, "docs");
  const phaseRoot = join(docs, "phases");
  const candidates = [
    ...(await markdownFiles(join(docs, "product"))),
    ...(await markdownFiles(join(docs, "history"))),
    ...(await markdownFiles(join(docs, "architecture"))),
    ...(await markdownFiles(join(docs, "decisions"))),
    ...(await markdownFiles(join(docs, "evidence"))),
    ...(await markdownFiles(join(docs, "operations"))),
    ...(await markdownFiles(join(docs, "superpowers"))),
  ];
  if (await exists(phaseRoot)) {
    for (const entry of await readdir(phaseRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\d{2}-/.test(entry.name)) {
        candidates.push(...(await markdownFiles(join(phaseRoot, entry.name))));
      }
    }
  }
  for (const path of [...new Set(candidates)]) {
    const content = await readFile(path, "utf8");
    if (/\b(?:TODO|TBD|FIXME)\b/.test(content)) {
      errors.push(`${relative(root, path)}: 금지된 임시 표기`);
    }
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].replace(/^<|>$/g, "").split("#", 1)[0];
      if (!target || /^(?:https?:|mailto:|\/)/.test(target)) continue;
      const resolved = resolve(dirname(path), decodeURIComponent(target));
      if (!(await exists(resolved))) errors.push(`${relative(root, path)}: 깨진 로컬 링크 ${match[1]}`);
    }
  }
}

async function validatePhase30ReconciliationManifest(root, errors) {
  if (!(await exists(reconciliationManifestPath(root)))) return;
  for (const error of await validatePhase30Reconciliation(root)) {
    errors.push(`Phase 30 정합성 원장: ${error}`);
  }
}

export async function validateDocs(root) {
  const errors = [];
  await validatePhaseFiles(root, errors);
  await validateTrace(root, errors);
  await validateMarkdown(root, errors);
  await validatePhase30ReconciliationManifest(root, errors);
  return errors.sort();
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(scriptDir, "..");
  const errors = await validateDocs(root);
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`ERROR ${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("문서 구조 검증 통과\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
