import { createHash } from "node:crypto";

import type { TenantContext } from "@massion/identity";
import type { OrganizationNode } from "@massion/organization";

import type { EngineeringDelivery } from "./contracts.js";
import { EngineeringDeliveryStore } from "./delivery-store.js";
import { EngineeringPathLeaseStore, type EngineeringPathLease } from "./path-lease.js";
import { selectEngineeringAgent } from "./team-profile.js";

export interface EngineeringCoordinationPort {
  getWork(
    context: TenantContext,
    workId: string,
  ): Promise<{
    readonly organizationId: string;
    readonly workId: string;
    readonly status: string;
    readonly revision: number;
  }>;
  getTask(
    context: TenantContext,
    workId: string,
    taskId: string,
  ): Promise<{
    readonly organizationId: string;
    readonly workId: string;
    readonly taskId: string;
    readonly status: string;
    readonly revision: number;
    readonly requiredCapabilities: readonly string[];
    readonly recommendedAgentHandles: readonly string[];
  }>;
  getAssignment(
    context: TenantContext,
    workId: string,
    assignmentId: string,
  ): Promise<{
    readonly organizationId: string;
    readonly workId: string;
    readonly taskId: string;
    readonly assignmentId: string;
    readonly agentHandle: string;
    readonly status: string;
  }>;
  getCurrentIndex(
    context: TenantContext,
    repositoryId: string,
  ): Promise<
    | {
        readonly repositoryId: string;
        readonly repositoryRevisionId: string;
        readonly status: string;
        readonly current: boolean;
      }
    | undefined
  >;
  listOrganizationNodes(context: TenantContext): Promise<readonly OrganizationNode[]>;
  transitionTask(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly workId: string;
      readonly expectedWorkRevision: number;
      readonly taskId: string;
      readonly expectedTaskRevision: number;
      readonly target: "running";
    },
  ): Promise<{ readonly taskId: string; readonly status: "running"; readonly revision: number }>;
}

export interface StartCoordinatedEngineeringDeliveryInput {
  readonly commandId: string;
  readonly workId: string;
  readonly expectedWorkRevision: number;
  readonly taskId: string;
  readonly expectedTaskRevision: number;
  readonly assignmentId: string;
  readonly repositoryId: string;
  readonly repositoryRevisionId: string;
  readonly baseRevision: string;
  readonly agentHandle: string;
  readonly profileVersion: string;
  readonly allowedPaths: readonly string[];
  readonly leaseTtlMs: number;
}

export interface CoordinatedEngineeringDeliveryResult {
  readonly delivery: EngineeringDelivery;
  readonly lease: EngineeringPathLease;
  readonly task: { readonly taskId: string; readonly status: "running"; readonly revision: number };
}

function causeId(error: unknown): string {
  const category = error instanceof Error ? `${error.name}:${error.message}` : "unknown";
  return createHash("sha256").update(category).digest("hex");
}

export class EngineeringDeliveryCoordinator {
  public constructor(
    private readonly deliveries: EngineeringDeliveryStore,
    private readonly leases: EngineeringPathLeaseStore,
    private readonly port: EngineeringCoordinationPort,
  ) {}

  public async start(
    context: TenantContext,
    input: StartCoordinatedEngineeringDeliveryInput,
  ): Promise<CoordinatedEngineeringDeliveryResult> {
    const existing = await this.deliveries.findByStartCommand(context, input.commandId);
    if (!existing) await this.verifyPreconditions(context, input);
    const started = await this.deliveries.start(context, {
      commandId: input.commandId,
      workId: input.workId,
      taskId: input.taskId,
      assignmentId: input.assignmentId,
      repositoryId: input.repositoryId,
      repositoryRevisionId: input.repositoryRevisionId,
      baseRevision: input.baseRevision,
      agentHandle: input.agentHandle,
      profileVersion: input.profileVersion,
    });

    let lease: EngineeringPathLease | undefined;
    try {
      lease = (
        await this.leases.acquire(context, {
          commandId: `${input.commandId}:path-lease`,
          deliveryId: started.delivery.deliveryId,
          repositoryId: input.repositoryId,
          pathPrefixes: input.allowedPaths,
          ttlMs: input.leaseTtlMs,
        })
      ).lease;
      const task = await this.port.transitionTask(context, {
        commandId: `${input.commandId}:task-running`,
        workId: input.workId,
        expectedWorkRevision: input.expectedWorkRevision,
        taskId: input.taskId,
        expectedTaskRevision: input.expectedTaskRevision,
        target: "running",
      });
      return { delivery: await this.deliveries.get(context, started.delivery.deliveryId), lease, task };
    } catch (error) {
      if (lease) {
        await this.leases
          .release(context, {
            commandId: `${input.commandId}:path-lease-release`,
            leaseId: lease.leaseId,
            deliveryId: started.delivery.deliveryId,
          })
          .catch(() => undefined);
      }
      await this.failDelivery(context, started.delivery.deliveryId, error).catch(() => undefined);
      throw error;
    }
  }

  private async verifyPreconditions(
    context: TenantContext,
    input: StartCoordinatedEngineeringDeliveryInput,
  ): Promise<void> {
    const [work, task, assignment, currentIndex, nodes] = await Promise.all([
      this.port.getWork(context, input.workId),
      this.port.getTask(context, input.workId, input.taskId),
      this.port.getAssignment(context, input.workId, input.assignmentId),
      this.port.getCurrentIndex(context, input.repositoryId),
      this.port.listOrganizationNodes(context),
    ]);
    if (
      work.organizationId !== context.organizationId ||
      work.workId !== input.workId ||
      work.revision !== input.expectedWorkRevision ||
      !["ready", "running"].includes(work.status)
    ) {
      throw new Error("Work 소유 계보, 상태 또는 revision이 delivery 시작 조건과 다릅니다");
    }
    if (
      task.organizationId !== context.organizationId ||
      task.workId !== input.workId ||
      task.taskId !== input.taskId ||
      task.revision !== input.expectedTaskRevision ||
      task.status !== "ready"
    ) {
      throw new Error("정확한 revision의 ready Task가 필요합니다");
    }
    if (
      assignment.organizationId !== context.organizationId ||
      assignment.workId !== input.workId ||
      assignment.taskId !== input.taskId ||
      assignment.assignmentId !== input.assignmentId ||
      assignment.agentHandle !== input.agentHandle ||
      assignment.status !== "assigned"
    ) {
      throw new Error("Task와 Agent에 연결된 활성(assigned) Assignment가 필요합니다");
    }
    const selection = selectEngineeringAgent(nodes, {
      requiredCapabilities: task.requiredCapabilities,
      recommendedAgentHandles: task.recommendedAgentHandles,
    });
    if (selection.outcome !== "selected" || selection.agentHandle !== input.agentHandle) {
      throw new Error("Task capability를 정확히 충족하는 Agent가 없어 staffing gap 상태입니다");
    }
    if (
      !currentIndex ||
      currentIndex.repositoryId !== input.repositoryId ||
      currentIndex.repositoryRevisionId !== input.repositoryRevisionId ||
      currentIndex.status !== "complete" ||
      !currentIndex.current
    ) {
      throw new Error("입력 revision과 일치하는 current Evidence revision이 필요합니다");
    }
  }

  private async failDelivery(context: TenantContext, deliveryId: string, error: unknown): Promise<void> {
    const delivery = await this.deliveries.get(context, deliveryId);
    if (["committed", "failed", "cancelled"].includes(delivery.status)) return;
    await this.deliveries.transition(context, {
      commandId: `${delivery.startCommandId}:coordination-failed`,
      deliveryId,
      expectedVersion: delivery.version,
      target: "failed",
      error: { category: "coordination_failed", causeId: causeId(error) },
    });
  }
}
