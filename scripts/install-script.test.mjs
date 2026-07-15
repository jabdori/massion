import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { clearTimeout, setTimeout } from "node:timers";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function filesUnder(path) {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(child)));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function checksums(bundle) {
  const lines = [];
  for (const path of await filesUnder(bundle)) {
    const name = relative(bundle, path).split(sep).join("/");
    if (name === "SHA256SUMS") continue;
    const digest = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    lines.push(`${digest}  ${name}`);
  }
  await writeFile(join(bundle, "SHA256SUMS"), `${lines.sort().join("\n")}\n`, { mode: 0o600 });
}

test("상위 install.sh가 고정 릴리스 매니페스트와 해시를 검증한 뒤 개인용 설치기를 호출한다", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "massion bootstrap install "));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const bundle = join(root, "bundle");
  const artifact = join(root, "massion-local-1.0.0.tar.gz");
  const prefix = join(root, "prefix");
  await mkdir(bundle, { recursive: true, mode: 0o700 });
  await cp(join(repositoryRoot, "release/install.sh"), join(bundle, "install.sh"));
  await cp(join(repositoryRoot, "release/uninstall.sh"), join(bundle, "uninstall.sh"));
  await chmod(join(bundle, "install.sh"), 0o700);
  await chmod(join(bundle, "uninstall.sh"), 0o700);
  for (const path of [
    "runtime/node_modules/@massion/cli/dist/main.js",
    "runtime/node_modules/@massion/connector/dist/main.js",
    "runtime/node_modules/@massion/server/dist/main.js",
    "runtime/node_modules/@massion/tui/dist/main.js",
  ]) {
    const absolute = join(bundle, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, "#!/usr/bin/env node\n", { mode: 0o600 });
  }
  await writeFile(
    join(bundle, "release-bundle.json"),
    `${JSON.stringify({ schema: "massion.release-bundle.v1", version: "1.0.0" })}\n`,
    { mode: 0o600 },
  );
  await mkdir(join(bundle, "web"), { recursive: true });
  await writeFile(join(bundle, "web", "index.html"), "<!doctype html>\n", { mode: 0o600 });
  await checksums(bundle);
  const archive = spawnSync("tar", ["-czf", artifact, "."], { cwd: bundle, encoding: "utf8" });
  assert.equal(archive.status, 0, archive.stderr);
  const digest = createHash("sha256")
    .update(await readFile(artifact))
    .digest("hex");
  const manifest = JSON.stringify({
    schema: "massion.release.v1",
    version: "1.0.0",
    artifacts: [{ name: "massion-local-1.0.0.tar.gz", digest: `sha256:${digest}` }],
  });
  const server = createServer((request, response) => {
    if (request.url === "/release-manifest.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(manifest);
      return;
    }
    if (request.url === "/massion-local-1.0.0.tar.gz") {
      response.writeHead(200, { "content-type": "application/gzip" });
      response.end(readFileSync(artifact));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  context.after(
    async () =>
      await new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const result = await new Promise((resolveResult, rejectResult) => {
    const child = spawn("sh", [join(repositoryRoot, "install.sh")], {
      env: {
        ...process.env,
        MASSION_RELEASE_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
        MASSION_VERSION: "1.0.0",
        MASSION_PREFIX: prefix,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectResult(new Error("install.sh 테스트가 시간 제한을 초과했습니다"));
    }, 30_000);
    child.once("error", rejectResult);
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      resolveResult({ status, signal, stdout, stderr });
    });
  });
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const installed = await readdir(join(prefix, "bin"));
  assert.deepEqual(installed.sort(), ["massion", "massion-connector", "massion-server"]);
});
