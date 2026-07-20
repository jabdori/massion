import type { TenantContext } from "@massion/identity";
import type { StructuredAgentRunner } from "@massion/runtime";
import type { ArtifactVersion, WorkArtifact, WorkService } from "@massion/work";

import type { ConfinedCommandInput } from "./command-runner.js";
import { EngineeringDeliveryStore } from "./delivery-store.js";

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
  readonly contentJson: string;
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
    },
  ): Promise<{
    readonly work: DeliveryWorkView;
    readonly artifact: DeliveryArtifactView;
    readonly artifactVersion: DeliveryArtifactVersionView;
  }>;
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
  return { artifactVersionId: version.artifact_version_id, contentJson: version.content_json };
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
      !delivery.greenEvidenceId
    ) {
      throw new Error("완전한 Git provenance가 있는 committed Delivery만 finalize할 수 있습니다");
    }
    const changes = await this.deliveries.listFileChanges(context, delivery.deliveryId);
    if (changes.length === 0) throw new Error("Committed Delivery의 file change manifest가 없습니다");
    const riskClass = classifyDeliveryRisk(changes.map((change) => change.relativePath));
    await this.governance.authorize(context, {
      commandId: `${input.commandId}:governance`,
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
    const artifactResult = await this.work.createArtifactVersion(context, {
      commandId: `${input.commandId}:artifact`,
      workId: delivery.workId,
      expectedRevision: input.expectedWorkRevision,
      kind: "code-change",
      name: `software-delivery:${delivery.deliveryId}`,
      mediaType: "application/vnd.massion.code-change-manifest+json",
      content: manifest,
    });
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
    const taskResult = await this.work.transitionTask(context, {
      commandId: `${input.commandId}:task-completed`,
      workId: delivery.workId,
      expectedRevision: artifactResult.work.revision,
      taskId: delivery.taskId,
      expectedTaskRevision: input.expectedTaskRevision,
      target: "completed",
    });
    const tasks = await this.work.listTasks(context, delivery.workId);
    const finalWork = tasks.every((task) => ["completed", "cancelled"].includes(task.status))
      ? await this.work.transitionWork(context, {
          commandId: `${input.commandId}:work-verifying`,
          workId: delivery.workId,
          expectedRevision: taskResult.work.revision,
          target: "verifying",
        })
      : taskResult.work;
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
  readonly allowedPaths: readonly string[];
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
  public constructor(private readonly runner: StructuredAgentRunner) {}

  public async propose(context: TenantContext, request: SoftwarePatchProposalRequest): Promise<SoftwarePatchProposal> {
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
          evidenceBriefIds: request.evidenceBriefIds,
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
    if (result.status !== "succeeded")
      throw new Error(`Software patch proposal execution이 실패했습니다: ${result.status}`);
    if (!proposal(result.output)) throw new Error("Software patch proposal 구조가 계약과 다릅니다");
    return result.output;
  }
}
