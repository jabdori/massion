import { GovernanceApprovalRequiredError } from "@massion/governance";
import type { TenantContext } from "@massion/identity";
import type {
  EngineeringDelivery,
  EngineeringDeliveryCoordinator,
  EngineeringDeliveryRecovery,
  EngineeringDeliveryStore,
  SoftwareDeliveryFinalizer,
  SoftwarePatchProposalService,
  TddDeliveryEngine,
} from "@massion/software-engineering";
import type { WorkService, WorkTask } from "@massion/work";

import type { CoreSoftwareTaskPort } from "./core-delivery-stage.js";

const APPLICATION_RUN_CANCELLED = "Application run cancelled";

interface SoftwareDeliveryConfiguration {
  readonly repositoryRoot: string;
  readonly repositoryId: string;
  readonly repositoryRevisionId: string;
  readonly baseRevision: string;
  readonly profileVersion: string;
  readonly allowedPaths: readonly string[];
  readonly testPaths: readonly string[];
  readonly evidenceBriefIds: readonly string[];
  readonly environment: string;
  readonly leaseTtlMs: number;
}

function strings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} 목록이 유효하지 않습니다`);
  }
  const result: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "string" || item.length === 0) throw new Error(`${label} 목록이 유효하지 않습니다`);
    result.push(item);
  }
  return result;
}

function configuration(request: unknown): SoftwareDeliveryConfiguration | undefined {
  const value =
    request && typeof request === "object" ? (request as { softwareDelivery?: unknown }).softwareDelivery : undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const required = ["repositoryRoot", "repositoryId", "repositoryRevisionId", "baseRevision", "profileVersion"];
  if (!required.every((key) => typeof record[key] === "string" && record[key].length > 0)) return undefined;
  const leaseTtlMs = record.leaseTtlMs === undefined ? 300_000 : Number(record.leaseTtlMs);
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1_000 || leaseTtlMs > 3_600_000) {
    throw new Error("Software Delivery lease 시간이 유효하지 않습니다");
  }
  return {
    repositoryRoot: record.repositoryRoot as string,
    repositoryId: record.repositoryId as string,
    repositoryRevisionId: record.repositoryRevisionId as string,
    baseRevision: record.baseRevision as string,
    profileVersion: record.profileVersion as string,
    allowedPaths: strings(record.allowedPaths, "Software Delivery allowed path"),
    testPaths: strings(record.testPaths, "Software Delivery test path"),
    evidenceBriefIds:
      record.evidenceBriefIds === undefined ? [] : strings(record.evidenceBriefIds, "Evidence Brief ID"),
    environment: typeof record.environment === "string" && record.environment ? record.environment : "local",
    leaseTtlMs,
  };
}

function approvalId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const id = (value as { approvalId?: unknown }).approvalId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function criteria(task: WorkTask): readonly string[] {
  const value = JSON.parse(task.acceptance_criteria_json) as unknown;
  if (!Array.isArray(value)) throw new Error("Software Task acceptance criteria가 배열이 아닙니다");
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object" && typeof (item as { statement?: unknown }).statement === "string") {
      return (item as { statement: string }).statement;
    }
    throw new Error("Software Task acceptance criterion이 유효하지 않습니다");
  });
}

export class CoreSoftwareTaskAdapter implements CoreSoftwareTaskPort {
  private readonly activeCommands = new Set<string>();
  private readonly cancellationRequested = new Set<string>();

  public constructor(
    private readonly dependencies: {
      readonly works: Pick<WorkService, "getWork" | "listTasks" | "assignTask"> &
        Partial<Pick<WorkService, "listAssignments">>;
      readonly deliveries: Pick<EngineeringDeliveryStore, "findByStartCommand" | "get" | "transition">;
      readonly coordinator: Pick<EngineeringDeliveryCoordinator, "start">;
      readonly proposals: Pick<SoftwarePatchProposalService, "propose">;
      readonly engine: Pick<TddDeliveryEngine, "execute">;
      readonly finalizer: Pick<SoftwareDeliveryFinalizer, "finalize">;
      readonly recovery: Pick<EngineeringDeliveryRecovery, "recover">;
    },
  ) {}

  public async executeTask(
    context: TenantContext,
    input: Parameters<CoreSoftwareTaskPort["executeTask"]>[1],
  ): ReturnType<CoreSoftwareTaskPort["executeTask"]> {
    this.activeCommands.add(input.commandId);
    try {
      const config = configuration(input.request);
      if (!config) return { outcome: "blocked", reason: "software-delivery-configuration-required" };
      const agentHandle = input.task.recommended_agent_handles?.[0];
      if (!agentHandle) return { outcome: "blocked", reason: "software-delivery-agent-required" };
      await this.throwIfCancelled(context, input, config);
      const startCommand = `${input.commandId}:engineering`;
      let delivery = await this.dependencies.deliveries.findByStartCommand(context, startCommand);
      await this.throwIfCancelled(context, input, config);
      if (!delivery) {
        const current = await this.dependencies.works.getWork(context, input.workId);
        await this.throwIfCancelled(context, input, config);
        const existingAssignment = this.dependencies.works.listAssignments
          ? (await this.dependencies.works.listAssignments(context, input.workId)).find(
              (candidate) =>
                candidate.task_id === input.task.task_id &&
                candidate.agent_handle === agentHandle &&
                candidate.status === "assigned",
            )
          : undefined;
        await this.throwIfCancelled(context, input, config);
        const assigned = existingAssignment
          ? { work: current, assignment: existingAssignment }
          : await this.dependencies.works.assignTask(context, {
              commandId: `${input.commandId}:assignment`,
              workId: input.workId,
              expectedRevision: current.revision,
              taskId: input.task.task_id,
              agentHandle,
            });
        await this.throwIfCancelled(context, input, config);
        delivery = (
          await this.dependencies.coordinator.start(context, {
            commandId: startCommand,
            workId: input.workId,
            expectedWorkRevision: assigned.work.revision,
            taskId: input.task.task_id,
            expectedTaskRevision: input.task.revision,
            assignmentId: assigned.assignment.assignment_id,
            repositoryId: config.repositoryId,
            repositoryRevisionId: config.repositoryRevisionId,
            baseRevision: config.baseRevision,
            agentHandle,
            profileVersion: config.profileVersion,
            allowedPaths: config.allowedPaths,
            leaseTtlMs: config.leaseTtlMs,
          })
        ).delivery;
        await this.throwIfCancelled(context, input, config);
      }
      if (delivery.status === "failed" || delivery.status === "cancelled") {
        return { outcome: "blocked", reason: `software-delivery-${delivery.status}` };
      }
      if (delivery.status === "preparing") {
        await this.throwIfCancelled(context, input, config);
        delivery = await this.executeTdd(context, input, config, delivery, agentHandle);
        await this.throwIfCancelled(context, input, config);
      }
      if (delivery.status !== "committed")
        return { outcome: "blocked", reason: `software-delivery-${delivery.status}` };
      const [work, tasks] = await Promise.all([
        this.dependencies.works.getWork(context, input.workId),
        this.dependencies.works.listTasks(context, input.workId),
      ]);
      await this.throwIfCancelled(context, input, config);
      const task = tasks.find((candidate) => candidate.task_id === input.task.task_id);
      if (!task) return { outcome: "blocked", reason: "software-delivery-task-missing" };
      const resumedApprovalId = approvalId(input.resumeInput);
      try {
        await this.throwIfCancelled(context, input, config);
        await this.dependencies.finalizer.finalize(context, {
          commandId: `${input.commandId}:finalize`,
          deliveryId: delivery.deliveryId,
          expectedWorkRevision: work.revision,
          expectedTaskRevision: task.revision,
          environment: config.environment,
          ...(resumedApprovalId ? { governanceApprovalId: resumedApprovalId } : {}),
        });
        await this.throwIfCancelled(context, input, config);
        return { outcome: "completed" };
      } catch (error) {
        if (error instanceof GovernanceApprovalRequiredError) {
          return { outcome: "awaiting-approval", approvalId: error.approvalId };
        }
        throw error;
      }
    } finally {
      this.activeCommands.delete(input.commandId);
      this.cancellationRequested.delete(input.commandId);
    }
  }

  public async cancelTask(
    context: TenantContext,
    input: Parameters<CoreSoftwareTaskPort["cancelTask"]>[1],
  ): Promise<void> {
    this.cancellationRequested.add(input.commandId);
    try {
      const config = configuration(input.request);
      if (!config) return;
      await this.cancelExistingDelivery(context, input, config);
    } finally {
      if (!this.activeCommands.has(input.commandId)) this.cancellationRequested.delete(input.commandId);
    }
  }

  private async throwIfCancelled(
    context: TenantContext,
    input: Parameters<CoreSoftwareTaskPort["executeTask"]>[1],
    config: SoftwareDeliveryConfiguration,
  ): Promise<void> {
    if (!input.signal?.aborted && !this.cancellationRequested.has(input.commandId)) return;
    await this.cancelExistingDelivery(context, input, config);
    throw new Error(APPLICATION_RUN_CANCELLED);
  }

  private async cancelExistingDelivery(
    context: TenantContext,
    input: Parameters<CoreSoftwareTaskPort["cancelTask"]>[1],
    config: SoftwareDeliveryConfiguration,
  ): Promise<void> {
    const delivery = await this.dependencies.deliveries.findByStartCommand(context, `${input.commandId}:engineering`);
    if (!delivery) return;
    if (!["committed", "failed", "cancelled"].includes(delivery.status)) {
      await this.dependencies.deliveries.transition(context, {
        commandId: `${input.commandId}:cancel`,
        deliveryId: delivery.deliveryId,
        expectedVersion: delivery.version,
        target: "cancelled",
        error: { category: "application_cancelled", causeId: input.commandId },
      });
    }
    await this.dependencies.recovery.recover(context, {
      commandId: `${input.commandId}:cancel-recovery`,
      deliveryId: delivery.deliveryId,
      repositoryRoot: config.repositoryRoot,
      repositoryId: config.repositoryId,
    });
  }

  private async executeTdd(
    context: TenantContext,
    input: Parameters<CoreSoftwareTaskPort["executeTask"]>[1],
    config: SoftwareDeliveryConfiguration,
    delivery: EngineeringDelivery,
    agentHandle: string,
  ): Promise<EngineeringDelivery> {
    const proposal = await this.dependencies.proposals.propose(context, {
      commandId: `${input.commandId}:proposal`,
      workId: input.workId,
      taskId: input.task.task_id,
      agentHandle,
      modelRoute: "software-engineering-quality",
      correlationId: input.correlationId,
      estimatedTokens: 32_000,
      estimatedCostMicros: 0,
      objective: input.task.objective,
      acceptanceCriteria: criteria(input.task),
      evidenceBriefIds: config.evidenceBriefIds,
      allowedPaths: config.allowedPaths,
    });
    await this.throwIfCancelled(context, input, config);
    return (
      await this.dependencies.engine.execute(context, {
        deliveryId: delivery.deliveryId,
        repositoryRoot: config.repositoryRoot,
        allowedPaths: config.allowedPaths,
        testPaths: config.testPaths,
        ...proposal,
      })
    ).delivery;
  }
}
