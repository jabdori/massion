import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitWorkspaceManager, validateUnifiedPatch } from "./index.js";

const execFileAsync = promisify(execFile);

describe("격리 Git delivery workspace", () => {
  let temporaryRoot: string;
  let repositoryRoot: string;
  let workspaceRoot: string;
  let baseRevision: string;
  let manager: GitWorkspaceManager;

  async function git(args: readonly string[], cwd = repositoryRoot): Promise<string> {
    const result = await execFileAsync("git", [...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return result.stdout.trim();
  }

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "massion-git-workspace-"));
    repositoryRoot = join(temporaryRoot, "repository");
    workspaceRoot = join(temporaryRoot, "workspaces");
    await mkdir(join(repositoryRoot, "src"), { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    await git(["init", "--initial-branch=main"], repositoryRoot);
    await git(["config", "user.name", "Test User"]);
    await git(["config", "user.email", "test@example.com"]);
    await writeFile(join(repositoryRoot, "src/value.js"), "export const value = 1;\n");
    await writeFile(
      join(repositoryRoot, "src/value.test.js"),
      'import { value } from "./value.js";\nif (value !== 1) throw new Error("unexpected");\n',
    );
    await git(["add", "."]);
    await git(["commit", "-m", "initial"]);
    baseRevision = await git(["rev-parse", "HEAD"]);
    manager = await GitWorkspaceManager.create({ workspaceRoot });
  });

  afterEach(async () => rm(temporaryRoot, { recursive: true, force: true }));

  it("daemon 재시작처럼 같은 관리 root를 다시 열 수 있다", async () => {
    await expect(GitWorkspaceManager.create({ workspaceRoot })).resolves.toBeInstanceOf(GitWorkspaceManager);
  });

  it("patch를 detached worktree에만 원자 적용하고 deterministic branch commit을 만든다", async () => {
    const hookMarker = join(temporaryRoot, "hook-invoked");
    for (const hook of ["post-checkout", "post-commit"]) {
      const hookPath = join(repositoryRoot, ".git/hooks", hook);
      await writeFile(hookPath, `#!/bin/sh\nprintf invoked > '${hookMarker}'\n`);
      await chmod(hookPath, 0o700);
    }
    const workspace = await manager.prepare({
      repositoryRoot,
      baseRevision,
      deliveryId: "delivery-1",
    });
    const testPatch = validateUnifiedPatch(
      `diff --git a/src/value.test.js b/src/value.test.js
--- a/src/value.test.js
+++ b/src/value.test.js
@@ -1,2 +1,2 @@
 import { value } from "./value.js";
-if (value !== 1) throw new Error("unexpected");
+if (value !== 2) throw new Error("unexpected");
`,
      { allowedPaths: ["src"] },
    );
    const implementationPatch = validateUnifiedPatch(
      `diff --git a/src/value.js b/src/value.js
--- a/src/value.js
+++ b/src/value.js
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`,
      { allowedPaths: ["src"] },
    );

    const testApplied = await manager.applyPatch(workspace, testPatch);
    const testSnapshot = await manager.inspectDeliveryWorkspace({
      repositoryRoot,
      baseRevision,
      deliveryId: workspace.deliveryId,
    });
    expect(testSnapshot).toMatchObject({
      changeSetHash: testApplied.changeSetHash,
      paths: ["src/value.test.js"],
    });
    const implementationApplied = await manager.applyPatch(workspace, implementationPatch);
    const implementationSnapshot = await manager.inspectDeliveryWorkspace({
      repositoryRoot,
      baseRevision,
      deliveryId: workspace.deliveryId,
    });
    expect(implementationSnapshot).toMatchObject({
      changeSetHash: implementationApplied.changeSetHash,
      paths: ["src/value.js", "src/value.test.js"],
    });
    const committed = await manager.commit(workspace, {
      message: "feat: delivery change",
      expectedPaths: [...testPatch.paths, ...implementationPatch.paths],
    });

    expect(committed.branchRef).toBe("refs/heads/massion/delivery-1");
    expect(committed.commitSha).toMatch(/^[a-f0-9]{40}$/u);
    expect(committed.changeSetHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(committed.fileChanges).toEqual([
      expect.objectContaining({
        relativePath: "src/value.js",
        kind: "modified",
        beforeHash: expect.stringMatching(/^[a-f0-9]{40,64}$/u),
        afterHash: expect.stringMatching(/^[a-f0-9]{40,64}$/u),
      }),
      expect.objectContaining({
        relativePath: "src/value.test.js",
        kind: "modified",
        beforeHash: expect.stringMatching(/^[a-f0-9]{40,64}$/u),
        afterHash: expect.stringMatching(/^[a-f0-9]{40,64}$/u),
      }),
    ]);
    expect(await git(["rev-parse", "HEAD"])).toBe(baseRevision);
    expect(await git(["status", "--porcelain", "--untracked-files=all"])).toBe("");
    expect(await git(["rev-parse", "refs/heads/massion/delivery-1"])).toBe(committed.commitSha);
    expect(await git(["show", "-s", "--format=%an <%ae>", committed.commitSha])).toBe(
      "Massion AgentOS <agentos@massion.local>",
    );
    expect(await readFile(join(repositoryRoot, "src/value.js"), "utf8")).toBe("export const value = 1;\n");
    await expect(readFile(hookMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await manager.remove(workspace);
    await expect(realpath(workspace.workspacePath)).rejects.toThrow();
  }, 20_000);

  it("target commit을 별도 detached 검증 workspace에 준비하고 원본을 보존한 채 강제 정리한다", async () => {
    const deliveryWorkspace = await manager.prepare({
      repositoryRoot,
      baseRevision,
      deliveryId: "verification-source",
    });
    const patch = validateUnifiedPatch(
      `diff --git a/src/value.js b/src/value.js
--- a/src/value.js
+++ b/src/value.js
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`,
      { allowedPaths: ["src"] },
    );
    await manager.applyPatch(deliveryWorkspace, patch);
    const committed = await manager.commit(deliveryWorkspace, {
      message: "feat: verification target",
      expectedPaths: patch.paths,
    });
    await manager.remove(deliveryWorkspace);

    const verificationWorkspace = await manager.prepareDetachedVerification({
      repositoryRoot,
      targetRevision: committed.commitSha,
      verificationId: "assurance-check-1",
    });

    expect(verificationWorkspace.targetRevision).toBe(committed.commitSha);
    expect(await git(["rev-parse", "HEAD"], verificationWorkspace.workspacePath)).toBe(committed.commitSha);
    expect(await git(["branch", "--show-current"], verificationWorkspace.workspacePath)).toBe("");
    expect(await readFile(join(verificationWorkspace.workspacePath, "src/value.js"), "utf8")).toBe(
      "export const value = 2;\n",
    );
    await writeFile(join(verificationWorkspace.workspacePath, "verification-output.txt"), "temporary\n");

    await manager.removeDetachedVerification(verificationWorkspace);

    await expect(realpath(verificationWorkspace.workspacePath)).rejects.toThrow();
    expect(await git(["rev-parse", "HEAD"])).toBe(baseRevision);
    expect(await git(["status", "--porcelain", "--untracked-files=all"])).toBe("");
  }, 20_000);

  it("두 section 중 하나라도 적용 불가하면 index와 worktree를 전혀 바꾸지 않는다", async () => {
    const workspace = await manager.prepare({
      repositoryRoot,
      baseRevision,
      deliveryId: "atomic-failure",
    });
    const invalid = validateUnifiedPatch(
      `diff --git a/src/value.js b/src/value.js
--- a/src/value.js
+++ b/src/value.js
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
diff --git a/src/value.test.js b/src/value.test.js
--- a/src/value.test.js
+++ b/src/value.test.js
@@ -9 +9 @@
-missing context
+replacement
`,
      { allowedPaths: ["src"] },
    );
    await expect(manager.applyPatch(workspace, invalid)).rejects.toThrow("git apply --check");
    expect(await readFile(join(workspace.workspacePath, "src/value.js"), "utf8")).toBe("export const value = 1;\n");
    expect(await git(["status", "--porcelain"], workspace.workspacePath)).toBe("");
    await manager.remove(workspace);
  });

  it("dirty root, 다른 base, branch 충돌과 workspace path 탈출을 거부한다", async () => {
    await writeFile(join(repositoryRoot, "dirty.txt"), "dirty\n");
    await expect(manager.prepare({ repositoryRoot, baseRevision, deliveryId: "dirty" })).rejects.toThrow(
      "clean Git worktree",
    );
    await rm(join(repositoryRoot, "dirty.txt"));

    await expect(
      manager.prepare({ repositoryRoot, baseRevision: "0".repeat(40), deliveryId: "wrong-base" }),
    ).rejects.toThrow("base revision");

    await git(["branch", "massion/collision", baseRevision]);
    await expect(manager.prepare({ repositoryRoot, baseRevision, deliveryId: "collision" })).rejects.toThrow(
      "branch가 이미 존재",
    );
    await expect(manager.prepare({ repositoryRoot, baseRevision, deliveryId: "../outside" })).rejects.toThrow(
      "Delivery ID",
    );

    const outside = join(temporaryRoot, "outside");
    await mkdir(outside);
    await symlink(outside, join(workspaceRoot, "escape"));
    await expect(manager.prepare({ repositoryRoot, baseRevision, deliveryId: "escape" })).rejects.toThrow(
      "workspace path",
    );
  }, 15_000);

  it("recovery branch가 base를 첫 부모로 둔 merge commit이면 거부한다", async () => {
    await git(["switch", "--create", "side"]);
    await writeFile(join(repositoryRoot, "src/side.js"), "export const side = true;\n");
    await git(["add", "src/side.js"]);
    await git(["commit", "-m", "side"]);
    await git(["switch", "main"]);
    await git(["merge", "--no-ff", "side", "-m", "merge"]);
    await git(["branch", "massion/merge-recovery", "HEAD"]);

    await expect(
      manager.inspectDeliveryBranch({ repositoryRoot, baseRevision, deliveryId: "merge-recovery" }),
    ).rejects.toThrow("single-parent");
  });

  it("기존 symlink target은 mode가 생략된 patch라도 적용 전에 거부한다", async () => {
    await symlink("value.js", join(repositoryRoot, "src/link"));
    await git(["add", "src/link"]);
    await git(["commit", "-m", "add symlink"]);
    baseRevision = await git(["rev-parse", "HEAD"]);
    const workspace = await manager.prepare({ repositoryRoot, baseRevision, deliveryId: "symlink-target" });
    const patch = validateUnifiedPatch(
      `diff --git a/src/link b/src/link
--- a/src/link
+++ b/src/link
@@ -1 +1 @@
-value.js
+other.js
`,
      { allowedPaths: ["src"] },
    );
    await expect(manager.applyPatch(workspace, patch)).rejects.toThrow("symlink");
    await manager.remove(workspace);
  });
});
