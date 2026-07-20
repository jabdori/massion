import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import {
  ConfinedCommandRunner,
  EngineeringDeliveryStore,
  GitWorkspaceManager,
  TddDeliveryEngine,
  type ConfinedCommandInput,
  type ConfinedCommandResult,
  type DeliveryPrerequisiteReader,
  type EngineeringCommandRunner,
} from "./index.js";

const execFileAsync = promisify(execFile);

describe("test-first Engineering Delivery engine", { timeout: 60_000 }, () => {
  let temporaryRoot: string;
  let repositoryRoot: string;
  let workspaceRoot: string;
  let baseRevision: string;
  let database: MassionDatabase;
  let context: TenantContext;
  let deliveries: EngineeringDeliveryStore;
  let manager: GitWorkspaceManager;
  let deliveryId: string;
  let commandOrder: string[];
  let engine: TddDeliveryEngine;

  const repositoryId = "repository-1";
  const repositoryRevisionId = "repository-revision-1";
  const failureMarker = "MASSION_EXPECTED_VALUE";

  async function git(args: readonly string[], cwd = repositoryRoot): Promise<string> {
    const result = await execFileAsync("git", [...args], { cwd, encoding: "utf8" });
    return result.stdout.trim();
  }

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "massion-tdd-delivery-"));
    repositoryRoot = join(temporaryRoot, "repository");
    workspaceRoot = join(temporaryRoot, "workspaces");
    await mkdir(join(repositoryRoot, "src"), { recursive: true });
    await mkdir(workspaceRoot);
    await git(["init", "--initial-branch=main"]);
    await git(["config", "user.name", "Test User"]);
    await git(["config", "user.email", "test@example.com"]);
    await writeFile(join(repositoryRoot, "src/value.mjs"), "export const value = 1;\n");
    await writeFile(
      join(repositoryRoot, "src/value.test.mjs"),
      `import assert from "node:assert/strict";\nimport { value } from "./value.mjs";\nassert.equal(value, 1, "${failureMarker}");\n`,
    );
    await git(["add", "."]);
    await git(["commit", "-m", "initial"]);
    baseRevision = await git(["rev-parse", "HEAD"]);
    const repositoryRootRealPathHash = createHash("sha256")
      .update(await realpath(repositoryRoot))
      .digest("hex");

    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "tdd@example.com", displayName: "TDD" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const prerequisites: DeliveryPrerequisiteReader = {
      getWork: async () => ({ organizationId: context.organizationId, workId: "work-1", status: "running" }),
      getTask: async () => ({
        organizationId: context.organizationId,
        workId: "work-1",
        taskId: "task-1",
        status: "running",
      }),
      getAssignment: async () => ({
        organizationId: context.organizationId,
        workId: "work-1",
        taskId: "task-1",
        assignmentId: "assignment-1",
        agentHandle: "software-engineering.backend-specialist",
        status: "assigned",
      }),
      getRepository: async () => ({
        organizationId: context.organizationId,
        repositoryId,
        status: "active",
        rootRealPathHash: repositoryRootRealPathHash,
      }),
      getRepositoryRevision: async () => ({
        organizationId: context.organizationId,
        repositoryId,
        repositoryRevisionId,
        providerRevision: baseRevision,
        dirty: false,
        rootRealPathHash: repositoryRootRealPathHash,
      }),
    };
    deliveries = await EngineeringDeliveryStore.create(database, organizations, prerequisites);
    deliveryId = (
      await deliveries.start(context, {
        commandId: "start-delivery",
        workId: "work-1",
        taskId: "task-1",
        assignmentId: "assignment-1",
        repositoryId,
        repositoryRevisionId,
        baseRevision,
        agentHandle: "software-engineering.backend-specialist",
        profileVersion: "1.0.0",
      })
    ).delivery.deliveryId;
    manager = await GitWorkspaceManager.create({ workspaceRoot });
    commandOrder = [];
    engine = new TddDeliveryEngine(deliveries, manager, {
      create: async (root) => {
        const actual = await ConfinedCommandRunner.create({
          workspaceRoot: root,
          executables: { node: process.execPath },
          environmentAllowlist: [],
          maxTimeoutMs: 2_000,
          maxOutputBytes: 16_384,
          maxExcerptBytes: 8_192,
        });
        const tracked: EngineeringCommandRunner = {
          run: async (input: ConfinedCommandInput): Promise<ConfinedCommandResult> => {
            commandOrder.push(`${input.stage}:${input.args.join(" ")}`);
            return await actual.run(input);
          },
        };
        return tracked;
      },
    });
  });

  afterEach(async () => {
    await database.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const testPatch = `diff --git a/src/value.test.mjs b/src/value.test.mjs
--- a/src/value.test.mjs
+++ b/src/value.test.mjs
@@ -1,3 +1,3 @@
 import assert from "node:assert/strict";
 import { value } from "./value.mjs";
-assert.equal(value, 1, "MASSION_EXPECTED_VALUE");
+assert.equal(value, 2, "MASSION_EXPECTED_VALUE");
`;
  const implementationPatch = `diff --git a/src/value.mjs b/src/value.mjs
--- a/src/value.mjs
+++ b/src/value.mjs
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`;

  function input(overrides: Record<string, unknown> = {}) {
    return {
      deliveryId,
      repositoryRoot,
      testPatch,
      implementationPatch,
      allowedPaths: ["src"],
      testPaths: ["src/value.test.mjs"],
      focusedCommand: {
        executable: "node",
        args: ["src/value.test.mjs"],
        cwd: ".",
        timeoutMs: 1_000,
        maxOutputBytes: 8_192,
        environment: {},
      },
      redFailureMarker: failureMarker,
      validationCommands: [
        {
          executable: "node",
          args: ["-e", "if (1 + 1 !== 2) process.exit(1)"],
          cwd: ".",
          timeoutMs: 1_000,
          maxOutputBytes: 2_048,
          environment: {},
        },
        {
          executable: "node",
          args: ["-e", "process.stdout.write('validation-2')"],
          cwd: ".",
          timeoutMs: 1_000,
          maxOutputBytes: 2_048,
          environment: {},
        },
      ],
      commitMessage: "feat: change value with test",
      ...overrides,
    };
  }

  async function branchExists(): Promise<boolean> {
    try {
      await git(["show-ref", "--verify", `refs/heads/massion/${deliveryId}`]);
      return true;
    } catch {
      return false;
    }
  }

  it("test patch RED → implementation GREEN → validations → commit 계보를 저장한다", async () => {
    const result = await engine.execute(context, input());

    expect(result.delivery).toMatchObject({
      status: "committed",
      version: 6,
      branchRef: `refs/heads/massion/${deliveryId}`,
      commitSha: result.commit.commitSha,
      changeSetHash: result.commit.changeSetHash,
      testPatchHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      implementationPatchHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(result.delivery.validationEvidenceIds).toHaveLength(2);
    expect(result.delivery.assuranceRecipe).toEqual({
      schemaVersion: "massion.software-assurance-recipe.v1",
      focusedCommand: {
        executable: "node",
        args: ["src/value.test.mjs"],
        cwd: ".",
        timeoutMs: 1_000,
        maxOutputBytes: 8_192,
      },
      validationCommands: [
        {
          executable: "node",
          args: ["-e", "if (1 + 1 !== 2) process.exit(1)"],
          cwd: ".",
          timeoutMs: 1_000,
          maxOutputBytes: 2_048,
        },
        {
          executable: "node",
          args: ["-e", "process.stdout.write('validation-2')"],
          cwd: ".",
          timeoutMs: 1_000,
          maxOutputBytes: 2_048,
        },
      ],
    });
    expect(result.commit.fileChanges).toEqual([
      expect.objectContaining({ relativePath: "src/value.mjs", kind: "modified", testFile: false }),
      expect.objectContaining({ relativePath: "src/value.test.mjs", kind: "modified", testFile: true }),
    ]);
    expect(commandOrder.map((entry) => entry.split(":", 1)[0])).toEqual(["red", "green", "validation", "validation"]);
    expect(await branchExists()).toBe(true);
    expect(await git(["rev-parse", "HEAD"])).toBe(baseRevision);
    expect(await git(["status", "--porcelain", "--untracked-files=all"])).toBe("");
    const [evidence] = await database.query<[{ stage: string; arguments_hash: string }[]]>(
      "SELECT stage, arguments_hash FROM engineering_command_evidence WHERE organization_id = $organization_id AND delivery_id = $delivery_id;",
      { organization_id: context.organizationId, delivery_id: deliveryId },
    );
    expect(evidence).toHaveLength(4);
    expect(evidence.find((item) => item.stage === "red")?.arguments_hash).toBe(
      evidence.find((item) => item.stage === "green")?.arguments_hash,
    );
    const [changes] = await database.query<[{ relative_path: string }[]]>(
      "SELECT relative_path FROM engineering_file_change WHERE organization_id = $organization_id AND delivery_id = $delivery_id;",
      { organization_id: context.organizationId, delivery_id: deliveryId },
    );
    expect(changes).toHaveLength(2);
    const exported = await database.exportSql();
    expect(exported).not.toContain(testPatch);
    expect(exported).not.toContain(implementationPatch);
  }, 60_000);

  it("false red와 failure marker mismatch를 구분하고 commit하지 않는다", async () => {
    const passingTestPatch = testPatch.replace(
      'assert.equal(value, 2, "MASSION_EXPECTED_VALUE");',
      'assert.equal(value, 1, "CHANGED_BUT_PASSING");',
    );
    await expect(engine.execute(context, input({ testPatch: passingTestPatch }))).rejects.toThrow("false red");
    expect(await deliveries.get(context, deliveryId)).toMatchObject({
      status: "failed",
      error: { category: "false_red" },
    });
    expect(await branchExists()).toBe(false);
  });

  it("failure marker mismatch는 branch commit을 만들지 않는다", async () => {
    await expect(engine.execute(context, input({ redFailureMarker: "MISSING_MARKER" }))).rejects.toThrow(
      "failure marker",
    );
    expect(await branchExists()).toBe(false);
  });

  it("marker를 출력해도 timeout·signal 종료는 정상 RED로 인정하지 않는다", async () => {
    await expect(
      engine.execute(
        context,
        input({
          focusedCommand: {
            executable: "node",
            args: ["-e", `process.stderr.write(${JSON.stringify(failureMarker)}); setInterval(()=>{},1000)`],
            cwd: ".",
            timeoutMs: 100,
            maxOutputBytes: 8_192,
            environment: {},
          },
        }),
      ),
    ).rejects.toThrow("정상적인 test failure");
    expect(await deliveries.get(context, deliveryId)).toMatchObject({
      status: "failed",
      error: { category: "red_command_failed" },
    });
    expect(await branchExists()).toBe(false);
  });

  it("implementation의 test 재수정과 비어 있는 patch를 실행 전에 거부한다", async () => {
    const testRewritePatch = `diff --git a/src/value.test.mjs b/src/value.test.mjs
--- a/src/value.test.mjs
+++ b/src/value.test.mjs
@@ -3 +3 @@
-assert.equal(value, 2, "MASSION_EXPECTED_VALUE");
+assert.equal(value, 2, "REWRITTEN_TEST");
`;
    await expect(engine.execute(context, input({ implementationPatch: testRewritePatch }))).rejects.toThrow(
      "test file을 다시 수정",
    );
    expect(await branchExists()).toBe(false);
  });

  it("비어 있는 implementation patch를 실행 전에 거부한다", async () => {
    await expect(engine.execute(context, input({ implementationPatch: "" }))).rejects.toThrow("Patch 크기");
    expect(await deliveries.get(context, deliveryId)).toMatchObject({ status: "failed" });
    expect(await branchExists()).toBe(false);
  });

  it("GREEN 실패는 evidence를 남기되 branch commit을 만들지 않는다", async () => {
    const failingImplementation = implementationPatch.replace("value = 2", "value = 3");
    await expect(engine.execute(context, input({ implementationPatch: failingImplementation }))).rejects.toThrow(
      "GREEN",
    );
    expect(await deliveries.get(context, deliveryId)).toMatchObject({
      status: "failed",
      error: { category: "green_failed" },
    });
    expect(await branchExists()).toBe(false);
  }, 60_000);

  it("validation 실패는 committed 전이를 막는다", async () => {
    await expect(
      engine.execute(
        context,
        input({
          validationCommands: [
            {
              executable: "node",
              args: ["-e", "process.stderr.write('validation failed'); process.exit(1)"],
              cwd: ".",
              timeoutMs: 1_000,
              maxOutputBytes: 2_048,
              environment: {},
            },
          ],
        }),
      ),
    ).rejects.toThrow("Validation command");
    expect(await deliveries.get(context, deliveryId)).toMatchObject({
      status: "failed",
      error: { category: "validation_failed" },
    });
    expect(await branchExists()).toBe(false);
  }, 60_000);

  it("patch·command output credential을 감지하면 원문 저장과 commit 없이 실패한다", async () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const secretPatch = implementationPatch.replace(
      "export const value = 2;",
      `export const value = 2; export const token = "${secret}";`,
    );
    await expect(engine.execute(context, input({ implementationPatch: secretPatch }))).rejects.toThrow("credential");
    expect(JSON.stringify(await deliveries.get(context, deliveryId))).not.toContain(secret);
    expect(await database.exportSql()).not.toContain(secret);
    expect(await branchExists()).toBe(false);
  });

  it("RED command output credential을 redaction하고 commit 없이 실패한다", async () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    await expect(
      engine.execute(
        context,
        input({
          focusedCommand: {
            executable: "node",
            args: ["-e", `process.stderr.write(${JSON.stringify(`${secret} ${failureMarker}`)}); process.exit(1)`],
            cwd: ".",
            timeoutMs: 1_000,
            maxOutputBytes: 8_192,
            environment: {},
          },
        }),
      ),
    ).rejects.toThrow("output에서 credential");
    expect(await deliveries.get(context, deliveryId)).toMatchObject({
      status: "failed",
      error: { category: "credential_output" },
    });
    const [evidence] = await database.query<[{ output_excerpt: string; credential_redacted: boolean }[]]>(
      "SELECT output_excerpt, credential_redacted FROM engineering_command_evidence WHERE organization_id = $organization_id AND delivery_id = $delivery_id;",
      { organization_id: context.organizationId, delivery_id: deliveryId },
    );
    expect(evidence).toEqual([expect.objectContaining({ credential_redacted: true })]);
    expect(JSON.stringify(evidence)).not.toContain(secret);
    expect(await database.exportSql()).not.toContain(secret);
    expect(await branchExists()).toBe(false);
  });
});
