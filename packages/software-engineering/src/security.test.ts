import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfinedCommandRunner, validateUnifiedPatch } from "./index.js";

describe("Software Engineering delivery security regression", () => {
  let root: string;
  let runner: ConfinedCommandRunner;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "massion-engineering-security-"));
    await mkdir(join(root, "src"));
    runner = await ConfinedCommandRunner.create({
      workspaceRoot: root,
      executables: { node: process.execPath },
      environmentAllowlist: [],
      maxTimeoutMs: 2_000,
      maxOutputBytes: 4_096,
      maxExcerptBytes: 1_024,
    });
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  it.each([
    [
      "traversal",
      `diff --git a/../../outside b/../../outside
--- a/../../outside
+++ b/../../outside
@@ -1 +1 @@
-old
+new
`,
      "안전한 repository 상대 경로",
    ],
    [
      "absolute",
      `diff --git a/src/value.ts b/src/value.ts
--- /etc/passwd
+++ b/src/value.ts
@@ -1 +1 @@
-old
+new
`,
      "patch header",
    ],
    [
      "git metadata",
      `diff --git a/.git/config b/.git/config
--- a/.git/config
+++ b/.git/config
@@ -1 +1 @@
-old
+new
`,
      ".git",
    ],
    [
      "symlink",
      `diff --git a/src/link b/src/link
new file mode 120000
--- /dev/null
+++ b/src/link
@@ -0,0 +1 @@
+target
`,
      "symlink",
    ],
    [
      "submodule",
      `diff --git a/src/submodule b/src/submodule
index 1111111..2222222 160000
--- a/src/submodule
+++ b/src/submodule
@@ -1 +1 @@
-Subproject commit 1111111
+Subproject commit 2222222
`,
      "submodule",
    ],
  ] as const)("%s patch를 side effect 전에 거부한다", (_name, text, error) => {
    expect(() => validateUnifiedPatch(text, { allowedPaths: ["src"] })).toThrow(error);
  });

  it("shell metacharacter를 실행하지 않고 timeout·output flood·credential을 제한한다", async () => {
    const marker = join(root, "injected");
    const metacharacter = `; touch ${marker}`;
    const injection = await runner.run({
      stage: "validation",
      executable: "node",
      args: ["-e", "process.stdout.write(process.argv[1])", metacharacter],
      cwd: ".",
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      environment: {},
    });
    expect(injection.output).toBe(metacharacter);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });

    const timedOut = await runner.run({
      stage: "red",
      executable: "node",
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: ".",
      timeoutMs: 100,
      maxOutputBytes: 1_024,
      environment: {},
    });
    expect(timedOut.evidence.timedOut).toBe(true);
    expect(timedOut.evidence.exitCode).toBeUndefined();

    const flooded = await runner.run({
      stage: "validation",
      executable: "node",
      args: ["-e", "process.stdout.write(Buffer.alloc(100000, 65)); setInterval(() => {}, 1000)"],
      cwd: ".",
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      environment: {},
    });
    expect(flooded.evidence.outputLimited).toBe(true);
    expect(Buffer.byteLength(flooded.output)).toBeLessThanOrEqual(1_024);

    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const redacted = await runner.run({
      stage: "red",
      executable: "node",
      args: ["-e", `process.stdout.write(${JSON.stringify(secret)})`],
      cwd: ".",
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      environment: {},
    });
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(redacted.evidence.credentialRedacted).toBe(true);
  }, 20_000);
});
