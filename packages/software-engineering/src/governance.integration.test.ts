import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { RuntimeExecutionStore } from "@massion/runtime";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import {
  EngineeringDeliveryStore,
  SoftwareDeliveryFinalizer,
  classifyDeliveryRisk,
  type DeliveryPrerequisiteReader,
  type WorkDeliveryPort,
} from "./index.js";

describe("Software delivery Governance", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let deliveries: EngineeringDeliveryStore;
  let deliveryId: string;
  let artifactCalls: number;
  let port: WorkDeliveryPort;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "risk@example.com", displayName: "Risk" });
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
        agentHandle: "software-engineering.infrastructure-specialist",
        status: "assigned",
      }),
      getRepository: async () => ({
        organizationId: context.organizationId,
        repositoryId: "repository-1",
        status: "active",
        rootRealPathHash: "a".repeat(64),
      }),
      getRepositoryRevision: async () => ({
        organizationId: context.organizationId,
        repositoryId: "repository-1",
        repositoryRevisionId: "revision-1",
        providerRevision: "a".repeat(40),
        dirty: false,
        rootRealPathHash: "a".repeat(64),
      }),
    };
    const executions = await RuntimeExecutionStore.create(database, organizations);
    deliveries = await EngineeringDeliveryStore.create(database, organizations, prerequisites);
    let delivery = (
      await deliveries.start(context, {
        commandId: "risk-delivery",
        workId: "work-1",
        taskId: "task-1",
        assignmentId: "assignment-1",
        repositoryId: "repository-1",
        repositoryRevisionId: "revision-1",
        baseRevision: "a".repeat(40),
        agentHandle: "software-engineering.infrastructure-specialist",
        profileVersion: "1.0.0",
      })
    ).delivery;
    const proposal = await executions.createExecution(context, {
      commandId: "risk-proposal",
      workId: "work-1",
      taskId: "task-1",
      agentHandle: "software-engineering.infrastructure-specialist",
      modelRoute: "software-engineering-quality",
      correlationId: delivery.deliveryId,
      estimatedTokens: 100,
      estimatedCostMicros: 0,
      input: {},
    });
    const runningProposal = await executions.transition(context, {
      commandId: "risk-proposal:running",
      executionId: proposal.execution.execution_id,
      expectedVersion: proposal.execution.version,
      target: "running",
      payload: {},
    });
    await executions.transition(context, {
      commandId: "risk-proposal:succeeded",
      executionId: proposal.execution.execution_id,
      expectedVersion: runningProposal.execution.version,
      target: "succeeded",
      payload: {
        output: {
          testPatch: "test",
          implementationPatch: "implementation",
          focusedCommand: {
            executable: "node",
            args: ["test.js"],
            cwd: ".",
            timeoutMs: 1_000,
            maxOutputBytes: 1_000,
            environment: {},
          },
          redFailureMarker: "EXPECTED_RED",
          validationCommands: [],
          commitMessage: "fix: governed",
        },
      },
    });
    delivery = (
      await deliveries.bindProposalExecution(context, {
        commandId: "risk-proposal:bind",
        deliveryId: delivery.deliveryId,
        expectedVersion: delivery.version,
        executionId: proposal.execution.execution_id,
      })
    ).delivery;
    for (const [target, extra] of [
      ["test_applied", { testPatchHash: "1".repeat(64) }],
      ["red_verified", { redEvidenceId: "red" }],
      ["implementation_applied", { implementationPatchHash: "2".repeat(64) }],
      ["green_verified", { greenEvidenceId: "green" }],
      [
        "committed",
        {
          branchRef: "refs/heads/massion/risk",
          commitSha: "b".repeat(40),
          changeSetHash: "3".repeat(64),
        },
      ],
    ] as const) {
      delivery = (
        await deliveries.transition(context, {
          commandId: `risk-${target}`,
          deliveryId: delivery.deliveryId,
          expectedVersion: delivery.version,
          target,
          ...extra,
        })
      ).delivery;
    }
    deliveryId = delivery.deliveryId;
    await deliveries.recordFileChanges(context, deliveryId, [
      {
        relativePath: "pnpm-lock.yaml",
        kind: "modified",
        beforeHash: "c".repeat(40),
        afterHash: "d".repeat(40),
        testFile: false,
      },
    ]);
    artifactCalls = 0;
    let workRevision = 10;
    let taskStatus = "running";
    let storedArtifact: NonNullable<Awaited<ReturnType<WorkDeliveryPort["findArtifactVersion"]>>>;
    port = {
      getWork: async () => ({ workId: "work-1", status: "running", revision: workRevision }),
      createArtifactVersion: async (_context, input) => {
        artifactCalls += 1;
        workRevision += 1;
        storedArtifact = {
          work: { workId: "work-1", status: "running", revision: workRevision },
          artifact: { artifactId: "artifact-1" },
          artifactVersion: {
            artifactVersionId: "artifact-version-1",
            workId: "work-1",
            mediaType: input.mediaType,
            contentJson: JSON.stringify(input.content),
            ...(input.creatorAgentHandle === undefined ? {} : { creatorAgentHandle: input.creatorAgentHandle }),
            ...(input.creatorExecutionId === undefined ? {} : { creatorExecutionId: input.creatorExecutionId }),
          },
        };
        return storedArtifact;
      },
      findArtifactVersion: async () => storedArtifact,
      transitionTask: async () => {
        taskStatus = "completed";
        workRevision += 1;
        return {
          work: { workId: "work-1", status: "running", revision: workRevision },
          task: { taskId: "task-1", status: "completed", revision: 3 },
        };
      },
      listTasks: async () => [{ taskId: "task-1", status: taskStatus, revision: 3 }],
      transitionWork: async () => {
        workRevision += 1;
        return { workId: "work-1", status: "verifying", revision: workRevision };
      },
    };
  });

  afterEach(async () => database.close());

  const input = {
    commandId: "governed-finalize",
    deliveryId: "",
    expectedWorkRevision: 10,
    expectedTaskRevision: 2,
    environment: "local",
  } as const;

  it("dependency·lockfile·migration·infrastructure path를 high risk로 분류한다", () => {
    expect(classifyDeliveryRisk(["src/value.ts"])).toBe("write");
    expect(classifyDeliveryRisk(["pnpm-lock.yaml"])).toBe("high");
    expect(classifyDeliveryRisk(["db/migrations/001.sql"])).toBe("high");
    expect(classifyDeliveryRisk([".github/workflows/release.yml"])).toBe("high");
    expect(classifyDeliveryRisk(["infrastructure/main.tf"])).toBe("high");
  });

  it("Proposal execution 계보가 없으면 Governance와 Work side effect 전에 거부한다", async () => {
    const gate = { authorize: vi.fn() };
    const unbound = {
      ...(await deliveries.get(context, deliveryId)),
      proposalExecutionId: undefined,
    };
    const finalizer = new SoftwareDeliveryFinalizer(
      {
        get: async () => unbound,
        listFileChanges: vi.fn(),
      } as never,
      port,
      gate,
    );

    await expect(finalizer.finalize(context, { ...input, deliveryId })).rejects.toThrow("committed Delivery");
    expect(gate.authorize).not.toHaveBeenCalled();
    expect(artifactCalls).toBe(0);
  });

  it("기존 Artifact manifest 전체가 현재 Delivery와 다르면 attach·Task·Work 변경 전에 거부한다", async () => {
    const delivery = await deliveries.get(context, deliveryId);
    const proposalExecutionId = delivery.proposalExecutionId;
    if (!proposalExecutionId) throw new Error("Proposal execution 계보가 없습니다");
    const gate = { authorize: vi.fn().mockResolvedValue({ outcome: "allow" }) };
    const createArtifactVersion = vi.fn(port.createArtifactVersion.bind(port));
    const transitionTask = vi.fn(port.transitionTask.bind(port));
    const transitionWork = vi.fn(port.transitionWork.bind(port));
    const stalePort: WorkDeliveryPort = {
      ...port,
      createArtifactVersion,
      transitionTask,
      transitionWork,
      findArtifactVersion: async () => ({
        work: await port.getWork(context, "work-1"),
        artifact: { artifactId: "stale-artifact" },
        artifactVersion: {
          artifactVersionId: "stale-artifact-version",
          workId: "work-1",
          mediaType: "application/vnd.massion.code-change-manifest+json",
          contentJson: JSON.stringify({
            schemaVersion: "massion.code-change-manifest.v1",
            deliveryId,
            changeSetHash: delivery.changeSetHash,
            files: [],
          }),
          creatorAgentHandle: delivery.agentHandle,
          creatorExecutionId: proposalExecutionId,
        },
      }),
    };

    await expect(
      new SoftwareDeliveryFinalizer(deliveries, stalePort, gate).finalize(context, { ...input, deliveryId }),
    ).rejects.toThrow("creator 계보");
    expect(createArtifactVersion).not.toHaveBeenCalled();
    expect(transitionTask).not.toHaveBeenCalled();
    expect(transitionWork).not.toHaveBeenCalled();
    expect(await deliveries.get(context, deliveryId)).not.toHaveProperty("artifactVersionId");
  });

  it("deny이면 Artifact·Task side effect 전에 중단한다", async () => {
    const gate = {
      authorize: vi.fn().mockRejectedValue(new Error("governance denied")),
    };
    await expect(
      new SoftwareDeliveryFinalizer(deliveries, port, gate).finalize(context, { ...input, deliveryId }),
    ).rejects.toThrow("governance denied");
    expect(artifactCalls).toBe(0);
    expect(await deliveries.get(context, deliveryId)).not.toHaveProperty("artifactVersionId");
    expect(gate.authorize).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ action: "software-delivery.finalize", riskClass: "high" }),
    );
  });

  it("approval 필요 상태는 보존하고 승인 ID 재시도만 실행한다", async () => {
    const gate = {
      authorize: vi.fn(async (_context: TenantContext, authorization: { readonly approvalId?: string }) => {
        if (!authorization.approvalId) throw new Error("approval required");
        return { outcome: "allow" };
      }),
    };
    const finalizer = new SoftwareDeliveryFinalizer(deliveries, port, gate);
    await expect(finalizer.finalize(context, { ...input, deliveryId })).rejects.toThrow("approval required");
    expect(artifactCalls).toBe(0);
    const finalized = await finalizer.finalize(context, {
      ...input,
      deliveryId,
      governanceApprovalId: "approval-1",
    });
    expect(finalized.work.status).toBe("verifying");
    expect(gate.authorize).toHaveBeenLastCalledWith(
      context,
      expect.objectContaining({ approvalId: "approval-1", riskClass: "high" }),
    );
  });
});
