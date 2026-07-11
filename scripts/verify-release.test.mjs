import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyReleaseArtifacts } from "./verify-release.mjs";

test("release manifest의 실제 artifact byte와 digest를 검증한다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "massion-release-verify-"));
  const body = globalThis.Buffer.from("release artifact");
  try {
    await writeFile(join(directory, "artifact.tar.gz"), body);
    const manifest = {
      schema: "massion.release.v1",
      version: "1.0.0",
      artifacts: [
        {
          name: "artifact.tar.gz",
          bytes: body.length,
          digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
        },
      ],
    };
    await assert.doesNotReject(verifyReleaseArtifacts(directory, manifest));
    await writeFile(join(directory, "artifact.tar.gz"), "tampered");
    await assert.rejects(verifyReleaseArtifacts(directory, manifest), /artifact/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
