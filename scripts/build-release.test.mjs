import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { URL } from "node:url";

import * as buildRelease from "./build-release.mjs";

const { assertCleanReleaseTree, createChecksumLines } = buildRelease;

test("tracked 변경이나 일반 untracked 파일이 있는 release tree를 거부한다", () => {
  assert.doesNotThrow(() => assertCleanReleaseTree(""));
  assert.throws(() => assertCleanReleaseTree(" M package.json\n"), /clean/u);
  assert.throws(() => assertCleanReleaseTree("?? secret.txt\n"), /clean/u);
});

test("bundle checksum을 경로순으로 정렬하고 위험한 경로를 거부한다", () => {
  assert.deepEqual(
    createChecksumLines([
      { path: "runtime/z.js", digest: "b".repeat(64) },
      { path: "install.sh", digest: "a".repeat(64) },
    ]),
    [`${"a".repeat(64)}  install.sh`, `${"b".repeat(64)}  runtime/z.js`],
  );
  assert.throws(() => createChecksumLines([{ path: "../secret", digest: "a".repeat(64) }]), /path/u);
});

test("개인 설치 묶음에 설치·복구 안내를 포함한다", async () => {
  const builder = await readFile(new URL("./build-release.mjs", import.meta.url), "utf8");

  assert.match(builder, /local-install\.md/u);
  assert.match(builder, /README\.md/u);
});

test("release manifest를 쓰기 전에 모든 runtime entrypoint를 검증한다", async (context) => {
  assert.equal(typeof buildRelease.verifyRuntimeEntrypoints, "function");
  const root = await mkdtemp(join(tmpdir(), "massion-release-entrypoints-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const connector = "runtime/node_modules/@massion/connector/dist/main.js";

  await assert.rejects(async () => await buildRelease.verifyRuntimeEntrypoints(root, { connector }), /connector/u);
  await mkdir(join(root, "runtime/node_modules/@massion/connector/dist"), { recursive: true });
  await writeFile(join(root, connector), "#!/usr/bin/env node\n");

  await assert.doesNotReject(async () => await buildRelease.verifyRuntimeEntrypoints(root, { connector }));
});

test("현재 build host용 SurrealDB 3.2.1 binary를 override에서 release runtime으로 복사하고 metadata를 만든다", async (context) => {
  assert.equal(typeof buildRelease.stageNativeSurrealRuntime, "function");
  const root = await mkdtemp(join(tmpdir(), "massion-release-surreal-runtime-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const source = join(root, "surreal-fixture");
  await writeFile(source, "#!/bin/sh\nprintf '3.2.1 for fixture\\n'\n", { mode: 0o700 });
  await chmod(source, 0o700);

  const runtime = await buildRelease.stageNativeSurrealRuntime(root, {
    platform: "darwin",
    architecture: "arm64",
    environment: { MASSION_SURREAL_BINARY: source },
  });

  const binary = join(root, "runtime/surrealdb/3.2.1/darwin-arm64/surreal");
  assert.deepEqual(runtime, {
    version: "3.2.1",
    platform: "darwin-arm64",
    binary: "runtime/surrealdb/3.2.1/darwin-arm64/surreal",
    sha256: "816f9f8e1eb1ab7c95c4ddbbd211d8f16afae512f3767569b27de87810584403",
  });
  assert.equal(await readFile(binary, "utf8"), await readFile(source, "utf8"));
  assert.equal((await stat(binary)).mode & 0o777, 0o700);
});

test("SurrealDB binary override가 없으면 version을 URL에 고정한 공식 archive를 사용한다", () => {
  assert.equal(typeof buildRelease.nativeSurrealDownloadUrl, "function");
  assert.equal(
    buildRelease.nativeSurrealDownloadUrl("linux-amd64"),
    "https://download.surrealdb.com/v3.2.1/surreal-v3.2.1.linux-amd64.tgz",
  );
});

test("개인용 release bundle은 현재 host용 SurrealDB runtime metadata만 기록한다", () => {
  assert.equal(typeof buildRelease.createLocalReleaseBundle, "function");
  const nativeRuntime = {
    version: "3.2.1",
    platform: "darwin-arm64",
    binary: "runtime/surrealdb/3.2.1/darwin-arm64/surreal",
    sha256: "a".repeat(64),
  };
  const bundle = buildRelease.createLocalReleaseBundle({
    gitCommit: "b".repeat(40),
    sourceDigest: "c".repeat(64),
    entrypoints: { massion: "runtime/node_modules/@massion/cli/dist/main.js" },
    nativeRuntime,
  });

  assert.deepEqual(bundle, {
    schema: "massion.release-bundle.v1",
    version: "1.0.0",
    gitCommit: "b".repeat(40),
    sourceDigest: `sha256:${"c".repeat(64)}`,
    platforms: ["darwin-arm64"],
    entrypoints: { massion: "runtime/node_modules/@massion/cli/dist/main.js" },
    nativeRuntime: { surrealdb: nativeRuntime },
  });
});

test("배포 runtime의 작업공간 밖 심볼릭 링크를 제거하고 나머지 링크 경계를 검증한다", async (context) => {
  assert.equal(typeof buildRelease.removeEscapingDeploySelfReference, "function");
  assert.equal(typeof buildRelease.assertContainedSymlinks, "function");
  const root = await mkdtemp(join(tmpdir(), "massion-release-symlink-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const link = join(root, "node_modules/.pnpm/node_modules/@massion/distribution");

  await mkdir(join(root, "node_modules/.pnpm/node_modules/@massion"), { recursive: true });
  await symlink("../../../../../../../../../apps/distribution", link);

  await assert.rejects(async () => await buildRelease.assertContainedSymlinks(root), /symbolic link/u);
  await buildRelease.removeEscapingDeploySelfReference(root, "@massion/distribution");
  await assert.rejects(async () => await lstat(link), { code: "ENOENT" });
  await assert.doesNotReject(async () => await buildRelease.assertContainedSymlinks(root));
});
