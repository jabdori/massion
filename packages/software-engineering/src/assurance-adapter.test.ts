import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AssuranceCheckBinding } from "@massion/assurance";
import { EVIDENCE_INDEX_MIGRATION } from "@massion/evidence";
import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, createDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";

import {
  DatabaseSoftwareAssuranceSourceReader,
  SoftwareAssuranceAdapter,
  type SoftwareAssuranceSource,
  type SoftwareAssuranceSourceReader,
} from "./assurance-adapter.js";
import { GitWorkspaceManager } from "./git-workspace.js";
import { validateUnifiedPatch } from "./patch.js";
import {
  SOFTWARE_ENGINEERING_DELIVERY_MIGRATION,
  SOFTWARE_ENGINEERING_COMMAND_ENVIRONMENT_MIGRATION,
  SOFTWARE_ENGINEERING_ROOT_BINDING_MIGRATION,
  SOFTWARE_ENGINEERING_TDD_EVIDENCE_MIGRATION,
} from "./schema.js";

const execFileAsync = promisify(execFile);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function environmentHash(environment: Readonly<Record<string, string>>): string {
  return sha256(
    JSON.stringify(
      Object.fromEntries(Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))),
    ),
  );
}

describe("Software Assurance adapter", { timeout: 60_000 }, () => {
  let temporaryRoot: string;
  let repositoryRoot: string;
  let deliveryWorkspaceRoot: string;
  let verificationWorkspaceRoot: string;
  let baseRevision: string;
  let source: SoftwareAssuranceSource;

  const context = {
    organizationId: "organization-1",
    userId: "user-1",
    role: "owner",
  } as TenantContext;

  function withRecipe(
    executable: string,
    args: readonly string[],
    environment: Readonly<Record<string, string>> = {},
  ): SoftwareAssuranceSource {
    return {
      ...source,
      commandEvidence: [
        {
          commandEvidenceId: "green-1",
          stage: "green",
          executable,
          argumentsHash: sha256(JSON.stringify(args)),
          environmentHash: environmentHash(environment),
          cwd: ".",
          timedOut: false,
          credentialRedacted: false,
        },
      ],
    };
  }

  async function git(args: readonly string[], cwd = repositoryRoot): Promise<string> {
    const result = await execFileAsync("git", [...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return result.stdout.trim();
  }

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "massion-assurance-adapter-"));
    repositoryRoot = join(temporaryRoot, "repository");
    deliveryWorkspaceRoot = join(temporaryRoot, "delivery-workspaces");
    verificationWorkspaceRoot = join(temporaryRoot, "verification-workspaces");
    await mkdir(join(repositoryRoot, "src"), { recursive: true });
    await mkdir(deliveryWorkspaceRoot, { recursive: true });
    await mkdir(verificationWorkspaceRoot, { recursive: true });
    await git(["init", "--initial-branch=main"], repositoryRoot);
    await git(["config", "user.name", "Test User"]);
    await git(["config", "user.email", "test@example.com"]);
    await writeFile(join(repositoryRoot, "src/value.mjs"), "export const value = 1;\n");
    await writeFile(
      join(repositoryRoot, "src/value.test.mjs"),
      'import { value } from "./value.mjs";\nif (value !== 1) throw new Error("unexpected");\n',
    );
    await git(["add", "."]);
    await git(["commit", "-m", "initial"]);
    baseRevision = await git(["rev-parse", "HEAD"]);
    const manager = await GitWorkspaceManager.create({ workspaceRoot: deliveryWorkspaceRoot });
    const workspace = await manager.prepare({
      repositoryRoot,
      baseRevision,
      deliveryId: "delivery-1",
    });
    const patch = validateUnifiedPatch(
      `diff --git a/src/value.mjs b/src/value.mjs
--- a/src/value.mjs
+++ b/src/value.mjs
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
diff --git a/src/value.test.mjs b/src/value.test.mjs
--- a/src/value.test.mjs
+++ b/src/value.test.mjs
@@ -1,2 +1,2 @@
 import { value } from "./value.mjs";
-if (value !== 1) throw new Error("unexpected");
+if (value !== 2) throw new Error("unexpected");
`,
      { allowedPaths: ["src"] },
    );
    await manager.applyPatch(workspace, patch);
    const committed = await manager.commit(workspace, {
      message: "feat: assurance target",
      expectedPaths: patch.paths,
    });
    await manager.remove(workspace);
    const manifest = {
      schemaVersion: "massion.code-change-manifest.v1",
      deliveryId: "delivery-1",
      repositoryId: "repository-1",
      repositoryRevisionId: "revision-1",
      baseRevision,
      branchRef: committed.branchRef,
      commitSha: committed.commitSha,
      changeSetHash: committed.changeSetHash,
      agentHandle: "software-implementation",
      profileVersion: "1.0.0",
      evidence: { red: "red-1", green: "green-1", validations: [] },
      files: committed.fileChanges.map((change) => ({
        relativePath: change.relativePath,
        kind: change.kind,
        ...(change.beforeHash ? { beforeHash: change.beforeHash } : {}),
        ...(change.afterHash ? { afterHash: change.afterHash } : {}),
        testFile: change.testFile,
      })),
    };
    const contentJson = JSON.stringify(manifest);
    source = {
      delivery: {
        deliveryId: "delivery-1",
        organizationId: context.organizationId,
        workId: "work-1",
        repositoryId: "repository-1",
        repositoryRevisionId: "revision-1",
        baseRevision,
        repositoryRootRealPathHash: sha256(await realpath(repositoryRoot)),
        status: "committed",
        branchRef: committed.branchRef,
        commitSha: committed.commitSha,
        changeSetHash: committed.changeSetHash,
        artifactVersionId: "artifact-version-1",
        greenEvidenceId: "green-1",
        validationEvidenceIds: [],
      },
      artifact: {
        artifactVersionId: "artifact-version-1",
        organizationId: context.organizationId,
        workId: "work-1",
        mediaType: "application/vnd.massion.code-change-manifest+json",
        contentJson,
        checksum: sha256(contentJson),
      },
      repository: {
        repositoryId: "repository-1",
        organizationId: context.organizationId,
        rootRef: repositoryRoot,
        rootRealPathHash: sha256(await realpath(repositoryRoot)),
        status: "active",
      },
      revision: {
        repositoryRevisionId: "revision-1",
        organizationId: context.organizationId,
        repositoryId: "repository-1",
        providerRevision: baseRevision,
        rootRealPathHash: sha256(await realpath(repositoryRoot)),
        dirty: false,
      },
      commandEvidence: [
        {
          commandEvidenceId: "green-1",
          stage: "green",
          executable: "node",
          argumentsHash: sha256(JSON.stringify(["--test", "src/value.test.mjs"])),
          environmentHash: environmentHash({}),
          cwd: ".",
          timedOut: false,
          credentialRedacted: false,
        },
      ],
    };
  }, 60_000);

  afterEach(async () => rm(temporaryRoot, { recursive: true, force: true }), 60_000);

  it("정본 provenance를 재검증하고 fresh target commit에서 command를 실행한 뒤 정리한다", async () => {
    const reader: SoftwareAssuranceSourceReader = {
      async read() {
        return source;
      },
    };
    const adapter = await SoftwareAssuranceAdapter.create(reader, {
      workspaceRoot: verificationWorkspaceRoot,
      executables: { node: process.execPath },
      environmentProfiles: { default: {} },
      maxTimeoutMs: 10_000,
      maxOutputBytes: 100_000,
      maxExcerptBytes: 4_000,
    });
    const binding: Extract<AssuranceCheckBinding, { kind: "test" }> = {
      bindingKey: "test:node",
      criterionKey: "task:1:0",
      kind: "test",
      executor: { kind: "system_adapter", adapterId: "massion.software-command.v1" },
      executable: "node",
      args: ["--test", "src/value.test.mjs"],
      cwd: ".",
      expectedExitCode: 0,
      timeoutMs: 5_000,
      maxOutputBytes: 50_000,
      requiredEvidenceKinds: ["command-output", "code-change"],
    };

    const result = await adapter.execute(context, {
      workId: "work-1",
      assuranceRunId: "run-1",
      criterionId: "criterion-1",
      verificationId: "run-1-test-node",
      binding,
      artifactVersionIds: ["artifact-version-1"],
    });

    expect(result).toMatchObject({
      status: "passed",
      toolName: "node",
      artifactVersionIds: ["artifact-version-1"],
    });
    expect(result.toolVersion).toMatch(/^v?\d+\./u);
    expect(result.outputHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(await readdir(verificationWorkspaceRoot)).toEqual([".disabled-hooks"]);
    expect(await git(["rev-parse", "HEAD"])).toBe(baseRevision);
    expect(await git(["status", "--porcelain", "--untracked-files=all"])).toBe("");
    expect(await readFile(join(repositoryRoot, "src/value.mjs"), "utf8")).toBe("export const value = 1;\n");
  }, 20_000);

  it("code-change checksum 변조는 failed로 판정하고 workspace를 만들지 않는다", async () => {
    const reader: SoftwareAssuranceSourceReader = {
      async read() {
        return { ...source, artifact: { ...source.artifact, checksum: "0".repeat(64) } };
      },
    };
    const adapter = await SoftwareAssuranceAdapter.create(reader, {
      workspaceRoot: verificationWorkspaceRoot,
      executables: { node: process.execPath },
      environmentProfiles: { default: {} },
      maxTimeoutMs: 10_000,
      maxOutputBytes: 100_000,
      maxExcerptBytes: 4_000,
    });
    const result = await adapter.execute(context, {
      workId: "work-1",
      assuranceRunId: "run-1",
      criterionId: "criterion-1",
      verificationId: "tampered-checksum",
      artifactVersionIds: ["artifact-version-1"],
      binding: {
        bindingKey: "test:node",
        criterionKey: "task:1:0",
        kind: "test",
        executor: { kind: "system_adapter", adapterId: "massion.software-command.v1" },
        executable: "node",
        args: ["--test", "src/value.test.mjs"],
        cwd: ".",
        expectedExitCode: 0,
        timeoutMs: 5_000,
        maxOutputBytes: 50_000,
        requiredEvidenceKinds: ["command-output", "code-change"],
      },
    });

    expect(result).toMatchObject({ status: "failed", artifactVersionIds: ["artifact-version-1"] });
    expect(await readdir(verificationWorkspaceRoot)).toEqual([".disabled-hooks"]);
  });

  it("repository I/O 불능은 provenance 불일치가 아니라 blocked로 판정한다", async () => {
    const reader: SoftwareAssuranceSourceReader = {
      async read() {
        return {
          ...source,
          repository: { ...source.repository, rootRef: join(temporaryRoot, "missing-repository") },
        };
      },
    };
    const adapter = await SoftwareAssuranceAdapter.create(reader, {
      workspaceRoot: verificationWorkspaceRoot,
      executables: { node: process.execPath },
      environmentProfiles: { default: {} },
      maxTimeoutMs: 10_000,
      maxOutputBytes: 100_000,
      maxExcerptBytes: 4_000,
    });

    const result = await adapter.execute(context, {
      workId: "work-1",
      assuranceRunId: "run-1",
      criterionId: "criterion-1",
      verificationId: "repository-unavailable",
      artifactVersionIds: ["artifact-version-1"],
      binding: {
        bindingKey: "test:repository-unavailable",
        criterionKey: "task:1:0",
        kind: "test",
        executor: { kind: "system_adapter", adapterId: "massion.software-command.v1" },
        executable: "node",
        args: ["--test", "src/value.test.mjs"],
        cwd: ".",
        expectedExitCode: 0,
        timeoutMs: 5_000,
        maxOutputBytes: 50_000,
        requiredEvidenceKinds: ["command-output", "code-change"],
      },
    });

    expect(result.status).toBe("blocked");
    expect(await readdir(verificationWorkspaceRoot)).toEqual([".disabled-hooks"]);
  });

  it("delivery command evidence와 다른 임의 binding recipe를 failed로 거부한다", async () => {
    const reader: SoftwareAssuranceSourceReader = {
      async read() {
        return source;
      },
    };
    const adapter = await SoftwareAssuranceAdapter.create(reader, {
      workspaceRoot: verificationWorkspaceRoot,
      executables: { node: process.execPath },
      environmentProfiles: { default: {} },
      maxTimeoutMs: 10_000,
      maxOutputBytes: 100_000,
      maxExcerptBytes: 4_000,
    });

    const result = await adapter.execute(context, {
      workId: "work-1",
      assuranceRunId: "run-1",
      criterionId: "criterion-1",
      verificationId: "unbound-recipe",
      artifactVersionIds: ["artifact-version-1"],
      binding: {
        bindingKey: "test:unbound",
        criterionKey: "task:1:0",
        kind: "test",
        executor: { kind: "system_adapter", adapterId: "massion.software-command.v1" },
        executable: "node",
        args: ["-e", "process.exit(0)"],
        cwd: ".",
        expectedExitCode: 0,
        timeoutMs: 5_000,
        maxOutputBytes: 50_000,
        requiredEvidenceKinds: ["command-output", "code-change"],
      },
    });

    expect(result.status).toBe("failed");
    expect(await readdir(verificationWorkspaceRoot)).toEqual([".disabled-hooks"]);
  });

  it("실행할 수 없는 command는 blocked로 판정하고 prepared workspace를 정리한다", async () => {
    const reader: SoftwareAssuranceSourceReader = {
      async read() {
        return withRecipe("missing", []);
      },
    };
    const adapter = await SoftwareAssuranceAdapter.create(reader, {
      workspaceRoot: verificationWorkspaceRoot,
      executables: { node: process.execPath },
      environmentProfiles: { default: {} },
      maxTimeoutMs: 10_000,
      maxOutputBytes: 100_000,
      maxExcerptBytes: 4_000,
    });
    const result = await adapter.execute(context, {
      workId: "work-1",
      assuranceRunId: "run-1",
      criterionId: "criterion-1",
      verificationId: "missing-command",
      artifactVersionIds: ["artifact-version-1"],
      binding: {
        bindingKey: "test:missing",
        criterionKey: "task:1:0",
        kind: "test",
        executor: { kind: "system_adapter", adapterId: "massion.software-command.v1" },
        executable: "missing",
        args: [],
        cwd: ".",
        expectedExitCode: 0,
        timeoutMs: 5_000,
        maxOutputBytes: 50_000,
        requiredEvidenceKinds: ["command-output", "code-change"],
      },
    });

    expect(result).toMatchObject({ status: "blocked", toolName: "missing" });
    expect(await readdir(verificationWorkspaceRoot)).toEqual([".disabled-hooks"]);
    expect(await git(["status", "--porcelain", "--untracked-files=all"])).toBe("");
  });

  it("검증 command가 target workspace를 변경하면 blocked로 판정하고 원본을 보존한다", async () => {
    const args = ["-e", "require('node:fs').writeFileSync('src/value.mjs', 'tampered\\n')"];
    const reader: SoftwareAssuranceSourceReader = {
      async read() {
        return withRecipe("node", args);
      },
    };
    const adapter = await SoftwareAssuranceAdapter.create(reader, {
      workspaceRoot: verificationWorkspaceRoot,
      executables: { node: process.execPath },
      environmentProfiles: { default: {} },
      maxTimeoutMs: 10_000,
      maxOutputBytes: 100_000,
      maxExcerptBytes: 4_000,
    });

    const result = await adapter.execute(context, {
      workId: "work-1",
      assuranceRunId: "run-1",
      criterionId: "criterion-1",
      verificationId: "workspace-mutation",
      artifactVersionIds: ["artifact-version-1"],
      binding: {
        bindingKey: "test:workspace-mutation",
        criterionKey: "task:1:0",
        kind: "test",
        executor: { kind: "system_adapter", adapterId: "massion.software-command.v1" },
        executable: "node",
        args,
        cwd: ".",
        expectedExitCode: 0,
        timeoutMs: 5_000,
        maxOutputBytes: 50_000,
        requiredEvidenceKinds: ["command-output", "code-change"],
      },
    });

    expect(result).toMatchObject({ status: "blocked", summary: expect.stringContaining("workspace mutation") });
    expect(await readFile(join(repositoryRoot, "src/value.mjs"), "utf8")).toBe("export const value = 1;\n");
    expect(await readdir(verificationWorkspaceRoot)).toEqual([".disabled-hooks"]);
  });

  it.each([
    {
      label: "timeout",
      args: ["-e", "setInterval(() => undefined, 1000)"],
      timeoutMs: 1_000,
      maxOutputBytes: 50_000,
      policy: { timeoutOutcome: "failed" as const },
    },
    {
      label: "output-limit",
      args: ["-e", "process.stdout.write('x'.repeat(100000))"],
      timeoutMs: 5_000,
      maxOutputBytes: 100,
      policy: { outputLimitOutcome: "failed" as const },
    },
  ])("binding이 $label 자체를 acceptance threshold로 정하면 failed로 판정한다", async (testCase) => {
    const reader: SoftwareAssuranceSourceReader = {
      async read() {
        return withRecipe("node", testCase.args);
      },
    };
    const adapter = await SoftwareAssuranceAdapter.create(reader, {
      workspaceRoot: verificationWorkspaceRoot,
      executables: { node: process.execPath },
      environmentProfiles: { default: {} },
      maxTimeoutMs: 10_000,
      maxOutputBytes: 100_000,
      maxExcerptBytes: 4_000,
    });
    const binding = {
      bindingKey: `test:${testCase.label}`,
      criterionKey: "task:1:0",
      kind: "test" as const,
      executor: { kind: "system_adapter" as const, adapterId: "massion.software-command.v1" },
      executable: "node",
      args: testCase.args,
      cwd: ".",
      expectedExitCode: 0,
      timeoutMs: testCase.timeoutMs,
      maxOutputBytes: testCase.maxOutputBytes,
      requiredEvidenceKinds: ["command-output", "code-change"],
      ...testCase.policy,
    };

    const result = await adapter.execute(context, {
      workId: "work-1",
      assuranceRunId: "run-1",
      criterionId: "criterion-1",
      verificationId: `threshold-${testCase.label}`,
      artifactVersionIds: ["artifact-version-1"],
      binding,
    });

    expect(result.status).toBe("failed");
    expect(await readdir(verificationWorkspaceRoot)).toEqual([".disabled-hooks"]);
  });

  it.each([
    {
      label: "exit-mismatch",
      args: ["-e", "process.exit(2)"],
      timeoutMs: 5_000,
      maxOutputBytes: 50_000,
      status: "failed" as const,
    },
    {
      label: "secret-output",
      args: ["-e", `process.stdout.write("api_key='supersecretvalue'")`],
      timeoutMs: 5_000,
      maxOutputBytes: 50_000,
      status: "failed" as const,
    },
    {
      label: "timeout-default",
      args: ["-e", "setInterval(() => undefined, 1000)"],
      timeoutMs: 1_000,
      maxOutputBytes: 50_000,
      status: "blocked" as const,
    },
    {
      label: "output-limit-default",
      args: ["-e", "process.stdout.write('x'.repeat(100000))"],
      timeoutMs: 5_000,
      maxOutputBytes: 100,
      status: "blocked" as const,
    },
  ])("$label command 결과를 $status로 판정하고 workspace를 정리한다", async (testCase) => {
    const reader: SoftwareAssuranceSourceReader = {
      async read() {
        return withRecipe("node", testCase.args);
      },
    };
    const adapter = await SoftwareAssuranceAdapter.create(reader, {
      workspaceRoot: verificationWorkspaceRoot,
      executables: { node: process.execPath },
      environmentProfiles: { default: {} },
      maxTimeoutMs: 10_000,
      maxOutputBytes: 100_000,
      maxExcerptBytes: 4_000,
    });
    const result = await adapter.execute(context, {
      workId: "work-1",
      assuranceRunId: "run-1",
      criterionId: "criterion-1",
      verificationId: `outcome-${testCase.label}`,
      artifactVersionIds: ["artifact-version-1"],
      binding: {
        bindingKey: `test:${testCase.label}`,
        criterionKey: "task:1:0",
        kind: "test",
        executor: { kind: "system_adapter", adapterId: "massion.software-command.v1" },
        executable: "node",
        args: testCase.args,
        cwd: ".",
        expectedExitCode: 0,
        timeoutMs: testCase.timeoutMs,
        maxOutputBytes: testCase.maxOutputBytes,
        requiredEvidenceKinds: ["command-output", "code-change"],
      },
    });

    expect(result.status).toBe(testCase.status);
    expect(result.summary).not.toContain("supersecretvalue");
    expect(await readdir(verificationWorkspaceRoot)).toEqual([".disabled-hooks"]);
  });

  it("같은 target·binding·output을 fresh workspace에서 재실행하면 동일 output hash를 만든다", async () => {
    const args = ["-e", "process.stdout.write('stable-output')"];
    const reader: SoftwareAssuranceSourceReader = {
      async read() {
        return withRecipe("node", args);
      },
    };
    const adapter = await SoftwareAssuranceAdapter.create(reader, {
      workspaceRoot: verificationWorkspaceRoot,
      executables: { node: process.execPath },
      environmentProfiles: { default: {} },
      maxTimeoutMs: 10_000,
      maxOutputBytes: 100_000,
      maxExcerptBytes: 4_000,
    });
    const binding = {
      bindingKey: "test:stable-replay",
      criterionKey: "task:1:0",
      kind: "test" as const,
      executor: { kind: "system_adapter" as const, adapterId: "massion.software-command.v1" },
      executable: "node",
      args,
      cwd: ".",
      expectedExitCode: 0,
      timeoutMs: 5_000,
      maxOutputBytes: 50_000,
      requiredEvidenceKinds: ["command-output", "code-change"],
    };
    const baseInput = {
      workId: "work-1",
      assuranceRunId: "run-1",
      criterionId: "criterion-1",
      artifactVersionIds: ["artifact-version-1"],
      binding,
    };

    const first = await adapter.execute(context, { ...baseInput, verificationId: "stable-replay-1" });
    const second = await adapter.execute(context, { ...baseInput, verificationId: "stable-replay-2" });

    expect(first.status).toBe("passed");
    expect(second.status).toBe("passed");
    expect(second.outputHash).toBe(first.outputHash);
  });

  it("deterministic output 재실행 결과가 다르면 blocked로 판정한다", async () => {
    const args = ["-e", "process.stdout.write(String(process.hrtime.bigint()))"];
    const reader: SoftwareAssuranceSourceReader = {
      async read() {
        return withRecipe("node", args);
      },
    };
    const adapter = await SoftwareAssuranceAdapter.create(reader, {
      workspaceRoot: verificationWorkspaceRoot,
      executables: { node: process.execPath },
      environmentProfiles: { default: {} },
      maxTimeoutMs: 10_000,
      maxOutputBytes: 100_000,
      maxExcerptBytes: 4_000,
    });

    const result = await adapter.execute(context, {
      workId: "work-1",
      assuranceRunId: "run-1",
      criterionId: "criterion-1",
      verificationId: "nondeterministic-output",
      artifactVersionIds: ["artifact-version-1"],
      binding: {
        bindingKey: "test:nondeterministic-output",
        criterionKey: "task:1:0",
        kind: "test",
        executor: { kind: "system_adapter", adapterId: "massion.software-command.v1" },
        executable: "node",
        args,
        cwd: ".",
        expectedExitCode: 0,
        timeoutMs: 5_000,
        maxOutputBytes: 50_000,
        verifyDeterministicOutput: true,
        requiredEvidenceKinds: ["command-output", "code-change"],
      },
    });

    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("nondeterministic");
    expect(await readdir(verificationWorkspaceRoot)).toEqual([".disabled-hooks"]);
  });

  it("binding은 값 대신 server-owned environment profile 이름만 선택한다", async () => {
    const args = ["-e", "if (process.env.MASSION_ASSURANCE_MODE !== 'ci') process.exit(3)"];
    const reader: SoftwareAssuranceSourceReader = {
      async read() {
        return withRecipe("node", args, { MASSION_ASSURANCE_MODE: "ci" });
      },
    };
    const adapter = await SoftwareAssuranceAdapter.create(reader, {
      workspaceRoot: verificationWorkspaceRoot,
      executables: { node: process.execPath },
      environmentProfiles: { default: {}, ci: { MASSION_ASSURANCE_MODE: "ci" } },
      maxTimeoutMs: 10_000,
      maxOutputBytes: 100_000,
      maxExcerptBytes: 4_000,
    });

    const result = await adapter.execute(context, {
      workId: "work-1",
      assuranceRunId: "run-1",
      criterionId: "criterion-1",
      verificationId: "environment-profile",
      artifactVersionIds: ["artifact-version-1"],
      binding: {
        bindingKey: "test:environment-profile",
        criterionKey: "task:1:0",
        kind: "test",
        executor: { kind: "system_adapter", adapterId: "massion.software-command.v1" },
        executable: "node",
        args,
        cwd: ".",
        environmentName: "ci",
        expectedExitCode: 0,
        timeoutMs: 5_000,
        maxOutputBytes: 50_000,
        requiredEvidenceKinds: ["command-output", "code-change"],
      },
    });

    expect(result.status).toBe("passed");
    expect(result.summary).toContain(environmentHash({ MASSION_ASSURANCE_MODE: "ci" }));
  });

  it("같은 profile 이름이라도 실제 environment 내용이 delivery recipe와 다르면 failed로 거부한다", async () => {
    const args = ["-e", "process.exit(0)"];
    const reader: SoftwareAssuranceSourceReader = {
      async read() {
        return withRecipe("node", args, { MASSION_ASSURANCE_MODE: "ci" });
      },
    };
    const adapter = await SoftwareAssuranceAdapter.create(reader, {
      workspaceRoot: verificationWorkspaceRoot,
      executables: { node: process.execPath },
      environmentProfiles: { default: {}, ci: { MASSION_ASSURANCE_MODE: "changed" } },
      maxTimeoutMs: 10_000,
      maxOutputBytes: 100_000,
      maxExcerptBytes: 4_000,
    });

    const result = await adapter.execute(context, {
      workId: "work-1",
      assuranceRunId: "run-1",
      criterionId: "criterion-1",
      verificationId: "environment-profile-mismatch",
      artifactVersionIds: ["artifact-version-1"],
      binding: {
        bindingKey: "test:environment-profile-mismatch",
        criterionKey: "task:1:0",
        kind: "test",
        executor: { kind: "system_adapter", adapterId: "massion.software-command.v1" },
        executable: "node",
        args,
        cwd: ".",
        environmentName: "ci",
        expectedExitCode: 0,
        timeoutMs: 5_000,
        maxOutputBytes: 50_000,
        requiredEvidenceKinds: ["command-output", "code-change"],
      },
    });

    expect(result.status).toBe("failed");
    expect(await readdir(verificationWorkspaceRoot)).toEqual([".disabled-hooks"]);
  });

  it("0044 이전 delivery command evidence에 environment hash가 없으면 실행 없이 blocked로 둔다", async () => {
    const reader: SoftwareAssuranceSourceReader = {
      async read() {
        return {
          ...source,
          commandEvidence: source.commandEvidence.map(({ environmentHash, ...evidence }) => {
            void environmentHash;
            return evidence;
          }),
        };
      },
    };
    const adapter = await SoftwareAssuranceAdapter.create(reader, {
      workspaceRoot: verificationWorkspaceRoot,
      executables: { node: process.execPath },
      environmentProfiles: { default: {} },
      maxTimeoutMs: 10_000,
      maxOutputBytes: 100_000,
      maxExcerptBytes: 4_000,
    });

    const result = await adapter.execute(context, {
      workId: "work-1",
      assuranceRunId: "run-1",
      criterionId: "criterion-1",
      verificationId: "legacy-environment-evidence",
      artifactVersionIds: ["artifact-version-1"],
      binding: {
        bindingKey: "test:legacy-environment-evidence",
        criterionKey: "task:1:0",
        kind: "test",
        executor: { kind: "system_adapter", adapterId: "massion.software-command.v1" },
        executable: "node",
        args: ["--test", "src/value.test.mjs"],
        cwd: ".",
        expectedExitCode: 0,
        timeoutMs: 5_000,
        maxOutputBytes: 50_000,
        requiredEvidenceKinds: ["command-output", "code-change"],
      },
    });

    expect(result.status).toBe("blocked");
    expect(await readdir(verificationWorkspaceRoot)).toEqual([".disabled-hooks"]);
  });

  it("DB reader는 현재 tenant의 committed delivery·Artifact·repository revision 정본만 읽는다", async () => {
    const remoteUrl = process.env.SURREAL_TEST_URL;
    const databaseName = `assurance_adapter_${crypto.randomUUID().replaceAll("-", "")}`;
    if (remoteUrl) {
      const sqlUrl = remoteUrl
        .replace(/^ws:/u, "http:")
        .replace(/^wss:/u, "https:")
        .replace(/\/rpc$/u, "/sql");
      const provisioned = await fetch(sqlUrl, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from("root:root").toString("base64")}`,
          accept: "application/json",
          "content-type": "text/plain",
        },
        body: `DEFINE NAMESPACE IF NOT EXISTS massion; USE NS massion; DEFINE DATABASE IF NOT EXISTS ${databaseName};`,
      });
      if (!provisioned.ok) throw new Error(`Software assurance remote DB provisioning 실패: ${provisioned.status}`);
    }
    await using database = await createDatabase({
      url: remoteUrl ?? "mem://",
      namespace: "massion",
      database: databaseName,
      ...(remoteUrl ? { authentication: { username: "root", password: "root" } } : {}),
    });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "reader@example.com", displayName: "Reader" });
    const other = await identity.registerPersonalUser({ email: "other@example.com", displayName: "Other" });
    const ownerContext = await organizations.resolveTenantContext(
      owner.user.user_id,
      owner.organization.organization_id,
    );
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );
    const works = await WorkService.create(database, organizations);
    const work = await works.createWork(ownerContext, {
      commandId: crypto.randomUUID(),
      text: "Software assurance reader",
      surface: "test",
      organizationVersionId: "organization-version-1",
    });
    await applyMigrations(database, [
      EVIDENCE_INDEX_MIGRATION,
      SOFTWARE_ENGINEERING_DELIVERY_MIGRATION,
      SOFTWARE_ENGINEERING_TDD_EVIDENCE_MIGRATION,
      SOFTWARE_ENGINEERING_ROOT_BINDING_MIGRATION,
      SOFTWARE_ENGINEERING_COMMAND_ENVIRONMENT_MIGRATION,
    ]);
    const bindings = {
      organization_id: ownerContext.organizationId,
      user_id: ownerContext.userId,
      work_id: work.work.work_id,
      root_ref: source.repository.rootRef,
      root_hash: source.repository.rootRealPathHash,
      base_revision: source.delivery.baseRevision,
      artifact_checksum: source.artifact.checksum,
      media_type: source.artifact.mediaType,
      content_json: source.artifact.contentJson,
      branch_ref: source.delivery.branchRef,
      commit_sha: source.delivery.commitSha,
      change_set_hash: source.delivery.changeSetHash,
    };
    await database.query(
      "CREATE evidence_repository CONTENT { repository_id: 'repository-1', organization_id: $organization_id, name: 'reader-repository', provider_kind: 'git', root_ref: $root_ref, root_real_path_hash: $root_hash, status: 'active', created_by_user_id: $user_id, created_at: time::now(), updated_at: time::now() }; CREATE repository_revision CONTENT { repository_revision_id: 'revision-1', organization_id: $organization_id, repository_id: 'repository-1', version: 1, provider_revision: $base_revision, revision: $base_revision, dirty: false, manifest_checksum: $manifest_checksum, root_real_path_hash: $root_hash, collector_version: 'git-manifest-v1', captured_by_user_id: $user_id, captured_at: time::now() };",
      { ...bindings, manifest_checksum: "a".repeat(64) },
    );
    await database.query(
      "CREATE work_artifact CONTENT { artifact_id: 'artifact-1', organization_id: $organization_id, work_id: $work_id, kind: 'code-change', name: 'software-delivery:delivery-1', created_by: $user_id, created_at: time::now() }; CREATE artifact_version CONTENT { artifact_version_id: 'artifact-version-1', artifact_id: 'artifact-1', organization_id: $organization_id, work_id: $work_id, version: 1, checksum: $artifact_checksum, media_type: $media_type, content_json: $content_json, created_by: $user_id, created_at: time::now() }; UPDATE work SET artifact_version_ids = ['artifact-version-1'] WHERE organization_id = $organization_id AND work_id = $work_id;",
      bindings,
    );
    await database.query(
      "CREATE engineering_command_evidence CONTENT { command_evidence_id: 'green-1', organization_id: $organization_id, delivery_id: 'delivery-1', stage: 'green', executable: 'node', arguments_hash: $arguments_hash, environment_hash: $environment_hash, cwd: '.', exit_code: 0, stdout_hash: $stdout_hash, stderr_hash: $stderr_hash, output_excerpt: '', duration_ms: 1, timed_out: false, credential_redacted: false, evidence_hash: $evidence_hash, created_at: time::now() }; CREATE engineering_delivery CONTENT { delivery_id: 'delivery-1', organization_id: $organization_id, work_id: $work_id, task_id: 'task-1', assignment_id: 'assignment-1', repository_id: 'repository-1', repository_revision_id: 'revision-1', base_revision: $base_revision, repository_root_real_path_hash: $root_hash, agent_handle: 'software-implementation', profile_version: '1.0.0', status: 'committed', version: 7, start_command_id: 'delivery-start', branch_ref: $branch_ref, commit_sha: $commit_sha, change_set_hash: $change_set_hash, green_evidence_id: 'green-1', validation_evidence_ids: [], artifact_version_id: 'artifact-version-1', created_by_user_id: $user_id, created_at: time::now(), updated_at: time::now() };",
      {
        ...bindings,
        arguments_hash: sha256(JSON.stringify(["--test", "src/value.test.mjs"])),
        environment_hash: environmentHash({}),
        stdout_hash: "b".repeat(64),
        stderr_hash: "c".repeat(64),
        evidence_hash: "d".repeat(64),
      },
    );
    const reader = new DatabaseSoftwareAssuranceSourceReader(database, organizations);

    const loaded = await reader.read(ownerContext, {
      workId: work.work.work_id,
      artifactVersionId: "artifact-version-1",
    });

    expect(loaded).toMatchObject({
      delivery: { deliveryId: "delivery-1", workId: work.work.work_id },
      artifact: { artifactVersionId: "artifact-version-1" },
      repository: { repositoryId: "repository-1" },
      revision: { repositoryRevisionId: "revision-1", dirty: false },
    });
    await expect(
      reader.read(otherContext, { workId: work.work.work_id, artifactVersionId: "artifact-version-1" }),
    ).rejects.toThrow("source");
  });
});
