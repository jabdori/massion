import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { URL } from "node:url";

import { assertCleanReleaseTree, createChecksumLines } from "./build-release.mjs";

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
