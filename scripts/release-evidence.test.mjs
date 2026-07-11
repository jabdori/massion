import assert from "node:assert/strict";
import { test } from "node:test";

import { createReleaseReceipt } from "./release-evidence.mjs";

test("source·image·SBOM digest가 연결된 release receipt만 생성한다", () => {
  const digest = "a".repeat(64);
  assert.deepEqual(
    createReleaseReceipt({
      version: "1.0.0",
      gitCommit: "b".repeat(40),
      sourceDigest: digest,
      imageId: `sha256:${"c".repeat(64)}`,
      imageDigest: `sha256:${"d".repeat(64)}`,
      sbomDigest: digest,
      sbomComponents: 709,
    }),
    {
      schema: "massion.release-evidence.v1",
      version: "1.0.0",
      gitCommit: "b".repeat(40),
      sourceDigest: `sha256:${digest}`,
      imageId: `sha256:${"c".repeat(64)}`,
      imageDigest: `sha256:${"d".repeat(64)}`,
      sbom: { format: "CycloneDX", digest: `sha256:${digest}`, components: 709 },
    },
  );
  assert.throws(
    () =>
      createReleaseReceipt({
        version: "latest",
        gitCommit: "bad",
        sourceDigest: "bad",
        imageId: "bad",
        imageDigest: "bad",
        sbomDigest: "bad",
        sbomComponents: 0,
      }),
    /유효/u,
  );
});
