#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertContainedSymlinks, removeEscapingDeploySelfReference } from "../../../scripts/build-release.mjs";
import { prepareDesktopRuntime } from "./prepare-runtime.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(directory, "runtime-stage.manifest.json");

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function requireFile(file, label) {
  if (!(await stat(file).catch(() => undefined))?.isFile()) throw new Error(`${label} 파일이 없습니다`);
}

async function validatePortablePackage(packageDirectory, entry) {
  await requireFile(path.join(packageDirectory, entry), entry);
  const packageJson = await readJson(path.join(packageDirectory, "package.json"));
  if (packageJson.type !== "module") throw new Error(`${packageJson.name ?? packageDirectory}은 ESM 패키지여야 합니다`);

  await assertContainedSymlinks(packageDirectory);
  const dependencies = Object.keys(packageJson.dependencies ?? {});
  for (const dependency of dependencies) {
    const dependencyPath = path.join(packageDirectory, "node_modules", ...dependency.split("/"));
    const metadata = await lstat(dependencyPath).catch(() => undefined);
    if (!metadata) throw new Error(`${packageJson.name}의 ${dependency} 의존성이 staging 경계에 없습니다`);
    if (metadata.isSymbolicLink()) {
      throw new Error(`${packageJson.name}의 직접 의존성 ${dependency}은 symbolic link일 수 없습니다`);
    }
  }
}

export async function validateStage(stageDirectory, manifest) {
  await validatePortablePackage(path.join(stageDirectory, manifest.bridge.destination), manifest.bridge.entry);
  await validatePortablePackage(path.join(stageDirectory, manifest.server.destination), manifest.server.entry);
  await validatePortablePackage(path.join(stageDirectory, manifest.cli.destination), manifest.cli.entry);
}

async function runtimeStageDigest(directory) {
  const digest = createHash("sha256");
  const visit = async (current, relative = "") => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const nextRelative = path.join(relative, entry.name);
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        digest.update(`directory:${nextRelative}\n`);
        await visit(next, nextRelative);
      } else if (entry.isSymbolicLink()) {
        digest.update(`symlink:${nextRelative}:${await readlink(next)}\n`);
      } else if (entry.isFile()) {
        digest.update(`file:${nextRelative}\n`);
        digest.update(await readFile(next));
      } else {
        throw new Error(`runtime stage에 지원하지 않는 파일이 있습니다: ${nextRelative}`);
      }
    }
  };
  await visit(directory);
  return `${digest.digest("hex")}\n`;
}

/** 내용이 바뀐 staging만 Cargo resource copy 입력으로 표시합니다. */
export async function updateRuntimeStageStamp(stageDirectory, stampPath) {
  const next = await runtimeStageDigest(stageDirectory);
  const current = await readFile(stampPath, "utf8").catch(() => undefined);
  if (current === next) return false;
  await writeFile(stampPath, next, { mode: 0o600 });
  return true;
}

function pnpm(workspace, arguments_, label, environment = process.env) {
  const result = spawnSync("pnpm", arguments_, {
    cwd: workspace,
    encoding: "utf8",
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} 실패`);
}

export function deployArguments(packageName, destination) {
  return [
    "--config.inject-workspace-packages=true",
    "--config.node-linker=hoisted",
    "--filter",
    packageName,
    "--prod",
    "deploy",
    destination,
  ];
}

export function buildEnvironment(environment = process.env) {
  return { ...environment, pnpm_config_verify_deps_before_run: "warn" };
}

function deploy(workspace, packageName, destination) {
  pnpm(workspace, deployArguments(packageName, destination), `${packageName} portable deploy`);
}

export async function stageBundledExtensions(workspace, destination) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const entries = [];
  for (const name of ["slack", "discord", "github"]) {
    const packageName = `@massion-ext/${name}`;
    pnpm(workspace, ["--filter", packageName, "build"], `${packageName} build`, buildEnvironment());
    const source = path.join(workspace, "extensions", name);
    const result = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], {
      cwd: source,
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${packageName} package 실패`);
    const packed = JSON.parse(result.stdout);
    const archive = packed?.[0]?.filename;
    if (typeof archive !== "string" || archive !== path.basename(archive) || !archive.endsWith(".tgz"))
      throw new Error(`${packageName} package artifact가 유효하지 않습니다`);
    const packageJson = await readJson(path.join(source, "package.json"));
    entries.push({
      packageName,
      packageVersion: packageJson.version,
      archive,
      artifactDigest: createHash("sha256")
        .update(await readFile(path.join(destination, archive)))
        .digest("hex"),
    });
  }
  await writeFile(path.join(destination, "official-extensions.json"), `${JSON.stringify(entries, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function stageRuntime() {
  const manifest = await readJson(manifestPath);
  const workspace = path.resolve(directory, "../../..");
  const output = path.resolve(directory, manifest.output);
  if (path.dirname(output) !== directory) throw new Error("staging 경로는 src-tauri 직하에 있어야 합니다");

  const temporary = path.join(directory, `.runtime-stage-${process.pid}`);
  const stamp = `${output}.stamp`;
  await prepareDesktopRuntime({ includeNode: true });
  for (const packageName of manifest.build) {
    pnpm(workspace, ["--filter", packageName, "build"], `${packageName} build`, buildEnvironment());
  }
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  try {
    const bridge = path.join(temporary, manifest.bridge.destination);
    const server = path.join(temporary, manifest.server.destination);
    const cli = path.join(temporary, manifest.cli.destination);
    await stageBundledExtensions(workspace, path.join(temporary, "extensions"));
    deploy(workspace, manifest.bridge.package, bridge);
    await removeEscapingDeploySelfReference(bridge, manifest.bridge.package);
    deploy(workspace, manifest.server.package, server);
    await removeEscapingDeploySelfReference(server, manifest.server.package);
    deploy(workspace, manifest.cli.package, cli);
    await removeEscapingDeploySelfReference(cli, manifest.cli.package);
    await validateStage(temporary, manifest);
    await cp(path.join(directory, "runtime-manifest.json"), path.join(temporary, "runtime-manifest.json"));
    await rm(output, { recursive: true, force: true });
    await rename(temporary, output);
    await updateRuntimeStageStamp(output, stamp);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await stageRuntime();
}
