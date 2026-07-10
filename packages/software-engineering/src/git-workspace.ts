import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { ValidatedUnifiedPatch } from "./patch.js";

const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;

interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitDeliveryWorkspace {
  readonly repositoryRoot: string;
  readonly workspacePath: string;
  readonly workspaceRoot: string;
  readonly baseRevision: string;
  readonly deliveryId: string;
  readonly branchRef: string;
}

export interface GitFileChange {
  readonly relativePath: string;
  readonly previousPath?: string;
  readonly kind: "added" | "modified" | "deleted" | "renamed";
  readonly beforeHash?: string;
  readonly afterHash?: string;
  readonly testFile: boolean;
}

export interface GitCommitResult {
  readonly branchRef: string;
  readonly commitSha: string;
  readonly changeSetHash: string;
  readonly fileChanges: readonly GitFileChange[];
}

function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function sanitizedEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    ...extra,
  };
}

async function runGit(
  cwd: string,
  args: readonly string[],
  options: {
    readonly input?: string;
    readonly allowFailure?: boolean;
    readonly label?: string;
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
): Promise<GitResult> {
  return await new Promise<GitResult>((resolvePromise, reject) => {
    const child = spawn("git", [...args], {
      cwd,
      env: sanitizedEnvironment(options.environment),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let exceeded = false;
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
        exceeded = true;
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (exceeded) {
        reject(new Error(`${options.label ?? "git"} output이 4 MiB 제한을 초과했습니다`));
        return;
      }
      const result = {
        exitCode: code ?? (signal ? 128 : 1),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (result.exitCode !== 0 && !options.allowFailure) {
        const detail = result.stderr.trim().slice(0, 2_000);
        reject(new Error(`${options.label ?? `git ${args[0] ?? "command"}`} 실패${detail ? `: ${detail}` : ""}`));
        return;
      }
      resolvePromise(result);
    });
    child.stdin.end(options.input);
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isTestPath(path: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/u.test(path) || /\.(?:test|spec)\.[^/]+$/u.test(path);
}

export class GitWorkspaceManager {
  private constructor(
    private readonly workspaceRoot: string,
    private readonly disabledHooksPath: string,
  ) {}

  public static async create(input: { readonly workspaceRoot: string }): Promise<GitWorkspaceManager> {
    await mkdir(input.workspaceRoot, { recursive: true, mode: 0o700 });
    const workspaceRoot = await realpath(input.workspaceRoot);
    const disabledHooksPath = resolve(workspaceRoot, ".disabled-hooks");
    await mkdir(disabledHooksPath, { mode: 0o700 });
    return new GitWorkspaceManager(workspaceRoot, await realpath(disabledHooksPath));
  }

  public async prepare(input: {
    readonly repositoryRoot: string;
    readonly baseRevision: string;
    readonly deliveryId: string;
  }): Promise<GitDeliveryWorkspace> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.deliveryId) || [".", ".."].includes(input.deliveryId)) {
      throw new Error("Delivery ID는 안전한 branch와 directory 식별자여야 합니다");
    }
    if (!/^[a-f0-9]{40,64}$/u.test(input.baseRevision)) throw new Error("Git base revision 형식이 잘못되었습니다");
    const repositoryRoot = await realpath(input.repositoryRoot);
    const topLevel = (await runGit(repositoryRoot, ["rev-parse", "--show-toplevel"])).stdout.trim();
    if ((await realpath(topLevel)) !== repositoryRoot) throw new Error("등록 경로가 Git repository root가 아닙니다");
    if (within(repositoryRoot, this.workspaceRoot) || within(this.workspaceRoot, repositoryRoot)) {
      throw new Error("Workspace root와 repository root는 서로 분리되어야 합니다");
    }
    const status = (await runGit(repositoryRoot, ["status", "--porcelain", "--untracked-files=all"])).stdout.trim();
    if (status) throw new Error("Delivery base는 clean Git worktree여야 합니다");
    const head = (await runGit(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
    if (head !== input.baseRevision) throw new Error("현재 HEAD가 요청한 base revision과 다릅니다");

    const branchRef = `refs/heads/massion/${input.deliveryId}`;
    const branchCheck = await runGit(repositoryRoot, ["show-ref", "--verify", "--quiet", branchRef], {
      allowFailure: true,
    });
    if (branchCheck.exitCode === 0) throw new Error(`Delivery branch가 이미 존재합니다: ${branchRef}`);
    if (branchCheck.exitCode !== 1) throw new Error("Delivery branch 존재 여부를 확인하지 못했습니다");

    const workspacePath = resolve(this.workspaceRoot, input.deliveryId);
    if (!within(this.workspaceRoot, workspacePath) || (await exists(workspacePath))) {
      throw new Error("Delivery workspace path가 이미 존재하거나 관리 root 밖입니다");
    }
    try {
      await runGit(
        repositoryRoot,
        [
          "-c",
          `core.hooksPath=${this.disabledHooksPath}`,
          "worktree",
          "add",
          "--detach",
          workspacePath,
          input.baseRevision,
        ],
        { label: "git worktree add" },
      );
      const actualWorkspace = await realpath(workspacePath);
      if (!within(this.workspaceRoot, actualWorkspace))
        throw new Error("생성된 workspace realpath가 관리 root 밖입니다");
      const workspaceHead = (await runGit(actualWorkspace, ["rev-parse", "HEAD"])).stdout.trim();
      if (workspaceHead !== input.baseRevision) throw new Error("생성된 workspace HEAD가 base revision과 다릅니다");
      return Object.freeze({
        repositoryRoot,
        workspacePath: actualWorkspace,
        workspaceRoot: this.workspaceRoot,
        baseRevision: input.baseRevision,
        deliveryId: input.deliveryId,
        branchRef,
      });
    } catch (error) {
      await runGit(repositoryRoot, ["worktree", "remove", "--force", workspacePath], {
        allowFailure: true,
      }).catch(() => undefined);
      throw error;
    }
  }

  public async applyPatch(
    workspace: GitDeliveryWorkspace,
    patch: ValidatedUnifiedPatch,
  ): Promise<{ readonly patchHash: string; readonly paths: readonly string[] }> {
    await this.verifyWorkspace(workspace);
    if (!patch.validated || createHash("sha256").update(patch.text).digest("hex") !== patch.sha256) {
      throw new Error("검증된 patch provenance가 일치하지 않습니다");
    }
    await this.verifyPatchTargets(workspace, patch.paths);
    const previouslyStaged = new Set(
      (await runGit(workspace.workspacePath, ["diff", "--cached", "--name-only", "-z"])).stdout
        .split("\0")
        .filter(Boolean),
    );
    await runGit(workspace.workspacePath, ["apply", "--check", "--index", "--whitespace=error-all", "-"], {
      input: patch.text,
      label: "git apply --check",
    });
    await runGit(workspace.workspacePath, ["apply", "--index", "--whitespace=error-all", "-"], {
      input: patch.text,
      label: "git apply",
    });
    const staged = (await runGit(workspace.workspacePath, ["diff", "--cached", "--name-only", "-z"])).stdout
      .split("\0")
      .filter(Boolean);
    if (staged.some((path) => !previouslyStaged.has(path) && !patch.paths.includes(path))) {
      throw new Error("Patch parser와 Git staged path가 일치하지 않습니다");
    }
    return { patchHash: patch.sha256, paths: patch.paths };
  }

  public async commit(workspace: GitDeliveryWorkspace, input: { readonly message: string }): Promise<GitCommitResult> {
    await this.verifyWorkspace(workspace);
    if (!input.message.trim() || input.message.includes("\0")) throw new Error("Git commit message가 필요합니다");
    const diff = await runGit(workspace.workspacePath, ["diff", "--cached", "--quiet"], { allowFailure: true });
    if (diff.exitCode === 0) throw new Error("Commit할 staged change가 없습니다");
    if (diff.exitCode !== 1) throw new Error("Staged change 상태를 확인하지 못했습니다");
    const branchName = workspace.branchRef.slice("refs/heads/".length);
    const branchCheck = await runGit(
      workspace.repositoryRoot,
      ["show-ref", "--verify", "--quiet", workspace.branchRef],
      { allowFailure: true },
    );
    if (branchCheck.exitCode === 0) throw new Error(`Delivery branch가 이미 존재합니다: ${workspace.branchRef}`);
    await runGit(
      workspace.workspacePath,
      ["-c", `core.hooksPath=${this.disabledHooksPath}`, "switch", "--create", branchName],
      { label: "git switch --create" },
    );
    await runGit(
      workspace.workspacePath,
      [
        "-c",
        `core.hooksPath=${this.disabledHooksPath}`,
        "commit",
        "--no-verify",
        "--no-gpg-sign",
        "-m",
        input.message.trim(),
      ],
      {
        label: "git commit",
        environment: {
          GIT_AUTHOR_NAME: "Massion AgentOS",
          GIT_AUTHOR_EMAIL: "agentos@massion.local",
          GIT_COMMITTER_NAME: "Massion AgentOS",
          GIT_COMMITTER_EMAIL: "agentos@massion.local",
        },
      },
    );
    const commitSha = (await runGit(workspace.workspacePath, ["rev-parse", "HEAD"])).stdout.trim();
    const fileChanges = await this.fileChanges(workspace, commitSha);
    const changeSet = (
      await runGit(workspace.workspacePath, [
        "diff",
        "--full-index",
        "--no-ext-diff",
        "--binary",
        workspace.baseRevision,
        commitSha,
      ])
    ).stdout;
    await this.verifyOriginalUnchanged(workspace);
    return {
      branchRef: workspace.branchRef,
      commitSha,
      changeSetHash: createHash("sha256").update(changeSet).digest("hex"),
      fileChanges,
    };
  }

  public async remove(workspace: GitDeliveryWorkspace): Promise<void> {
    if (!within(this.workspaceRoot, workspace.workspacePath))
      throw new Error("Workspace 제거 경로가 관리 root 밖입니다");
    await runGit(workspace.repositoryRoot, ["worktree", "remove", "--force", workspace.workspacePath], {
      allowFailure: !(await exists(workspace.workspacePath)),
      label: "git worktree remove",
    });
    await runGit(workspace.repositoryRoot, ["worktree", "prune"]);
  }

  private async verifyWorkspace(workspace: GitDeliveryWorkspace): Promise<void> {
    if (workspace.workspaceRoot !== this.workspaceRoot || !within(this.workspaceRoot, workspace.workspacePath)) {
      throw new Error("Workspace가 이 manager의 관리 root 밖입니다");
    }
    const actual = await realpath(workspace.workspacePath);
    if (actual !== workspace.workspacePath || !within(this.workspaceRoot, actual)) {
      throw new Error("Workspace realpath가 준비된 경로와 다릅니다");
    }
    const head = (await runGit(actual, ["rev-parse", "HEAD"])).stdout.trim();
    if (head !== workspace.baseRevision) {
      const branchCommit = await runGit(actual, ["rev-parse", "--verify", workspace.branchRef], {
        allowFailure: true,
      });
      if (branchCommit.exitCode !== 0 || branchCommit.stdout.trim() !== head) {
        throw new Error("Workspace HEAD가 base 또는 delivery branch와 일치하지 않습니다");
      }
    }
  }

  private async verifyPatchTargets(workspace: GitDeliveryWorkspace, paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      let cursor = workspace.workspacePath;
      for (const segment of path.split("/")) {
        cursor = resolve(cursor, segment);
        if (!within(workspace.workspacePath, cursor)) throw new Error("Patch target이 workspace 밖입니다");
        if (await exists(cursor)) {
          const stat = await lstat(cursor);
          if (stat.isSymbolicLink()) throw new Error(`Patch target 또는 parent가 symlink입니다: ${path}`);
        } else {
          const parent = await realpath(dirname(cursor));
          if (!within(workspace.workspacePath, parent))
            throw new Error("Patch target parent realpath가 workspace 밖입니다");
          break;
        }
      }
      const staged = (await runGit(workspace.workspacePath, ["ls-files", "--stage", "--", path])).stdout.trim();
      if (staged.startsWith("120000 ")) throw new Error(`Patch target이 symlink입니다: ${path}`);
      if (staged.startsWith("160000 ")) throw new Error(`Patch target이 submodule입니다: ${path}`);
    }
  }

  private async verifyOriginalUnchanged(workspace: GitDeliveryWorkspace): Promise<void> {
    const head = (await runGit(workspace.repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
    const status = (
      await runGit(workspace.repositoryRoot, ["status", "--porcelain", "--untracked-files=all"])
    ).stdout.trim();
    if (head !== workspace.baseRevision || status) {
      throw new Error("원본 Git worktree가 delivery 실행 중 변경되었습니다");
    }
  }

  private async blobHash(workspace: GitDeliveryWorkspace, revision: string, path: string): Promise<string | undefined> {
    const result = await runGit(workspace.workspacePath, ["ls-tree", "-z", revision, "--", path]);
    const match = result.stdout.match(/^[0-7]{6} (?:blob|commit) ([a-f0-9]{40,64})\t/u);
    return match?.[1];
  }

  private async fileChanges(workspace: GitDeliveryWorkspace, commitSha: string): Promise<GitFileChange[]> {
    const fields = (
      await runGit(workspace.workspacePath, ["diff", "--name-status", "-z", workspace.baseRevision, commitSha])
    ).stdout
      .split("\0")
      .filter(Boolean);
    const changes: GitFileChange[] = [];
    for (let index = 0; index < fields.length;) {
      const status = fields[index++];
      if (!status) break;
      const code = status[0];
      const beforePath = fields[index++];
      if (!beforePath) throw new Error("Git name-status 결과가 불완전합니다");
      if (code === "R") {
        const afterPath = fields[index++];
        if (!afterPath) throw new Error("Git rename 결과가 불완전합니다");
        changes.push({
          relativePath: afterPath,
          previousPath: beforePath,
          kind: "renamed",
          ...(await this.optionalHashes(workspace, beforePath, afterPath, commitSha)),
          testFile: isTestPath(afterPath),
        });
        continue;
      }
      if (!["A", "M", "D"].includes(code ?? "")) throw new Error(`지원하지 않는 Git change kind입니다: ${status}`);
      const kind = code === "A" ? "added" : code === "D" ? "deleted" : "modified";
      changes.push({
        relativePath: beforePath,
        kind,
        ...(await this.optionalHashes(workspace, beforePath, beforePath, commitSha)),
        testFile: isTestPath(beforePath),
      });
    }
    return changes.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  private async optionalHashes(
    workspace: GitDeliveryWorkspace,
    beforePath: string,
    afterPath: string,
    commitSha: string,
  ): Promise<{ readonly beforeHash?: string; readonly afterHash?: string }> {
    const [beforeHash, afterHash] = await Promise.all([
      this.blobHash(workspace, workspace.baseRevision, beforePath),
      this.blobHash(workspace, commitSha, afterPath),
    ]);
    return {
      ...(beforeHash ? { beforeHash } : {}),
      ...(afterHash ? { afterHash } : {}),
    };
  }
}
