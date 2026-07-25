import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(directory, "runtime-manifest.json");
const SHA256 = /^[a-f0-9]{64}$/u;

export function runtimePlatformForTarget(target) {
  if (target === "aarch64-apple-darwin") return { platform: "darwin", architecture: "arm64" };
  throw new Error("지원하지 않는 Massion desktop runtime target입니다");
}

async function digest(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function verifiedSource(source, expectedSha256) {
  const metadata = await lstat(source);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o111) === 0)
    throw new Error("Massion native runtime은 실행 가능한 regular file이어야 합니다");
  if ((await digest(source)) !== expectedSha256)
    throw new Error("Massion native runtime SHA-256이 manifest와 일치하지 않습니다");
  return source;
}

/** 고정된 digest를 만족하는 sidecar만 Tauri 외부 바이너리 입력으로 물질화합니다. */
export async function stageRuntimeInput({ destination, expectedSha256, source }) {
  if (!SHA256.test(expectedSha256)) throw new Error("Massion native runtime SHA-256이 유효하지 않습니다");
  const verified = await verifiedSource(source, expectedSha256);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(verified, destination);
  await chmod(destination, 0o700);
  await verifiedSource(destination, expectedSha256);
  return destination;
}

async function cachedSurrealRuntime(root, expectedSha256) {
  const source = path.join(root, "runtime", "surrealdb", "3.2.1", "darwin-arm64", "surreal");
  try {
    return await verifiedSource(source, expectedSha256);
  } catch {
    return undefined;
  }
}

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${arguments_.join(" ")} 실행이 실패했습니다`);
}

async function foundFile(root, name) {
  const matches = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name === name) matches.push(candidate);
    }
  };
  await visit(root);
  if (matches.length !== 1) throw new Error(`공식 runtime archive에서 ${name} 실행 파일을 하나만 찾아야 합니다`);
  return matches[0];
}

async function downloadPinnedRuntime(runtime, executable, destination) {
  if (typeof runtime?.archiveUrl !== "string" || !SHA256.test(runtime?.archiveSha256 ?? ""))
    throw new Error("Massion desktop runtime archive manifest가 유효하지 않습니다");
  const temporary = await mkdtemp(path.join(tmpdir(), "massion-desktop-runtime-"));
  try {
    const archive = path.join(temporary, "runtime.archive");
    run("curl", ["--fail", "--location", "--silent", "--show-error", "--output", archive, runtime.archiveUrl]);
    if ((await digest(archive)) !== runtime.archiveSha256)
      throw new Error("Massion desktop runtime archive SHA-256이 manifest와 일치하지 않습니다");
    run("tar", ["-xf", archive, "-C", temporary]);
    return await stageRuntimeInput({
      destination,
      expectedSha256: runtime.binarySha256,
      source: await foundFile(temporary, executable),
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** 개발과 릴리스가 같은 검증된 SurrealDB sidecar 입력을 사용하게 준비합니다. */
export async function prepareDesktopRuntime({ environment = process.env, includeNode = false } = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const surrealdb = manifest?.runtimes?.surrealdb;
  if (
    manifest?.target !== "aarch64-apple-darwin" ||
    typeof surrealdb?.version !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(surrealdb.version) ||
    typeof surrealdb?.input !== "string" ||
    typeof surrealdb?.binarySha256 !== "string" ||
    !SHA256.test(surrealdb.binarySha256)
  )
    throw new Error("Massion desktop runtime manifest가 유효하지 않습니다");

  const sourceOverride = environment.MASSION_SURREAL_BINARY;
  const dataHome = environment.XDG_DATA_HOME ?? path.join(environment.HOME ?? homedir(), ".local", "share");
  const runtimeRoot = path.join(dataHome, "massion");
  // target 검증은 명시적으로 유지합니다. 빌드 호스트가 아니라 배포 대상이 runtime을 결정합니다.
  runtimePlatformForTarget(manifest.target);
  const source = sourceOverride
    ? sourceOverride
    : ((await cachedSurrealRuntime(runtimeRoot, surrealdb.binarySha256)) ??
      (await downloadPinnedRuntime(
        surrealdb,
        "surreal",
        path.join(runtimeRoot, "runtime", "surrealdb", surrealdb.version, "darwin-arm64", "surreal"),
      )));
  const stagedSurrealdb = await stageRuntimeInput({
    destination: path.join(directory, surrealdb.input),
    expectedSha256: surrealdb.binarySha256,
    source,
  });
  if (!includeNode) return { surrealdb: stagedSurrealdb };

  const node = manifest?.runtimes?.node;
  if (typeof node?.input !== "string" || !SHA256.test(node?.binarySha256 ?? ""))
    throw new Error("Massion desktop Node runtime manifest가 유효하지 않습니다");
  const stagedNode = await downloadPinnedRuntime(node, "node", path.join(directory, node.input));
  return { node: stagedNode, surrealdb: stagedSurrealdb };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await prepareDesktopRuntime({ includeNode: process.argv.includes("--release") });
}
