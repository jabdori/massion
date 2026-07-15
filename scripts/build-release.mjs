import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createReleaseManifest, verifyReleaseVersions } from "./release-manifest.mjs";

const VERSION = "1.0.0";
const DIGEST = /^[a-f0-9]{64}$/u;

export function assertCleanReleaseTree(status) {
  if (status.trim()) throw new Error("release는 clean Git tree에서만 만들 수 있습니다");
}

export function createChecksumLines(entries) {
  const seen = new Set();
  return entries
    .map((entry) => {
      if (
        typeof entry.path !== "string" ||
        entry.path.startsWith("/") ||
        entry.path.split("/").includes("..") ||
        entry.path.includes("\\") ||
        !DIGEST.test(entry.digest)
      )
        throw new Error("checksum path 또는 digest가 유효하지 않습니다");
      if (seen.has(entry.path)) throw new Error(`checksum path가 중복됐습니다: ${entry.path}`);
      seen.add(entry.path);
      return entry;
    })
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => `${entry.digest}  ${entry.path}`);
}

export async function verifyRuntimeEntrypoints(root, entrypoints) {
  if (!entrypoints || typeof entrypoints !== "object" || Array.isArray(entrypoints))
    throw new Error("release runtime entrypoint 설정이 유효하지 않습니다");

  for (const [name, path] of Object.entries(entrypoints)) {
    if (
      typeof path !== "string" ||
      path.length === 0 ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").includes("..")
    )
      throw new Error(`release runtime entrypoint 경로가 유효하지 않습니다: ${name}`);

    let metadata;
    try {
      metadata = await lstat(resolve(root, path));
    } catch (error) {
      throw new Error(`release runtime entrypoint가 없습니다: ${name} (${path})`, { cause: error });
    }
    if (!metadata.isFile()) throw new Error(`release runtime entrypoint가 일반 파일이 아닙니다: ${name} (${path})`);
  }
}

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export async function assertContainedSymlinks(root) {
  const runtimeRoot = resolve(root);
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        const target = await readlink(path);
        if (isAbsolute(target) || !isWithin(runtimeRoot, resolve(current, target))) {
          throw new Error("release runtime symbolic link가 runtime directory를 벗어납니다");
        }
      } else if (metadata.isDirectory()) {
        await visit(path);
      }
    }
  };
  await visit(runtimeRoot);
}

export async function removeEscapingDeploySelfReference(root, packageName) {
  if (typeof packageName !== "string" || !/^@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/u.test(packageName)) {
    throw new Error("deploy self reference package name이 유효하지 않습니다");
  }
  const runtimeRoot = resolve(root);
  const path = resolve(runtimeRoot, "node_modules", ".pnpm", "node_modules", ...packageName.split("/"));
  if (!isWithin(runtimeRoot, path)) throw new Error("deploy self reference path가 유효하지 않습니다");
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  if (!metadata.isSymbolicLink()) return false;
  const target = await readlink(path);
  if (!isAbsolute(target) && isWithin(runtimeRoot, resolve(dirname(path), target))) return false;
  await rm(path);
  return true;
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1", ...options.environment },
    maxBuffer: 32 * 1024 * 1024,
    stdio: options.capture === false ? "inherit" : "pipe",
  });
  if (result.status !== 0)
    throw new Error(`${command} ${arguments_.join(" ")} 실행이 실패했습니다: ${String(result.stderr).slice(0, 2048)}`);
  return result.stdout;
}

async function filesUnder(path) {
  const entries = [];
  for (const item of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, item.name);
    if (item.isDirectory()) entries.push(...(await filesUnder(child)));
    else if (item.isFile()) entries.push(child);
  }
  return entries;
}

async function digest(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function sourceDigest(root) {
  const files = String(run("git", ["ls-files", "-z"], { cwd: root }))
    .split("\0")
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256");
  for (const file of files)
    hash
      .update(file)
      .update("\0")
      .update(await readFile(resolve(root, file)))
      .update("\0");
  return hash.digest("hex");
}

async function workspacePackages(root) {
  const paths = [resolve(root, "package.json")];
  for (const directory of ["apps", "packages", "extensions"]) {
    for (const item of await readdir(resolve(root, directory), { withFileTypes: true })) {
      if (item.isDirectory()) paths.push(resolve(root, directory, item.name, "package.json"));
    }
  }
  return await Promise.all(
    paths.map(async (path) => {
      const value = JSON.parse(await readFile(path, "utf8"));
      return { name: value.name, version: value.version };
    }),
  );
}

async function writeChecksums(root, excluded = new Set(["SHA256SUMS"])) {
  const entries = [];
  for (const path of await filesUnder(root)) {
    const relativePath = relative(root, path).split(sep).join("/");
    if (!excluded.has(relativePath)) entries.push({ path: relativePath, digest: await digest(path) });
  }
  const lines = createChecksumLines(entries);
  await writeFile(resolve(root, "SHA256SUMS"), `${lines.join("\n")}\n`, { mode: 0o600 });
  return lines.length;
}

async function removeTestArtifacts(root) {
  for (const path of await filesUnder(root)) {
    if (/(?:^|\.)test\.(?:js|d\.ts)(?:\.map)?$/u.test(basename(path))) await rm(path);
  }
}

async function tar(directory, output) {
  run("tar", ["-czf", output, "."], { cwd: directory });
}

async function artifact(path) {
  const metadata = await stat(path);
  return { name: basename(path), bytes: metadata.size, digest: await digest(path) };
}

async function main() {
  const root = resolve(fileURLToPath(new globalThis.URL("..", import.meta.url)));
  const output = resolve(root, process.argv[2] ?? "artifacts/release-1.0.0");
  assertCleanReleaseTree(String(run("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root })));
  verifyReleaseVersions(VERSION, await workspacePackages(root));
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true, mode: 0o700 });
  const staging = resolve(output, ".staging");
  const local = resolve(staging, "local");
  const deploy = resolve(staging, "deploy");
  await mkdir(local, { recursive: true, mode: 0o700 });
  await mkdir(deploy, { recursive: true, mode: 0o700 });

  run("pnpm", ["--filter", "@massion/distribution", "build"], { cwd: root, capture: false });
  run("pnpm", ["--filter", "@massion/distribution", "deploy", "--prod", "--legacy", resolve(local, "runtime")], {
    cwd: root,
    capture: false,
  });
  await removeEscapingDeploySelfReference(resolve(local, "runtime"), "@massion/distribution");
  await assertContainedSymlinks(resolve(local, "runtime"));
  await removeTestArtifacts(resolve(local, "runtime"));
  await cp(resolve(root, "apps/web/dist"), resolve(local, "web"), { recursive: true });
  const entrypoints = {
    massion: "runtime/node_modules/@massion/cli/dist/main.js",
    connector: "runtime/node_modules/@massion/connector/dist/main.js",
    server: "runtime/node_modules/@massion/server/dist/main.js",
    tui: "runtime/node_modules/@massion/tui/dist/main.js",
  };
  await verifyRuntimeEntrypoints(local, entrypoints);
  await cp(resolve(root, "release/install.sh"), resolve(local, "install.sh"));
  await cp(resolve(root, "release/uninstall.sh"), resolve(local, "uninstall.sh"));
  await cp(resolve(root, "release/update.sh"), resolve(local, "update.sh"));
  await cp(resolve(root, "docs/operations/local-install.md"), resolve(local, "README.md"));
  await chmod(resolve(local, "install.sh"), 0o755);
  await chmod(resolve(local, "uninstall.sh"), 0o755);
  await chmod(resolve(local, "update.sh"), 0o755);

  const gitCommit = String(run("git", ["rev-parse", "HEAD"], { cwd: root })).trim();
  const source = await sourceDigest(root);
  const bundle = {
    schema: "massion.release-bundle.v1",
    version: VERSION,
    gitCommit,
    sourceDigest: `sha256:${source}`,
    platforms: ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"],
    entrypoints,
  };
  await writeFile(resolve(local, "release-bundle.json"), `${JSON.stringify(bundle, undefined, 2)}\n`, { mode: 0o600 });
  await writeChecksums(local);

  await cp(resolve(root, "compose.yaml"), resolve(deploy, "compose.yaml"));
  await cp(resolve(root, "deploy"), resolve(deploy, "deploy"), { recursive: true });
  await cp(resolve(root, "docs/operations"), resolve(deploy, "operations"), { recursive: true });
  await writeFile(
    resolve(deploy, "release-bundle.json"),
    `${JSON.stringify(
      {
        ...bundle,
        images: {
          MASSION_IMAGE: "massion:1.0.0",
          MASSION_SURREALDB_IMAGE: "massion-surrealdb:3.2.0",
          MASSION_CADDY_IMAGE: "massion-caddy:2.11.4",
        },
        start: "docker compose --file compose.yaml up -d --no-build --wait --wait-timeout 120",
      },
      undefined,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await writeChecksums(deploy);

  const localArchive = resolve(output, `massion-local-${VERSION}.tar.gz`);
  const deployArchive = resolve(output, `massion-deploy-${VERSION}.tar.gz`);
  await tar(local, localArchive);
  await tar(deploy, deployArchive);
  const toolchains = {
    node: process.versions.node,
    bun: String(run("bun", ["--version"], { cwd: root })).trim(),
    pnpm: String(run("pnpm", ["--version"], { cwd: root })).trim(),
  };
  const manifest = createReleaseManifest({
    version: VERSION,
    gitCommit,
    sourceDigest: source,
    toolchains,
    platforms: bundle.platforms,
    artifacts: [await artifact(localArchive), await artifact(deployArchive)],
  });
  await writeFile(resolve(output, "release-manifest.json"), `${JSON.stringify(manifest, undefined, 2)}\n`, {
    mode: 0o600,
  });
  await rm(staging, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ output, ...manifest })}\n`);
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) await main();
