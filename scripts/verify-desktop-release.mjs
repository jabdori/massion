#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const SHA = /^[0-9a-f]{40}$/u;
const UAT_IDS = [
  ...Array.from({ length: 12 }, (_, index) => `UAT-${String(index + 1).padStart(2, "0")}`),
  "UAT-13",
  "UAT-15",
  "UAT-16",
  "UAT-G01",
  "UAT-G02",
  "UAT-K01",
  "UAT-K02",
  "UAT-K03",
  "UAT-K04",
  "UAT-P01",
  "UAT-P02",
];
const UAT_ID_SET = new Set(UAT_IDS);

function command(commandName, arguments_, options = {}) {
  const result = spawnSync(commandName, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    stdio: "pipe",
  });
  if (result.error) throw new Error(`${commandName}를 실행할 수 없습니다`);
  if (result.status !== 0) throw new Error(`${commandName} 검증이 실패했습니다`);
  return String(result.stdout ?? "").trim();
}

export function parseArguments(arguments_) {
  const values = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith("--") || values[argument.slice(2)] !== undefined) {
      throw new Error("릴리스 검증 인자가 중복되었거나 유효하지 않습니다");
    }
    const name = argument.slice(2);
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} 값이 필요합니다`);
    values[name] = value;
    index += 1;
  }
  for (const required of ["candidate-sha", "app", "uat-evidence"]) {
    if (!values[required]) throw new Error(`--${required} 인자가 필요합니다`);
  }
  if (Object.keys(values).some((key) => !["candidate-sha", "app", "uat-evidence"].includes(key))) {
    throw new Error("지원하지 않는 릴리스 검증 인자입니다");
  }
  return values;
}

export function verificationOptions(arguments_) {
  return {
    candidateSha: arguments_["candidate-sha"],
    app: arguments_.app,
    uatEvidence: arguments_["uat-evidence"],
  };
}

export function parseUatEvidence(text) {
  if (!text.includes("<!-- desktop-uat-evidence: actual-tauri -->")) {
    throw new Error("UAT evidence가 실제 Tauri 실행 증거로 표시되지 않았습니다");
  }
  const candidate = text.match(/<!--\s*desktop-release-candidate-sha:\s*([0-9a-f]{40})\s*-->/u)?.[1];
  if (!candidate) throw new Error("UAT evidence에 후보 SHA가 없습니다");

  const statuses = new Map();
  const markerPattern = /<!--\s*desktop-uat:\s*([^=\s]+)=(passed|failed|skipped)\s*-->/gu;
  for (const match of text.matchAll(markerPattern)) {
    const [, id, status] = match;
    if (!UAT_ID_SET.has(id)) throw new Error(`지원하지 않는 UAT ID입니다: ${id}`);
    if (statuses.has(id)) throw new Error(`UAT 결과가 중복되었습니다: ${id}`);
    statuses.set(id, status);
  }
  if (statuses.size !== UAT_IDS.length || UAT_IDS.some((id) => statuses.get(id) !== "passed")) {
    const missing = UAT_IDS.filter((id) => statuses.get(id) !== "passed");
    throw new Error(`필수 실제 UAT가 모두 통과하지 않았습니다: ${missing.join(", ")}`);
  }
  return { candidateSha: candidate, statuses };
}

async function verifySidecars(app) {
  for (const name of ["node", "surrealdb"]) {
    const path = join(app, "Contents", "MacOS", name);
    const metadata = await lstat(path).catch(() => undefined);
    if (!metadata?.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o111) === 0) {
      throw new Error(`앱 sidecar가 유효하지 않습니다: ${name}`);
    }
  }
  const manifestPath = join(app, "Contents", "Resources", "runtime-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8").catch(() => "null"));
  if (!manifest || typeof manifest !== "object" || !manifest.runtimes?.node || !manifest.runtimes?.surrealdb) {
    throw new Error("앱 runtime manifest가 유효하지 않습니다");
  }
}

export async function verifyDesktopRelease({
  candidateSha,
  app,
  uatEvidence,
  repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url))),
  expectedVersion,
  run = command,
}) {
  if (!SHA.test(candidateSha)) throw new Error("candidate SHA가 40자리 commit이 아닙니다");
  const appPath = resolve(app);
  const evidencePath = resolve(uatEvidence);
  const currentSha = run("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  if (currentSha !== candidateSha) throw new Error("현재 소스와 릴리스 후보 SHA가 다릅니다");

  const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const version = expectedVersion ?? packageJson.version;
  const plistPath = join(appPath, "Contents", "Info.plist");
  const appVersion = run("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plistPath], {
    cwd: repoRoot,
  });
  if (appVersion !== version) throw new Error(`앱 version이 소스 version과 다릅니다: ${appVersion}`);

  const evidence = parseUatEvidence(await readFile(evidencePath, "utf8"));
  if (evidence.candidateSha !== candidateSha) throw new Error("UAT evidence의 후보 SHA가 다릅니다");

  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], { cwd: repoRoot });
  run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath], { cwd: repoRoot });
  run("xcrun", ["stapler", "validate", appPath], { cwd: repoRoot });
  await verifySidecars(appPath);

  return { candidateSha, version, app: appPath, uatCount: UAT_IDS.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const arguments_ = parseArguments(process.argv.slice(2));
    const result = await verifyDesktopRelease(verificationOptions(arguments_));
    console.log(`개인용 데스크톱 후보 검증 통과: ${result.version} ${result.candidateSha} (${result.uatCount}개 UAT)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "개인용 데스크톱 후보 검증이 실패했습니다");
    process.exitCode = 1;
  }
}
