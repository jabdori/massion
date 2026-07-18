import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const updateScript = join(repositoryRoot, "release/update.sh");

function runtimePlatform() {
  return `${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`;
}

async function makeInstalledRelease(context, version = "1.0.0") {
  const root = await mkdtemp(join(tmpdir(), "massion update "));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const release = join(root, "release");
  await mkdir(release, { recursive: true, mode: 0o700 });
  await cp(updateScript, join(release, "update.sh"));
  await writeFile(
    join(release, "release-bundle.json"),
    `${JSON.stringify({ schema: "massion.release-bundle.v1", version }, undefined, 2)}\n`,
    { mode: 0o600 },
  );
  return { release, root };
}

async function serveManifest(context, manifest, archive) {
  const server = createServer((request, response) => {
    if (request.url === "/release-manifest.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`${JSON.stringify(manifest)}\n`);
      return;
    }
    if (archive && request.url === `/${archive.name}`) {
      response.writeHead(200, { "content-type": "application/gzip" });
      response.end(archive.body);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  context.after(async () => await new Promise((resolveServer) => server.close(resolveServer)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function runUpdate(release, baseUrl, version, operation = "--check") {
  const child = spawn("sh", [join(release, "update.sh"), operation, "--json"], {
    env: {
      ...process.env,
      MASSION_RELEASE_BASE_URL: baseUrl,
      MASSION_VERSION: version,
      MASSION_PREFIX: join(release, "prefix"),
      MASSION_BUN_VERSION:
        process.env.MASSION_BUN_VERSION ?? spawnSync("bun", ["--version"], { encoding: "utf8" }).stdout.trim(),
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return await new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolveResult({ status, signal, stdout, stderr }));
  });
}

function manifest(version, platform = runtimePlatform(), artifactDigest = "c".repeat(64)) {
  return {
    schema: "massion.release.v1",
    version,
    gitCommit: "a".repeat(40),
    sourceDigest: `sha256:${"b".repeat(64)}`,
    toolchains: { node: process.versions.node, bun: "1.3.0", pnpm: "11.13.0" },
    compatibility: {
      platforms: [platform],
      node: { minMajor: Number(process.versions.node.split(".")[0]) },
      bun: { minVersion: "1.3.0" },
    },
    artifacts: [{ name: `massion-local-${version}.tar.gz`, bytes: 1, digest: `sha256:${artifactDigest}` }],
  };
}

test("update는 호환 가능한 최신 release를 설치하지 않고 JSON으로 보고한다", async (context) => {
  const { release } = await makeInstalledRelease(context);
  const baseUrl = await serveManifest(context, manifest("1.0.1"));
  const result = await runUpdate(release, baseUrl, "1.0.1");

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), {
    schema: "massion.update.v1",
    operation: "check",
    status: "available",
    currentVersion: "1.0.0",
    targetVersion: "1.0.1",
    compatible: true,
  });
});

test("update는 현재 플랫폼이 release 호환 목록에 없으면 중단한다", async (context) => {
  const { release } = await makeInstalledRelease(context);
  const incompatiblePlatform = process.platform === "darwin" ? "linux-amd64" : "darwin-arm64";
  const baseUrl = await serveManifest(context, manifest("1.0.1", incompatiblePlatform));
  const result = await runUpdate(release, baseUrl, "1.0.1");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /호환되지 않는 release/u);
});

test("upgrade는 아카이브 내부 bundle version이 manifest와 다르면 설치하지 않는다", async (context) => {
  const { release, root } = await makeInstalledRelease(context);
  const archiveRoot = join(root, "archive");
  const archivePath = join(root, "massion-local-1.0.1.tar.gz");
  await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(archiveRoot, "install.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await writeFile(join(archiveRoot, "SHA256SUMS"), "", { mode: 0o600 });
  await writeFile(
    join(archiveRoot, "release-bundle.json"),
    `${JSON.stringify({ schema: "massion.release-bundle.v1", version: "1.0.0" })}\n`,
    { mode: 0o600 },
  );
  const archive = spawnSync("tar", ["-czf", archivePath, "."], { cwd: archiveRoot, encoding: "utf8" });
  assert.equal(archive.status, 0, archive.stderr);
  const archiveBody = await readFile(archivePath);
  const archiveName = "massion-local-1.0.1.tar.gz";
  const archiveDigest = createHash("sha256").update(archiveBody).digest("hex");
  const baseUrl = await serveManifest(context, manifest("1.0.1", runtimePlatform(), archiveDigest), {
    name: archiveName,
    body: archiveBody,
  });
  const result = await runUpdate(release, baseUrl, "1.0.1", "--apply");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bundle version/u);
});
