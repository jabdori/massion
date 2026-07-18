import assert from "node:assert/strict";
import { test } from "node:test";

import { createReleaseManifest, verifyReleaseVersions } from "./release-manifest.mjs";

test("모든 제품 package가 release version과 정확히 일치해야 한다", () => {
  assert.doesNotThrow(() =>
    verifyReleaseVersions("1.0.0", [
      { name: "@massion/cli", version: "1.0.0" },
      { name: "@massion/server", version: "1.0.0" },
    ]),
  );
  assert.throws(() => verifyReleaseVersions("1.0.0", [{ name: "@massion/server", version: "0.0.0" }]), /version/u);
});

test("source·toolchain·artifact digest가 정렬된 release manifest를 만든다", () => {
  const manifest = createReleaseManifest({
    version: "1.0.0",
    gitCommit: "a".repeat(40),
    sourceDigest: "b".repeat(64),
    toolchains: { node: "24.18.0", bun: "1.3.14", pnpm: "10.30.3" },
    artifacts: [
      { name: "massion-local-1.0.0.tar.gz", bytes: 20, digest: "d".repeat(64) },
      { name: "massion-deploy-1.0.0.tar.gz", bytes: 10, digest: "c".repeat(64) },
    ],
  });
  assert.deepEqual(
    manifest.artifacts.map((artifact) => artifact.name),
    ["massion-deploy-1.0.0.tar.gz", "massion-local-1.0.0.tar.gz"],
  );
  assert.equal(manifest.schema, "massion.release.v1");
  assert.deepEqual(manifest.compatibility, {
    platforms: ["darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64"],
    node: { minMajor: 24 },
    bun: { minVersion: "1.3.0" },
  });
  assert.doesNotThrow(() =>
    createReleaseManifest({
      version: "1.0.0",
      gitCommit: "a".repeat(40),
      sourceDigest: "b".repeat(64),
      toolchains: { node: "24.18.0", bun: "1.3.14", pnpm: "10.30.3" },
      platforms: ["linux-amd64"],
      artifacts: [{ name: "massion-local-1.0.0.tar.gz", bytes: 1, digest: "c".repeat(64) }],
    }),
  );
  assert.throws(
    () =>
      createReleaseManifest({
        version: "1.0.0",
        gitCommit: "a".repeat(40),
        sourceDigest: "b".repeat(64),
        toolchains: { node: "24.18.0", bun: "1.3.14", pnpm: "10.30.3" },
        artifacts: [
          { name: "duplicate.tar.gz", bytes: 1, digest: "c".repeat(64) },
          { name: "duplicate.tar.gz", bytes: 1, digest: "d".repeat(64) },
        ],
      }),
    /중복/u,
  );
});
