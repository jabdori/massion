import { createHash } from "node:crypto";

import { GovernanceApprovalRequiredError } from "@massion/governance";
import type { TenantContext } from "@massion/identity";
import type {
  EngineeringDelivery,
  EngineeringDeliveryCoordinator,
  EngineeringDeliveryRecovery,
  EngineeringDeliveryStore,
  EngineeringMetricStore,
  EngineeringPathLease,
  EngineeringPathLeaseStore,
  SoftwareDeliveryFinalizer,
  SoftwarePatchProposalService,
  TddDeliveryEngine,
} from "@massion/software-engineering";
import { normalizeEngineeringPaths } from "@massion/software-engineering";
import type { WorkService, WorkTask } from "@massion/work";

import type { CoreSoftwareTaskPort } from "./core-delivery-stage.js";

const APPLICATION_RUN_CANCELLED = "Application run cancelled";
const STAGE_OUTPUT_RESERVE_TOKENS = 4_000;

interface SoftwareDeliveryConfiguration {
  readonly repositoryRoot: string;
  readonly repositoryId: string;
  readonly repositoryRevisionId: string;
  readonly baseRevision: string;
  readonly profileVersion: string;
  readonly allowedPaths: readonly string[];
  readonly testPaths: readonly string[];
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
  const allowedPaths = strings(record.allowedPaths, "Software Delivery allowed path");
  const testPaths = strings(record.testPaths, "Software Delivery test path");
  return {
    repositoryRoot: record.repositoryRoot as string,
    repositoryId: record.repositoryId as string,
    repositoryRevisionId: record.repositoryRevisionId as string,
    baseRevision: record.baseRevision as string,
    profileVersion: record.profileVersion as string,
    allowedPaths: normalizeEngineeringPaths(allowedPaths),
    testPaths: normalizeEngineeringPaths(testPaths),
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

function requestedTokenBudget(request: unknown): number {
  const value = request && typeof request === "object" && !Array.isArray(request) ? request : {};
  const tokenBudget = (value as { tokenBudget?: unknown }).tokenBudget ?? 32_000;
  if (!Number.isSafeInteger(tokenBudget) || (tokenBudget as number) < 1_000 || (tokenBudget as number) > 1_000_000) {
    throw new Error("Core Work token budget이 유효하지 않습니다");
  }
  return tokenBudget as number;
}

function proposalBaseline(task: WorkTask, config: SoftwareDeliveryConfiguration, tokenBudget: number): number {
  const prompt = {
    objective: task.objective,
    acceptanceCriteria: criteria(task),
    allowedPaths: config.allowedPaths,
    instruction: "testPatch와 implementationPatch를 분리해 제안하고 filesystem이나 process를 직접 실행하지 마세요.",
  };
  return Math.min(tokenBudget, Math.max(1, Math.ceil(JSON.stringify(prompt).length / 4)) + STAGE_OUTPUT_RESERVE_TOKENS);
}

function deliveryStartCommand(input: { readonly runId: string; readonly task: WorkTask }): string {
  return `${input.runId}:delivery:task:${input.task.task_id}:engineering`;
}

function terminalDeliveryResult(
  delivery: EngineeringDelivery,
): { readonly outcome: "failed" | "cancelled"; readonly reason: string } | undefined {
  return delivery.status === "failed" || delivery.status === "cancelled"
    ? { outcome: delivery.status, reason: `software-delivery-${delivery.status}` }
    : undefined;
}

function proposalExecutionStatus(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  if (!cause || typeof cause !== "object" || Array.isArray(cause)) return undefined;
  const status = (cause as { readonly status?: unknown }).status;
  return typeof status === "string" ? status : undefined;
}

function proposalExecutionRetryable(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  if (!cause || typeof cause !== "object" || Array.isArray(cause)) return false;
  const failure = cause as { readonly retryable?: unknown; readonly error?: { readonly retryable?: unknown } };
  return failure.retryable === true || failure.error?.retryable === true;
}

function failureCauseId(error: unknown): string {
  const value = error instanceof Error ? `${error.name}:${error.message}` : "Unknown delivery error";
  return createHash("sha256").update(value).digest("hex");
}

function isPathLeaseContention(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "EngineeringPathLeaseBusyError" || error.name === "EngineeringPathLeaseOwnershipError")
  );
}

function pathLeaseOwnershipError(message: string): Error {
  const error = new Error(message);
  error.name = "EngineeringPathLeaseOwnershipError";
  return error;
}

function isCommandCleanupFailure(error: unknown): error is Error {
  return error instanceof Error && error.name === "EngineeringCommandCleanupError";
}

function pathLeaseGeneration(commandId: string): number {
  const value = /:delivery:lease:(\d+):task:/u.exec(commandId)?.[1];
  const generation = value === undefined ? 0 : Number(value);
  return Number.isSafeInteger(generation) && generation > 0 ? generation : 0;
}

function durationMillis(delivery: EngineeringDelivery): number | undefined {
  const started = new Date(String(delivery.createdAt)).getTime();
  const ended = new Date(String(delivery.updatedAt)).getTime();
  return Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : undefined;
}

function deliveryOwnership(lease: EngineeringPathLease | undefined) {
  return lease ? { leaseId: lease.leaseId, ownerCommandId: lease.acquireCommandId } : undefined;
}

function pathLeaseExpired(lease: EngineeringPathLease): boolean {
  const expiresAt = new Date(String(lease.expiresAt)).getTime();
  return lease.status === "expired" || (Number.isFinite(expiresAt) && expiresAt <= Date.now());
}

interface ActiveDeliveryExecution {
  readonly ownerCommandId: string;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  filesystemStarted: boolean;
}

export class CoreSoftwareTaskAdapter implements CoreSoftwareTaskPort {
  private readonly activeCommands = new Set<string>();
  private readonly cancellationRequested = new Set<string>();
  private readonly activeDeliveryExecutions = new Map<string, ActiveDeliveryExecution>();

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
      readonly leases?: Pick<EngineeringPathLeaseStore, "acquire" | "renew"> &
        Partial<Pick<EngineeringPathLeaseStore, "claim" | "list">>;
      readonly metrics?: Pick<EngineeringMetricStore, "recordOnce">;
    },
  ) {}

  public async inspectTask(
    context: TenantContext,
    input: Parameters<NonNullable<CoreSoftwareTaskPort["inspectTask"]>>[1],
  ): ReturnType<NonNullable<CoreSoftwareTaskPort["inspectTask"]>> {
    const startCommand = deliveryStartCommand(input);
    const delivery = await this.dependencies.deliveries.findByStartCommand(context, startCommand);
    if (!delivery) return undefined;
    if (
      delivery.organizationId !== context.organizationId ||
      delivery.workId !== input.workId ||
      delivery.taskId !== input.task.task_id ||
      delivery.startCommandId !== startCommand
    ) {
      throw new Error("Software Delivery의 tenant·Work·Task·command 계보가 다릅니다");
    }
    return terminalDeliveryResult(delivery);
  }

  public async executeTask(
    context: TenantContext,
    input: Parameters<CoreSoftwareTaskPort["executeTask"]>[1],
  ): ReturnType<CoreSoftwareTaskPort["executeTask"]> {
    this.activeCommands.add(input.commandId);
    try {
      let config: SoftwareDeliveryConfiguration | undefined;
      try {
        config = configuration(input.request);
      } catch {
        return { outcome: "blocked", reason: "software-delivery-configuration-invalid" };
      }
      if (!config) return { outcome: "blocked", reason: "software-delivery-configuration-required" };
      const agentHandle = input.task.recommended_agent_handles?.[0];
      if (!agentHandle) return { outcome: "blocked", reason: "software-delivery-agent-required" };
      const tokenBudget = requestedTokenBudget(input.request);
      const baselineTokens = proposalBaseline(input.task, config, tokenBudget);
      const knowledgeTokens = input.knowledgeSources?.reduce((total, source) => total + source.estimatedTokens, 0) ?? 0;
      if (
        input.knowledgeSources?.some(
          (source) => !Number.isSafeInteger(source.estimatedTokens) || source.estimatedTokens < 1,
        ) ||
        baselineTokens + knowledgeTokens > tokenBudget
      ) {
        return { outcome: "blocked", reason: "evidence-invalid" };
      }
      await this.throwIfCancelled(context, input, config);
      const startCommand = deliveryStartCommand(input);
      const leaseCommandId = `${input.runId}:delivery:lease:${String(input.leaseGeneration ?? "unfenced")}:task:${input.task.task_id}`;
      let delivery = await this.dependencies.deliveries.findByStartCommand(context, startCommand);
      const continuing = delivery !== undefined;
      let lease: EngineeringPathLease | undefined;
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
        try {
          const coordinated = await this.dependencies.coordinator.start(context, {
            commandId: startCommand,
            leaseCommandId,
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
          });
          delivery = coordinated.delivery;
          lease = coordinated.lease;
        } catch (error) {
          const terminal = await this.dependencies.deliveries.findByStartCommand(context, startCommand);
          const result = terminal && terminalDeliveryResult(terminal);
          if (result && terminal) return await this.finishTerminal(context, input, config, terminal);
          if (isPathLeaseContention(error)) {
            return { outcome: "blocked", reason: "software-delivery-owned" };
          }
          throw error;
        }
        await this.throwIfCancelled(context, input, config);
      }
      const terminal = terminalDeliveryResult(delivery);
      if (terminal) return await this.finishTerminal(context, input, config, delivery);
      let observedLease: EngineeringPathLease | undefined;
      let observedLeaseExpired = false;
      let claimedBeforeRecovery = false;
      if (continuing && delivery.status !== "committed" && this.dependencies.leases?.list) {
        try {
          observedLease = (await this.dependencies.leases.list(context, config.repositoryId)).find(
            (candidate) =>
              candidate.deliveryId === delivery.deliveryId && ["active", "expired"].includes(candidate.status),
          );
          if (observedLease) {
            observedLeaseExpired = pathLeaseExpired(observedLease);
            const foreignOwner = observedLease.acquireCommandId !== leaseCommandId;
            if (
              (foreignOwner && !observedLeaseExpired) ||
              (!observedLeaseExpired && this.activeDeliveryExecutions.has(delivery.deliveryId)) ||
              (foreignOwner &&
                input.leaseGeneration !== undefined &&
                pathLeaseGeneration(observedLease.acquireCommandId) >= input.leaseGeneration)
            ) {
              return { outcome: "blocked", reason: "software-delivery-owned" };
            }
            if (observedLeaseExpired) {
              await this.stopDeliveryExecution(delivery.deliveryId, observedLease.acquireCommandId);
              observedLease = (await this.dependencies.leases.list(context, config.repositoryId)).find(
                (candidate) =>
                  candidate.deliveryId === delivery.deliveryId && ["active", "expired"].includes(candidate.status),
              );
              if (
                observedLease &&
                observedLease.acquireCommandId !== leaseCommandId &&
                !pathLeaseExpired(observedLease)
              ) {
                return { outcome: "blocked", reason: "software-delivery-owned" };
              }
              observedLeaseExpired = observedLease !== undefined && pathLeaseExpired(observedLease);
            }
          }
        } catch (error) {
          if (isCommandCleanupFailure(error)) {
            return { outcome: "blocked", reason: "software-delivery-command-cleanup-failed" };
          }
          if (isPathLeaseContention(error)) {
            return { outcome: "blocked", reason: "software-delivery-owned" };
          }
          throw error;
        }
      } else if (continuing && delivery.status !== "committed" && this.dependencies.leases) {
        try {
          lease = await this.claimLease(context, input, config, delivery, leaseCommandId);
          claimedBeforeRecovery = true;
        } catch (error) {
          if (isPathLeaseContention(error)) return { outcome: "blocked", reason: "software-delivery-owned" };
          throw error;
        }
      }
      if (continuing && delivery.status !== "committed") {
        try {
          const recoveryOwnerCommandId = observedLease?.acquireCommandId ?? lease?.acquireCommandId ?? leaseCommandId;
          const recovered = await this.runDeliveryExecution(
            delivery.deliveryId,
            recoveryOwnerCommandId,
            input.signal,
            async (signal) =>
              await this.dependencies.recovery.recover(context, {
                commandId: `${leaseCommandId}:recovery`,
                deliveryId: delivery.deliveryId,
                repositoryRoot: config.repositoryRoot,
                repositoryId: config.repositoryId,
                leaseTtlMs: config.leaseTtlMs,
                signal,
                ...(observedLease?.acquireCommandId === leaseCommandId && !observedLeaseExpired
                  ? { preserveLeaseCommandId: leaseCommandId }
                  : observedLease === undefined
                    ? {}
                    : { cleanupLeaseCommandId: observedLease.acquireCommandId }),
                ...(claimedBeforeRecovery && lease !== undefined
                  ? { preserveLeaseCommandId: lease.acquireCommandId }
                  : {}),
              }),
          );
          delivery = recovered.delivery ?? delivery;
        } catch (error) {
          return {
            outcome: "blocked",
            reason: isPathLeaseContention(error) ? "software-delivery-owned" : "software-delivery-recovery-failed",
          };
        }
        const recoveredTerminal = terminalDeliveryResult(delivery);
        if (recoveredTerminal) return await this.finishTerminal(context, input, config, delivery);
      }
      if (continuing && delivery.status === "preparing" && !claimedBeforeRecovery && this.dependencies.leases) {
        try {
          lease = await this.claimLease(context, input, config, delivery, leaseCommandId);
        } catch (error) {
          if (isPathLeaseContention(error)) return { outcome: "blocked", reason: "software-delivery-owned" };
          throw error;
        }
      }
      if (delivery.status === "preparing") {
        await this.throwIfCancelled(context, input, config);
        try {
          delivery = await this.runDeliveryExecution(
            delivery.deliveryId,
            lease?.acquireCommandId ?? leaseCommandId,
            input.signal,
            async (signal) => await this.executeTdd(context, input, config, delivery, agentHandle, lease, signal),
          );
        } catch (error) {
          if (isCommandCleanupFailure(error)) {
            return { outcome: "blocked", reason: "software-delivery-command-cleanup-failed" };
          }
          await this.throwIfCancelled(context, input, config);
          delivery = await this.dependencies.deliveries.get(context, delivery.deliveryId);
          const terminalFailure = terminalDeliveryResult(delivery);
          if (terminalFailure) return await this.finishTerminal(context, input, config, delivery);
          if (isPathLeaseContention(error)) {
            return { outcome: "blocked", reason: "software-delivery-owned" };
          }
          const executionStatus = proposalExecutionStatus(error);
          if (executionStatus === "blocked_model_unavailable") {
            await this.cleanupRetryable(context, input, config, delivery, leaseCommandId);
            return { outcome: "blocked", reason: "model-unavailable" };
          }
          if (proposalExecutionRetryable(error)) {
            await this.cleanupRetryable(context, input, config, delivery, leaseCommandId);
            return { outcome: "blocked", reason: "software-delivery-retryable" };
          }
          if (executionStatus === "interrupted") {
            await this.cleanupRetryable(context, input, config, delivery, leaseCommandId);
            return { outcome: "blocked", reason: "software-delivery-interrupted" };
          }
          if (executionStatus === "cancelled") {
            delivery = (
              await this.dependencies.deliveries.transition(context, {
                commandId: `${delivery.startCommandId}:proposal-cancelled`,
                deliveryId: delivery.deliveryId,
                expectedVersion: delivery.version,
                target: "cancelled",
                ...(deliveryOwnership(lease) === undefined ? {} : { ownership: deliveryOwnership(lease) }),
              })
            ).delivery;
            const cancelled = terminalDeliveryResult(delivery);
            if (!cancelled) throw new Error("취소된 Delivery가 terminal 상태가 아닙니다");
            return await this.finishTerminal(context, input, config, delivery);
          }
          if (delivery.status !== "preparing") {
            return { outcome: "blocked", reason: `software-delivery-${delivery.status}` };
          }
          delivery = (
            await this.dependencies.deliveries.transition(context, {
              commandId: `${delivery.startCommandId}:execution-failed`,
              deliveryId: delivery.deliveryId,
              expectedVersion: delivery.version,
              target: "failed",
              error: { category: "delivery_execution_failed", causeId: failureCauseId(error) },
              ...(deliveryOwnership(lease) === undefined ? {} : { ownership: deliveryOwnership(lease) }),
            })
          ).delivery;
          const finalizedFailure = terminalDeliveryResult(delivery);
          if (!finalizedFailure) throw new Error("실패한 Delivery가 terminal 상태가 아닙니다");
          return await this.finishTerminal(context, input, config, delivery);
        }
        await this.throwIfCancelled(context, input, config);
      }
      if (delivery.status !== "committed")
        return { outcome: "blocked", reason: `software-delivery-${delivery.status}` };
      await this.observeTerminal(context, input, config, delivery);
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

  private async runDeliveryExecution<T>(
    deliveryId: string,
    ownerCommandId: string,
    parentSignal: AbortSignal | undefined,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.activeDeliveryExecutions.has(deliveryId)) {
      throw pathLeaseOwnershipError("같은 Delivery의 filesystem 실행이 아직 종료되지 않았습니다");
    }
    const controller = new AbortController();
    let markSettled!: () => void;
    let markUnsafe!: (reason: unknown) => void;
    const settled = new Promise<void>((resolve, reject) => {
      markSettled = resolve;
      markUnsafe = reject;
    });
    void settled.catch(() => undefined);
    const active = { ownerCommandId, controller, settled, filesystemStarted: false };
    this.activeDeliveryExecutions.set(deliveryId, active);
    const abort = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener("abort", abort, { once: true });
    if (parentSignal?.aborted) abort();
    let unsafeFailure: Error | undefined;
    try {
      return await execute(controller.signal);
    } catch (error) {
      if (isCommandCleanupFailure(error)) unsafeFailure = error;
      throw error;
    } finally {
      parentSignal?.removeEventListener("abort", abort);
      if (unsafeFailure) {
        markUnsafe(unsafeFailure);
      } else {
        if (this.activeDeliveryExecutions.get(deliveryId) === active) this.activeDeliveryExecutions.delete(deliveryId);
        markSettled();
      }
    }
  }

  private async stopDeliveryExecution(deliveryId: string, ownerCommandId: string): Promise<void> {
    const active = this.activeDeliveryExecutions.get(deliveryId);
    if (!active) return;
    if (active.ownerCommandId !== ownerCommandId) {
      throw pathLeaseOwnershipError("중지할 filesystem 실행의 owner가 현재 path lease와 다릅니다");
    }
    active.controller.abort(pathLeaseOwnershipError("만료된 owner 실행을 회수합니다"));
    await active.settled;
  }

  private markFilesystemStarted(deliveryId: string, ownerCommandId: string): void {
    const active = this.activeDeliveryExecutions.get(deliveryId);
    if (!active || active.ownerCommandId !== ownerCommandId) {
      throw pathLeaseOwnershipError("TDD filesystem 실행의 owner가 현재 path lease와 다릅니다");
    }
    active.filesystemStarted = true;
  }

  private async cancelExistingDelivery(
    context: TenantContext,
    input: Parameters<CoreSoftwareTaskPort["cancelTask"]>[1],
    config: SoftwareDeliveryConfiguration,
  ): Promise<void> {
    const delivery = await this.dependencies.deliveries.findByStartCommand(context, deliveryStartCommand(input));
    if (!delivery) return;
    if (!["committed", "failed", "cancelled"].includes(delivery.status)) {
      const activeExecution = this.activeDeliveryExecutions.get(delivery.deliveryId);
      if (activeExecution?.filesystemStarted) {
        await this.stopDeliveryExecution(delivery.deliveryId, activeExecution.ownerCommandId);
      }
      let owned: EngineeringPathLease | undefined;
      if (this.dependencies.leases) {
        const leaseCommandId = `${input.runId}:delivery:lease:${String(input.leaseGeneration ?? "unfenced")}:task:${input.task.task_id}`;
        const lease = input.leaseGeneration
          ? (
              await this.dependencies.leases.claim?.(context, {
                commandId: leaseCommandId,
                deliveryId: delivery.deliveryId,
                repositoryId: config.repositoryId,
                pathPrefixes: config.allowedPaths,
                ttlMs: config.leaseTtlMs,
                ownerGeneration: input.leaseGeneration,
              })
            )?.lease
          : undefined;
        owned =
          lease ??
          (
            await this.dependencies.leases.acquire(context, {
              commandId: leaseCommandId,
              deliveryId: delivery.deliveryId,
              repositoryId: config.repositoryId,
              pathPrefixes: config.allowedPaths,
              ttlMs: config.leaseTtlMs,
            })
          ).lease;
        if (owned.status !== "active") throw new Error("취소 worker가 active path lease를 소유하지 않습니다");
      }
      const transitioned = await this.dependencies.deliveries.transition(context, {
        commandId: `${input.commandId}:cancel`,
        deliveryId: delivery.deliveryId,
        expectedVersion: delivery.version,
        target: "cancelled",
        ...(deliveryOwnership(owned) === undefined ? {} : { ownership: deliveryOwnership(owned) }),
      });
      await this.observeTerminal(context, input, config, transitioned.delivery);
      return;
    }
    await this.observeTerminal(context, input, config, delivery);
  }

  private async executeTdd(
    context: TenantContext,
    input: Parameters<CoreSoftwareTaskPort["executeTask"]>[1],
    config: SoftwareDeliveryConfiguration,
    delivery: EngineeringDelivery,
    agentHandle: string,
    lease?: EngineeringPathLease,
    signal?: AbortSignal,
  ): Promise<EngineeringDelivery> {
    const knowledgeTokens = input.knowledgeSources?.reduce((total, source) => total + source.estimatedTokens, 0) ?? 0;
    const tokenBudget = requestedTokenBudget(input.request);
    const assertOwnership = async (): Promise<void> => {
      if (signal?.aborted) throw pathLeaseOwnershipError("TDD owner 실행이 중지됐습니다");
      if (!lease || !this.dependencies.leases) return;
      lease = (
        await this.dependencies.leases.renew(context, {
          leaseId: lease.leaseId,
          deliveryId: delivery.deliveryId,
          repositoryId: config.repositoryId,
          expectedVersion: lease.version,
          ttlMs: config.leaseTtlMs,
        })
      ).lease;
    };
    await assertOwnership();
    const proposal = await this.dependencies.proposals.propose(context, {
      commandId: `${input.commandId}:proposal`,
      workId: input.workId,
      taskId: input.task.task_id,
      agentHandle,
      modelRoute: "software-engineering-quality",
      correlationId: input.correlationId,
      estimatedTokens: proposalBaseline(input.task, config, tokenBudget) + knowledgeTokens,
      estimatedCostMicros: 0,
      objective: input.task.objective,
      acceptanceCriteria: criteria(input.task),
      evidenceBriefIds: input.knowledgeSources?.map((source) => source.evidenceBriefId) ?? [],
      knowledgeSources: input.knowledgeSources ?? [],
      allowedPaths: config.allowedPaths,
    });
    await assertOwnership();
    await this.throwIfCancelled(context, input, config);
    this.markFilesystemStarted(
      delivery.deliveryId,
      lease?.acquireCommandId ??
        `${input.runId}:delivery:lease:${String(input.leaseGeneration ?? "unfenced")}:task:${input.task.task_id}`,
    );
    return (
      await this.dependencies.engine.execute(context, {
        deliveryId: delivery.deliveryId,
        repositoryRoot: config.repositoryRoot,
        allowedPaths: config.allowedPaths,
        testPaths: config.testPaths,
        ...(lease === undefined
          ? {}
          : {
              pathLease: {
                leaseId: lease.leaseId,
                ownerCommandId: lease.acquireCommandId,
                version: lease.version,
                ttlMs: config.leaseTtlMs,
              },
            }),
        ...(signal === undefined ? {} : { signal }),
        ...proposal,
      })
    ).delivery;
  }

  private async claimLease(
    context: TenantContext,
    input: Parameters<CoreSoftwareTaskPort["executeTask"]>[1],
    config: SoftwareDeliveryConfiguration,
    delivery: EngineeringDelivery,
    leaseCommandId: string,
  ): Promise<EngineeringPathLease> {
    if (!this.dependencies.leases) throw new Error("Engineering path lease store가 구성되지 않았습니다");
    const claimed = input.leaseGeneration
      ? (
          await this.dependencies.leases.claim?.(context, {
            commandId: leaseCommandId,
            deliveryId: delivery.deliveryId,
            repositoryId: config.repositoryId,
            pathPrefixes: config.allowedPaths,
            ttlMs: config.leaseTtlMs,
            ownerGeneration: input.leaseGeneration,
          })
        )?.lease
      : undefined;
    const lease =
      claimed ??
      (
        await this.dependencies.leases.acquire(context, {
          commandId: leaseCommandId,
          deliveryId: delivery.deliveryId,
          repositoryId: config.repositoryId,
          pathPrefixes: config.allowedPaths,
          ttlMs: config.leaseTtlMs,
        })
      ).lease;
    if (lease.status !== "active") throw new Error("active Engineering path lease를 claim하지 못했습니다");
    return lease;
  }

  private async finishTerminal(
    context: TenantContext,
    input: Parameters<CoreSoftwareTaskPort["executeTask"]>[1],
    config: SoftwareDeliveryConfiguration,
    delivery: EngineeringDelivery,
  ): ReturnType<CoreSoftwareTaskPort["executeTask"]> {
    const result = terminalDeliveryResult(delivery);
    if (!result) throw new Error("Delivery가 failed 또는 cancelled terminal 상태가 아닙니다");
    await this.observeTerminal(context, input, config, delivery);
    return result;
  }

  private async cleanupRetryable(
    context: TenantContext,
    input: Parameters<CoreSoftwareTaskPort["executeTask"]>[1],
    config: SoftwareDeliveryConfiguration,
    delivery: EngineeringDelivery,
    leaseCommandId: string,
  ): Promise<void> {
    try {
      await this.dependencies.recovery.recover(context, {
        commandId: `${leaseCommandId}:retryable-recovery`,
        deliveryId: delivery.deliveryId,
        repositoryRoot: config.repositoryRoot,
        repositoryId: config.repositoryId,
        cleanupLeaseCommandId: leaseCommandId,
      });
    } catch (error) {
      await this.dependencies.metrics
        ?.recordOnce(context, `delivery:${delivery.deliveryId}:retryable-cleanup-failed`, {
          name: "engineering_recovery_total",
          value: 1,
          dimensions: { result: "cleanup_failed" },
        })
        .catch(() => undefined);
      throw error;
    }
    await this.throwIfCancelled(context, input, config);
  }

  private async observeTerminal(
    context: TenantContext,
    input: Pick<Parameters<CoreSoftwareTaskPort["executeTask"]>[1], "runId">,
    config: SoftwareDeliveryConfiguration,
    delivery: EngineeringDelivery,
  ): Promise<void> {
    const status = delivery.status;
    if (!["committed", "failed", "cancelled"].includes(status)) return;
    const metricStatus = status as "committed" | "failed" | "cancelled";
    const metricTasks: Promise<void>[] = [];
    if (this.dependencies.metrics) {
      metricTasks.push(
        this.dependencies.metrics.recordOnce(context, `delivery:${delivery.deliveryId}:status`, {
          name: "engineering_delivery_status_total",
          value: 1,
          dimensions: { status: metricStatus },
        }),
      );
      const duration = durationMillis(delivery);
      if (duration !== undefined) {
        metricTasks.push(
          this.dependencies.metrics.recordOnce(context, `delivery:${delivery.deliveryId}:duration`, {
            name: "engineering_delivery_duration_ms",
            value: duration,
            dimensions: { status: metricStatus },
          }),
        );
      }
    }
    await Promise.allSettled(metricTasks);
    try {
      await this.dependencies.recovery.recover(context, {
        commandId: `${delivery.startCommandId ?? input.runId}:terminal-cleanup`,
        deliveryId: delivery.deliveryId,
        repositoryRoot: config.repositoryRoot,
        repositoryId: config.repositoryId,
      });
    } catch {
      await this.dependencies.metrics
        ?.recordOnce(context, `delivery:${delivery.deliveryId}:cleanup-failed`, {
          name: "engineering_recovery_total",
          value: 1,
          dimensions: { result: "cleanup_failed" },
        })
        .catch(() => undefined);
    }
  }
}
