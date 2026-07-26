import assert from "node:assert/strict";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseArguments, parseUatEvidence, verificationOptions, verifyDesktopRelease } from "./verify-desktop-release.mjs";

const candidateSha = "a".repeat(40);
const uatIds = [
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

function evidence(status = "passed") {
  return [
    "<!-- desktop-uat-evidence: actual-tauri -->",
    `<!-- desktop-release-candidate-sha: ${candidateSha} -->`,
    ...uatIds.map((id) => `<!-- desktop-uat: ${id}=${status} -->`),
  ].join("\n");
}

test("실제 Tauri 표식과 23개 원자 UAT만 통과한 증거를 수락한다", () => {
  const parsed = parseUatEvidence(evidence());
  assert.equal(parsed.candidateSha, candidateSha);
  assert.equal(parsed.statuses.size, 23);
  assert.throws(() => parseUatEvidence(evidence("skipped")), /모두 통과/u);
  assert.throws(() => parseUatEvidence(evidence().replace("UAT-01=passed", "UAT-14=passed")), /지원하지 않는/u);
});

test("fixture 표식·누락 결과·인자 오류를 완료 근거로 허용하지 않는다", () => {
  assert.throws(() => parseUatEvidence(evidence().replace("actual-tauri", "fixture")), /실제 Tauri/u);
  assert.throws(() => parseUatEvidence(evidence().replace(/<!-- desktop-uat: UAT-P02=passed -->\n?/u, "")), /UAT-P02/u);
  const parsed = parseArguments(["--candidate-sha", candidateSha, "--app", "/tmp/Massion.app", "--uat-evidence", "/tmp/uat.md"]);
  assert.deepEqual(parsed, {
    "candidate-sha": candidateSha,
    app: "/tmp/Massion.app",
    "uat-evidence": "/tmp/uat.md",
  });
  assert.deepEqual(verificationOptions(parsed), {
    candidateSha,
    app: "/tmp/Massion.app",
    uatEvidence: "/tmp/uat.md",
  });
  assert.throws(() => parseArguments(["--candidate-sha", candidateSha, "--app", "/tmp/Massion.app"]), /uat-evidence/u);
});

test("동일 후보의 version·서명·sidecar·manifest를 한 번에 검증한다", async (context) => {
  const root = await os.tmpdir();
  const directory = path.join(root, `massion-desktop-release-${process.pid}-${Date.now()}`);
  const app = path.join(directory, "Massion.app");
  const repo = path.join(directory, "repo");
  await mkdir(path.join(app, "Contents/MacOS"), { recursive: true });
  await mkdir(path.join(app, "Contents/Resources"), { recursive: true });
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ version: "1.0.0" }));
  await writeFile(path.join(directory, "uat.md"), evidence());
  await writeFile(path.join(app, "Contents/MacOS/node"), "node");
  await writeFile(path.join(app, "Contents/MacOS/surrealdb"), "surrealdb");
  await chmod(path.join(app, "Contents/MacOS/node"), 0o700);
  await chmod(path.join(app, "Contents/MacOS/surrealdb"), 0o700);
  await writeFile(path.join(app, "Contents/Resources/runtime-manifest.json"), JSON.stringify({ runtimes: { node: {}, surrealdb: {} } }));
  context.after(() => rm(directory, { recursive: true, force: true }));

  const calls = [];
  const run = (name, arguments_) => {
    calls.push([name, arguments_]);
    if (name === "git") return candidateSha;
    if (name === "plutil") return "1.0.0";
    return "";
  };
  const result = await verifyDesktopRelease({
    candidateSha,
    app,
    uatEvidence: path.join(directory, "uat.md"),
    repoRoot: repo,
    run,
  });
  assert.equal(result.uatCount, 23);
  assert.deepEqual(calls.map(([name]) => name), ["git", "plutil", "codesign", "spctl", "xcrun"]);
});
