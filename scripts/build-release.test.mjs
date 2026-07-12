import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
