import type { TenantContext } from "@massion/identity";
import type { RuntimeExecutionStore, StructuredAgentRunner } from "@massion/runtime";
import type { ArtifactVersion, WorkArtifact, WorkService } from "@massion/work";

import type { ConfinedCommandInput } from "./command-runner.js";
import { EngineeringDeliveryStore } from "./delivery-store.js";

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface DeliveryWorkView {
  readonly workId: string;
  readonly status: string;
  readonly revision: number;
}

export interface DeliveryTaskView {
  readonly taskId: string;
  readonly status: string;
  readonly revision: number;
}

export interface DeliveryArtifactView {
  readonly artifactId: string;
}

export interface DeliveryArtifactVersionView {
  readonly artifactVersionId: string;
  readonly workId: string;
  readonly mediaType: string;
  readonly contentJson: string;
  readonly creatorAgentHandle?: string;
  readonly creatorExecutionId?: string;
}

export interface WorkDeliveryPort {
  getWork(context: TenantContext, workId: string): Promise<DeliveryWorkView>;
  createArtifactVersion(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly workId: string;
      readonly expectedRevision: number;
      readonly kind: string;
      readonly name: string;
      readonly mediaType: string;
      readonly content: unknown;
      readonly creatorAgentHandle?: string;
      readonly creatorExecutionId?: string;
      readonly creatorTaskId?: string;
    },
  ): Promise<{
    readonly work: DeliveryWorkView;
    readonly artifact: DeliveryArtifactView;
    readonly artifactVersion: DeliveryArtifactVersionView;
  }>;
  findArtifactVersion(
    context: TenantContext,
    input: { readonly workId: string; readonly kind: string; readonly name: string },
  ): Promise<
    | {
        readonly work: DeliveryWorkView;
        readonly artifact: DeliveryArtifactView;
        readonly artifactVersion: DeliveryArtifactVersionView;
      }
    | undefined
  >;
  transitionTask(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly workId: string;
      readonly expectedRevision: number;
      readonly taskId: string;
      readonly expectedTaskRevision: number;
      readonly target: "completed";
    },
  ): Promise<{ readonly work: DeliveryWorkView; readonly task: DeliveryTaskView }>;
  listTasks(context: TenantContext, workId: string): Promise<readonly DeliveryTaskView[]>;
  transitionWork(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly workId: string;
      readonly expectedRevision: number;
      readonly target: "verifying";
    },
  ): Promise<DeliveryWorkView>;
}

function workView(work: {
  readonly work_id: string;
  readonly status: string;
  readonly revision: number;
}): DeliveryWorkView {
  return { workId: work.work_id, status: work.status, revision: work.revision };
}

function taskView(task: {
  readonly task_id: string;
  readonly status: string;
  readonly revision: number;
}): DeliveryTaskView {
  return { taskId: task.task_id, status: task.status, revision: task.revision };
}

function artifactView(artifact: WorkArtifact): DeliveryArtifactView {
  return { artifactId: artifact.artifact_id };
}

function artifactVersionView(version: ArtifactVersion): DeliveryArtifactVersionView {
  return {
    artifactVersionId: version.artifact_version_id,
    workId: version.work_id,
    mediaType: version.media_type,
    contentJson: version.content_json,
    ...(version.creator_agent_handle ? { creatorAgentHandle: version.creator_agent_handle } : {}),
    ...(version.creator_execution_id ? { creatorExecutionId: version.creator_execution_id } : {}),
  };
}

export class WorkServiceDeliveryPort implements WorkDeliveryPort {
  public constructor(private readonly work: WorkService) {}

  public async getWork(context: TenantContext, workId: string): Promise<DeliveryWorkView> {
    return workView(await this.work.getWork(context, workId));
  }

  public async createArtifactVersion(
    context: TenantContext,
    input: Parameters<WorkDeliveryPort["createArtifactVersion"]>[1],
  ): Promise<Awaited<ReturnType<WorkDeliveryPort["createArtifactVersion"]>>> {
    const result = await this.work.createArtifactVersion(context, input);
    return {
      work: workView(result.work),
      artifact: artifactView(result.artifact),
      artifactVersion: artifactVersionView(result.artifactVersion),
    };
  }

  public async findArtifactVersion(
    context: TenantContext,
    input: Parameters<WorkDeliveryPort["findArtifactVersion"]>[1],
  ): Promise<Awaited<ReturnType<WorkDeliveryPort["findArtifactVersion"]>>> {
    const result = await this.work.findArtifactVersion(context, input);
    if (!result) return undefined;
    return {
      work: workView(await this.work.getWork(context, input.workId)),
      artifact: artifactView(result.artifact),
      artifactVersion: artifactVersionView(result.artifactVersion),
    };
  }

  public async transitionTask(
    context: TenantContext,
    input: Parameters<WorkDeliveryPort["transitionTask"]>[1],
  ): Promise<Awaited<ReturnType<WorkDeliveryPort["transitionTask"]>>> {
    const result = await this.work.transitionTask(context, input);
    return { work: workView(result.work), task: taskView(result.task) };
  }

  public async listTasks(context: TenantContext, workId: string): Promise<readonly DeliveryTaskView[]> {
    return (await this.work.listTasks(context, workId)).map(taskView);
  }

  public async transitionWork(
    context: TenantContext,
    input: Parameters<WorkDeliveryPort["transitionWork"]>[1],
  ): Promise<DeliveryWorkView> {
    return workView(await this.work.transition(context, input).then((result) => result.work));
  }
}

export interface DeliveryGovernanceGate {
  authorize(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly action: string;
      readonly resource: { readonly type: string; readonly id: string };
      readonly environment: string;
      readonly riskClass: string;
      readonly external: boolean;
      readonly executionId: string;
      readonly approvalId?: string;
    },
  ): Promise<unknown>;
}

const RISKY_PATH =
  /(?:^|\/)(?:migrations?|infrastructure|infra|deploy|deployment|k8s|kubernetes|helm|terraform|\.github\/workflows)(?:\/|$)|(?:^|\/)(?:package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Dockerfile|docker-compose(?:\.[^.]+)?\.ya?ml|wrangler\.jsonc?|[^/]+\.tf)$/iu;

export function classifyDeliveryRisk(paths: readonly string[]): "write" | "high" {
  return paths.some((path) => RISKY_PATH.test(path)) ? "high" : "write";
}

export class SoftwareDeliveryFinalizer {
  public constructor(
    private readonly deliveries: EngineeringDeliveryStore,
    private readonly work: WorkDeliveryPort,
    private readonly governance: DeliveryGovernanceGate,
  ) {}

  public async finalize(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly deliveryId: string;
      readonly expectedWorkRevision: number;
      readonly expectedTaskRevision: number;
      readonly environment: string;
      readonly governanceApprovalId?: string;
    },
  ): Promise<{
    readonly work: DeliveryWorkView;
    readonly task: DeliveryTaskView;
    readonly artifact: DeliveryArtifactView;
    readonly artifactVersion: DeliveryArtifactVersionView;
  }> {
    const delivery = await this.deliveries.get(context, input.deliveryId);
    if (
      delivery.status !== "committed" ||
      !delivery.branchRef ||
      !delivery.commitSha ||
      !delivery.changeSetHash ||
      !delivery.testPatchHash ||
      !delivery.implementationPatchHash ||
      !delivery.redEvidenceId ||
      !delivery.greenEvidenceId ||
      !delivery.proposalExecutionId
    ) {
      throw new Error("완전한 Git provenance가 있는 committed Delivery만 finalize할 수 있습니다");
    }
    const changes = await this.deliveries.listFileChanges(context, delivery.deliveryId);
    if (changes.length === 0) throw new Error("Committed Delivery의 file change manifest가 없습니다");
    const riskClass = classifyDeliveryRisk(changes.map((change) => change.relativePath));
    await this.governance.authorize(context, {
      commandId: `software-delivery:${delivery.deliveryId}:governance:${input.governanceApprovalId ?? "automatic"}`,
      action: "software-delivery.finalize",
      resource: { type: "EngineeringDelivery", id: delivery.deliveryId },
      environment: input.environment,
      riskClass,
      external: false,
      executionId: `software-delivery:${delivery.deliveryId}`,
      ...(input.governanceApprovalId ? { approvalId: input.governanceApprovalId } : {}),
    });

    const manifest = {
      schemaVersion: "massion.code-change-manifest.v1",
      deliveryId: delivery.deliveryId,
      repositoryId: delivery.repositoryId,
      repositoryRevisionId: delivery.repositoryRevisionId,
      baseRevision: delivery.baseRevision,
      branchRef: delivery.branchRef,
      commitSha: delivery.commitSha,
      changeSetHash: delivery.changeSetHash,
      agentHandle: delivery.agentHandle,
      profileVersion: delivery.profileVersion,
      evidence: {
        red: delivery.redEvidenceId,
        green: delivery.greenEvidenceId,
        validations: delivery.validationEvidenceIds,
      },
      ...(delivery.assuranceRecipe ? { assuranceRecipe: delivery.assuranceRecipe } : {}),
      files: changes.map((change) => ({
        relativePath: change.relativePath,
        kind: change.kind,
        ...(change.beforeHash ? { beforeHash: change.beforeHash } : {}),
        ...(change.afterHash ? { afterHash: change.afterHash } : {}),
        testFile: change.testFile,
      })),
    };
    const artifactName = `software-delivery:${delivery.deliveryId}`;
    const mediaType = "application/vnd.massion.code-change-manifest+json";
    const existingArtifact = await this.work.findArtifactVersion(context, {
      workId: delivery.workId,
      kind: "code-change",
      name: artifactName,
    });
    if (
      delivery.artifactVersionId &&
      (!existingArtifact || existingArtifact.artifactVersion.artifactVersionId !== delivery.artifactVersionId)
    ) {
      throw new Error("Delivery에 연결된 code-change ArtifactVersion을 Work에서 찾을 수 없습니다");
    }
    if (existingArtifact) {
      if (
        existingArtifact.artifactVersion.workId !== delivery.workId ||
        existingArtifact.artifactVersion.mediaType !== mediaType ||
        existingArtifact.artifactVersion.creatorAgentHandle !== delivery.agentHandle ||
        existingArtifact.artifactVersion.creatorExecutionId !== delivery.proposalExecutionId ||
        existingArtifact.artifactVersion.contentJson !== canonicalJson(manifest)
      ) {
        throw new Error("기존 code-change ArtifactVersion의 Delivery·creator 계보가 다릅니다");
      }
    }
    const artifactResult =
      existingArtifact ??
      (await this.work.createArtifactVersion(context, {
        commandId: `${input.commandId}:artifact`,
        workId: delivery.workId,
        expectedRevision: input.expectedWorkRevision,
        kind: "code-change",
        name: artifactName,
        mediaType,
        content: manifest,
        creatorAgentHandle: delivery.agentHandle,
        creatorExecutionId: delivery.proposalExecutionId,
        creatorTaskId: delivery.taskId,
      }));
    const currentDelivery = await this.deliveries.get(context, delivery.deliveryId);
    if (
      currentDelivery.artifactVersionId &&
      currentDelivery.artifactVersionId !== artifactResult.artifactVersion.artifactVersionId
    ) {
      throw new Error("Delivery에 다른 code-change ArtifactVersion이 이미 연결됐습니다");
    }
    if (!currentDelivery.artifactVersionId) {
      await this.deliveries.attachArtifactVersion(context, {
        commandId: `${input.commandId}:delivery-artifact`,
        deliveryId: delivery.deliveryId,
        expectedVersion: currentDelivery.version,
        artifactVersionId: artifactResult.artifactVersion.artifactVersionId,
      });
    }
    let [currentWork, tasks] = await Promise.all([
      this.work.getWork(context, delivery.workId),
      this.work.listTasks(context, delivery.workId),
    ]);
    const currentTask = tasks.find((task) => task.taskId === delivery.taskId);
    if (!currentTask) throw new Error("Delivery Task를 Work에서 찾을 수 없습니다");
    let taskResult: { readonly work: DeliveryWorkView; readonly task: DeliveryTaskView };
    if (currentTask.status === "running") {
      taskResult = await this.work.transitionTask(context, {
        commandId: `${input.commandId}:task-completed`,
        workId: delivery.workId,
        expectedRevision: currentWork.revision,
        taskId: delivery.taskId,
        expectedTaskRevision: currentTask.revision,
        target: "completed",
      });
      currentWork = taskResult.work;
      tasks = await this.work.listTasks(context, delivery.workId);
    } else if (currentTask.status === "completed") {
      taskResult = { work: currentWork, task: currentTask };
    } else {
      throw new Error(`Delivery Task 상태가 finalization과 수렴할 수 없습니다: ${currentTask.status}`);
    }
    let finalWork = currentWork;
    if (tasks.every((task) => ["completed", "cancelled"].includes(task.status))) {
      if (currentWork.status === "running") {
        finalWork = await this.work.transitionWork(context, {
          commandId: `${input.commandId}:work-verifying`,
          workId: delivery.workId,
          expectedRevision: currentWork.revision,
          target: "verifying",
        });
      } else if (currentWork.status !== "verifying") {
        throw new Error(`Delivery Work 상태가 finalization과 수렴할 수 없습니다: ${currentWork.status}`);
      }
    } else if (currentWork.status !== "running") {
      throw new Error(`미완료 Task가 있는 Delivery Work 상태가 올바르지 않습니다: ${currentWork.status}`);
    }
    return {
      work: finalWork,
      task: taskResult.task,
      artifact: artifactResult.artifact,
      artifactVersion: artifactResult.artifactVersion,
    };
  }
}

type ProposalCommand = Omit<ConfinedCommandInput, "stage">;

export interface SoftwarePatchProposal {
  readonly testPatch: string;
  readonly implementationPatch: string;
  readonly focusedCommand: ProposalCommand;
  readonly redFailureMarker: string;
  readonly validationCommands: readonly ProposalCommand[];
  readonly commitMessage: string;
}

export interface SoftwareEvidenceMaterial {
  readonly evidenceBriefId: string;
  readonly indexVersionId: string;
  readonly briefChecksum: string;
  readonly snippets: readonly { readonly citation: string; readonly content: string }[];
  readonly estimatedTokens: number;
}

export interface SoftwarePatchProposalRequest {
  readonly commandId: string;
  readonly workId: string;
  readonly taskId: string;
  readonly agentHandle: string;
  readonly modelRoute: string;
  readonly correlationId: string;
  readonly estimatedTokens: number;
  readonly estimatedCostMicros: number;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly evidenceBriefIds: readonly string[];
  readonly knowledgeSources: readonly SoftwareEvidenceMaterial[];
  readonly allowedPaths: readonly string[];
}

export interface SoftwarePatchProposalResult {
  readonly executionId: string;
  readonly proposal: SoftwarePatchProposal;
}

function command(value: unknown): value is ProposalCommand {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.executable === "string" &&
    Array.isArray(item.args) &&
    item.args.every((argument) => typeof argument === "string") &&
    typeof item.cwd === "string" &&
    typeof item.timeoutMs === "number" &&
    typeof item.maxOutputBytes === "number" &&
    Boolean(item.environment) &&
    typeof item.environment === "object" &&
    !Array.isArray(item.environment)
  );
}

function proposal(value: unknown): value is SoftwarePatchProposal {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.testPatch === "string" &&
    typeof item.implementationPatch === "string" &&
    command(item.focusedCommand) &&
    typeof item.redFailureMarker === "string" &&
    Array.isArray(item.validationCommands) &&
    item.validationCommands.every(command) &&
    typeof item.commitMessage === "string"
  );
}

export class SoftwarePatchProposalService {
  public constructor(
    private readonly runner: StructuredAgentRunner,
    private readonly results?: Pick<RuntimeExecutionStore, "findResultByExecutionId">,
  ) {}

  public async propose(
    context: TenantContext,
    request: SoftwarePatchProposalRequest,
  ): Promise<SoftwarePatchProposalResult> {
    const result = await this.runner.executeStructured(
      context,
      {
        commandId: request.commandId,
        workId: request.workId,
        taskId: request.taskId,
        agentHandle: request.agentHandle,
        modelRoute: request.modelRoute,
        correlationId: request.correlationId,
        estimatedTokens: request.estimatedTokens,
        estimatedCostMicros: request.estimatedCostMicros,
        input: {
          objective: request.objective,
          acceptanceCriteria: request.acceptanceCriteria,
          ...(request.knowledgeSources.length === 0
            ? {}
            : { evidenceBriefIds: request.evidenceBriefIds, knowledgeSources: request.knowledgeSources }),
          allowedPaths: request.allowedPaths,
          instruction:
            "testPatch와 implementationPatch를 분리해 제안하고 filesystem이나 process를 직접 실행하지 마세요.",
        },
      },
      {
        name: "software_patch_proposal",
        description: "테스트 우선 Git patch와 제한 명령 제안",
        jsonSchema: {
          type: "object",
          required: [
            "testPatch",
            "implementationPatch",
            "focusedCommand",
            "redFailureMarker",
            "validationCommands",
            "commitMessage",
          ],
          additionalProperties: false,
        },
      },
    );
    if (result.status !== "succeeded") {
      throw new Error(`Software patch proposal execution이 실패했습니다: ${result.status}`, { cause: result });
    }
    if (!proposal(result.output)) throw new Error("Software patch proposal 구조가 계약과 다릅니다");
    return { executionId: result.executionId, proposal: result.output };
  }

  public async readSucceeded(context: TenantContext, executionId: string): Promise<SoftwarePatchProposalResult> {
    const result = await this.results?.findResultByExecutionId(context, executionId);
    if (!result || result.status !== "succeeded" || !proposal(result.output)) {
      throw new Error("연결된 Software patch proposal execution을 복구할 수 없습니다");
    }
    return { executionId: result.executionId, proposal: result.output };
  }
}
