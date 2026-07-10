import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { CORE_OFFICE_HANDLES, OrganizationGraphService } from "@massion/organization";
import { createDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";

import {
  EngineeringDeliveryRecovery,
  EngineeringDeliveryStore,
  EngineeringMetricStore,
  EngineeringPathLeaseStore,
  GitWorkspaceManager,
  SOFTWARE_ENGINEERING_TEAM_PROFILE,
  SoftwareDeliveryFinalizer,
  WorkServiceDeliveryPort,
  installSoftwareEngineeringTeam,
  validateUnifiedPatch,
  type DeliveryPrerequisiteReader,
  type EngineeringCommandEvidence,
  type WorkDeliveryPort,
} from "./index.js";

const execFileAsync = promisify(execFile);
const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;

function evidence(stage: EngineeringCommandEvidence["stage"], exitCode: number): EngineeringCommandEvidence {
  return {
    stage,
    executable: "node",
    argumentsHash: "a".repeat(64),
    cwd: ".",
    exitCode,
    stdoutHash: "b".repeat(64),
    stderrHash: "c".repeat(64),
    outputExcerpt: stage,
    durationMs: 1,
    timedOut: false,
    outputLimited: false,
    credentialRedacted: false,
  };
}

describe("remote Software Engineering delivery contract", () => {
  remoteTest(
    "SurrealDB 3.2에서 team·lease·recovery·Artifact·tenant 계보를 보존한다",
    async () => {
      const databaseName = `engineering_${crypto.randomUUID().replaceAll("-", "")}`;
      await using admin = await createDatabase({
        url: remoteUrl ?? "",
        namespace: "main",
        database: "main",
        authentication: { username: "root", password: "root" },
      });
      await admin.query(`DEFINE NAMESPACE IF NOT EXISTS massion; USE NS massion; DEFINE DATABASE ${databaseName};`);
      await using database = await createDatabase({
        url: remoteUrl ?? "",
        namespace: "massion",
        database: databaseName,
        authentication: { username: "root", password: "root" },
      });
      expect(await database.version()).toMatch(/^surrealdb-3\.2\./u);

      const identity = await IdentityService.create(database);
      const organizations = await OrganizationService.create(database);
      const owner = await identity.registerPersonalUser({
        email: "remote-engineering@example.com",
        displayName: "Owner",
      });
      const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
      const outsider = await identity.registerPersonalUser({
        email: "remote-engineering-outsider@example.com",
        displayName: "Outsider",
      });
      const otherContext = await organizations.resolveTenantContext(
        outsider.user.user_id,
        outsider.organization.organization_id,
      );
      const graph = await OrganizationGraphService.create(database, organizations);
      await graph.bootstrap(context);
      const installed = await installSoftwareEngineeringTeam(graph, context, {
        commandId: "remote-install-software-team",
        expectedVersion: 1,
      });
      expect(
        installed.nodes
          .filter((node) => node.handle.startsWith("software-engineering"))
          .map((node) => node.handle)
          .sort(),
      ).toEqual(SOFTWARE_ENGINEERING_TEAM_PROFILE.nodes.map((node) => node.handle).sort());
      expect(
        installed.nodes.filter((node) => (CORE_OFFICE_HANDLES as readonly string[]).includes(node.handle)),
      ).toSatisfy(
        (nodes: typeof installed.nodes) =>
          nodes.length === CORE_OFFICE_HANDLES.length &&
          nodes.every((node) => node.builtin && node.status === "active"),
      );
      expect(installed.nodes.filter((node) => node.handle.startsWith("software-engineering"))).toSatisfy(
        (nodes: typeof installed.nodes) =>
          nodes.length === SOFTWARE_ENGINEERING_TEAM_PROFILE.nodes.length &&
          nodes.every((node) => !node.builtin && node.scope === "persistent" && node.status === "active"),
      );
      expect(await graph.auditCompliance(context)).toEqual([]);

      const work = await WorkService.create(database, organizations, graph);
      const created = await work.createWork(context, {
        commandId: "remote-create-work",
        text: "원격 소프트웨어 전달",
        surface: "remote-contract",
        organizationVersionId: installed.version.version_id,
      });
      const planned = await work.addPlan(context, {
        commandId: "remote-add-plan",
        workId: created.work.work_id,
        expectedRevision: created.work.revision,
        content: { objective: "원격 전달을 검증한다" },
      });
      const plannedState = await work.transition(context, {
        commandId: "remote-work-planned",
        workId: created.work.work_id,
        expectedRevision: planned.work.revision,
        target: "planned",
      });
      const task = await work.addTask(context, {
        commandId: "remote-add-task",
        workId: created.work.work_id,
        expectedRevision: plannedState.work.revision,
        title: "원격 구현",
        objective: "복구 가능한 변경을 만든다",
        acceptanceCriteria: ["commit recovery"],
        dependencyIds: [],
      });
      const assigned = await work.assignTask(context, {
        commandId: "remote-assign-task",
        workId: created.work.work_id,
        expectedRevision: task.work.revision,
        taskId: task.task.task_id,
        agentHandle: "software-engineering.backend-specialist",
      });
      const ready = await work.transition(context, {
        commandId: "remote-work-ready",
        workId: created.work.work_id,
        expectedRevision: assigned.work.revision,
        target: "ready",
      });
      const running = await work.transition(context, {
        commandId: "remote-work-running",
        workId: created.work.work_id,
        expectedRevision: ready.work.revision,
        target: "running",
      });
      const runningTask = await work.transitionTask(context, {
        commandId: "remote-task-running",
        workId: created.work.work_id,
        expectedRevision: running.work.revision,
        taskId: task.task.task_id,
        expectedTaskRevision: task.task.revision,
        target: "running",
      });

      const root = await mkdtemp(join(tmpdir(), "massion-remote-engineering-"));
      const repositoryRoot = join(root, "repository");
      const workspaceRoot = join(root, "workspaces");
      await mkdir(join(repositoryRoot, "src"), { recursive: true });
      await mkdir(workspaceRoot);
      const git = async (args: readonly string[], cwd = repositoryRoot): Promise<string> =>
        (await execFileAsync("git", [...args], { cwd, encoding: "utf8" })).stdout.trim();
      try {
        await git(["init", "--initial-branch=main"]);
        await git(["config", "user.name", "Remote Test"]);
        await git(["config", "user.email", "remote@example.com"]);
        await writeFile(join(repositoryRoot, "src/value.ts"), "export const value = 1;\n");
        await git(["add", "."]);
        await git(["commit", "-m", "initial"]);
        const baseRevision = await git(["rev-parse", "HEAD"]);
        const rootRealPathHash = createHash("sha256")
          .update(await realpath(repositoryRoot))
          .digest("hex");
        const prerequisites: DeliveryPrerequisiteReader = {
          getWork: async () => ({
            organizationId: context.organizationId,
            workId: created.work.work_id,
            status: "running",
          }),
          getTask: async () => ({
            organizationId: context.organizationId,
            workId: created.work.work_id,
            taskId: task.task.task_id,
            status: "running",
          }),
          getAssignment: async () => ({
            organizationId: context.organizationId,
            workId: created.work.work_id,
            taskId: task.task.task_id,
            assignmentId: assigned.assignment.assignment_id,
            agentHandle: assigned.assignment.agent_handle,
            status: "assigned",
          }),
          getRepository: async () => ({
            organizationId: context.organizationId,
            repositoryId: "repository-remote",
            status: "active",
            rootRealPathHash,
          }),
          getRepositoryRevision: async () => ({
            organizationId: context.organizationId,
            repositoryId: "repository-remote",
            repositoryRevisionId: "revision-remote",
            providerRevision: baseRevision,
            dirty: false,
            rootRealPathHash,
          }),
        };
        const deliveries = await EngineeringDeliveryStore.create(database, organizations, prerequisites);
        const deliveryInputs = ["first", "second"].map((label) => ({
          commandId: `remote-delivery-${label}`,
          workId: created.work.work_id,
          taskId: task.task.task_id,
          assignmentId: assigned.assignment.assignment_id,
          repositoryId: "repository-remote",
          repositoryRevisionId: "revision-remote",
          baseRevision,
          agentHandle: assigned.assignment.agent_handle,
          profileVersion: SOFTWARE_ENGINEERING_TEAM_PROFILE.profileVersion,
        }));
        const deliveryPair = await Promise.all(deliveryInputs.map((input) => deliveries.start(context, input)));
        const firstDeliveryInput = deliveryInputs[0];
        if (!firstDeliveryInput) throw new Error("원격 delivery 입력이 없습니다");
        await expect(
          deliveries.start(context, { ...firstDeliveryInput, profileVersion: "conflicting-profile-version" }),
        ).rejects.toThrow("다른 delivery 명령");
        const leases = await EngineeringPathLeaseStore.create(database, organizations);
        const leaseResults = await Promise.allSettled(
          deliveryPair.map(({ delivery }, index) =>
            leases.acquire(context, {
              commandId: `remote-lease-${index}`,
              deliveryId: delivery.deliveryId,
              repositoryId: "repository-remote",
              pathPrefixes: ["src"],
              ttlMs: 60_000,
            }),
          ),
        );
        expect(leaseResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(leaseResults.filter((result) => result.status === "rejected")).toHaveLength(1);
        const winnerIndex = leaseResults.findIndex((result) => result.status === "fulfilled");
        const winner = deliveryPair[winnerIndex]?.delivery;
        if (!winner) throw new Error("원격 path lease winner가 없습니다");

        const manager = await GitWorkspaceManager.create({ workspaceRoot });
        const workspace = await manager.prepare({
          repositoryRoot,
          baseRevision,
          deliveryId: winner.deliveryId,
        });
        let current = winner;
        const testApplied = await manager.applyPatch(
          workspace,
          validateUnifiedPatch(
            `diff --git a/src/value.ts b/src/value.ts
--- a/src/value.ts
+++ b/src/value.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 99;
`,
            { allowedPaths: ["src"] },
          ),
        );
        current = (
          await deliveries.transition(context, {
            commandId: "remote-test-applied",
            deliveryId: current.deliveryId,
            expectedVersion: current.version,
            target: "test_applied",
            workspaceId: current.deliveryId,
            testPatchHash: testApplied.changeSetHash,
          })
        ).delivery;
        const redEvidenceId = (
          await deliveries.recordCommandEvidence(context, {
            deliveryId: current.deliveryId,
            evidenceKey: "red",
            evidence: evidence("red", 1),
          })
        ).commandEvidenceId;
        current = (
          await deliveries.transition(context, {
            commandId: "remote-red-verified",
            deliveryId: current.deliveryId,
            expectedVersion: current.version,
            target: "red_verified",
            redEvidenceId,
          })
        ).delivery;
        const implementationApplied = await manager.applyPatch(
          workspace,
          validateUnifiedPatch(
            `diff --git a/src/value.ts b/src/value.ts
--- a/src/value.ts
+++ b/src/value.ts
@@ -1 +1 @@
-export const value = 99;
+export const value = 2;
`,
            { allowedPaths: ["src"] },
          ),
        );
        current = (
          await deliveries.transition(context, {
            commandId: "remote-implementation-applied",
            deliveryId: current.deliveryId,
            expectedVersion: current.version,
            target: "implementation_applied",
            implementationPatchHash: implementationApplied.changeSetHash,
          })
        ).delivery;
        const greenEvidenceId = (
          await deliveries.recordCommandEvidence(context, {
            deliveryId: current.deliveryId,
            evidenceKey: "green",
            evidence: evidence("green", 0),
          })
        ).commandEvidenceId;
        current = (
          await deliveries.transition(context, {
            commandId: "remote-green-verified",
            deliveryId: current.deliveryId,
            expectedVersion: current.version,
            target: "green_verified",
            greenEvidenceId,
          })
        ).delivery;
        const commit = await manager.commit(workspace, { message: "feat: remote", expectedPaths: ["src/value.ts"] });
        const metrics = await EngineeringMetricStore.create(database, organizations);
        const recovered = await new EngineeringDeliveryRecovery(deliveries, manager, leases, metrics).recover(context, {
          commandId: "remote-recover-commit",
          deliveryId: current.deliveryId,
          repositoryRoot,
          repositoryId: "repository-remote",
        });
        expect(recovered).toMatchObject({
          result: "reconciled_commit",
          delivery: { status: "committed", commitSha: commit.commitSha },
        });

        const port = new WorkServiceDeliveryPort(work);
        const gate = { authorize: async () => ({ outcome: "allow" as const }) };
        const finalizeInput = {
          commandId: "remote-finalize",
          deliveryId: current.deliveryId,
          expectedWorkRevision: runningTask.work.revision,
          expectedTaskRevision: runningTask.task.revision,
          environment: "test",
        };
        await expect(
          new SoftwareDeliveryFinalizer(deliveries, port, gate).finalize(context, {
            ...finalizeInput,
            expectedWorkRevision: runningTask.work.revision - 1,
          }),
        ).rejects.toThrow("현재 Work revision");

        let artifactCrashInjected = false;
        const artifactCrashPort: WorkDeliveryPort = {
          getWork: port.getWork.bind(port),
          listTasks: port.listTasks.bind(port),
          transitionTask: port.transitionTask.bind(port),
          transitionWork: port.transitionWork.bind(port),
          createArtifactVersion: async (...args) => {
            const result = await port.createArtifactVersion(...args);
            if (!artifactCrashInjected) {
              artifactCrashInjected = true;
              throw new Error("injected remote artifact crash");
            }
            return result;
          },
        };
        await expect(
          new SoftwareDeliveryFinalizer(deliveries, artifactCrashPort, gate).finalize(context, finalizeInput),
        ).rejects.toThrow("injected remote artifact crash");

        let taskCrashInjected = false;
        const taskCrashPort: WorkDeliveryPort = {
          getWork: port.getWork.bind(port),
          listTasks: port.listTasks.bind(port),
          createArtifactVersion: port.createArtifactVersion.bind(port),
          transitionWork: port.transitionWork.bind(port),
          transitionTask: async (...args) => {
            const result = await port.transitionTask(...args);
            if (!taskCrashInjected) {
              taskCrashInjected = true;
              throw new Error("injected remote task crash");
            }
            return result;
          },
        };
        await expect(
          new SoftwareDeliveryFinalizer(deliveries, taskCrashPort, gate).finalize(context, finalizeInput),
        ).rejects.toThrow("injected remote task crash");

        const finalized = await new SoftwareDeliveryFinalizer(deliveries, port, gate).finalize(context, finalizeInput);
        expect(finalized).toMatchObject({ work: { status: "verifying" }, task: { status: "completed" } });
        expect(JSON.parse(finalized.artifactVersion.contentJson)).toMatchObject({
          schemaVersion: "massion.code-change-manifest.v1",
          deliveryId: current.deliveryId,
          commitSha: commit.commitSha,
        });
        const [artifactVersions] = await database.query<[unknown[]]>(
          "SELECT * FROM artifact_version WHERE organization_id = $organization_id AND work_id = $work_id;",
          { organization_id: context.organizationId, work_id: created.work.work_id },
        );
        expect(artifactVersions).toHaveLength(1);
        expect(await metrics.aggregate(context)).toContainEqual({
          name: "engineering_recovery_total",
          dimensions: { result: "reconciled_commit" },
          value: 1,
        });
        await expect(deliveries.get(otherContext, current.deliveryId)).rejects.toThrow("Delivery를 찾을 수 없습니다");
        await expect(work.getWork(otherContext, created.work.work_id)).rejects.toThrow("Work를 찾을 수 없습니다");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
