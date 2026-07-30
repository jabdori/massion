import { createHash } from "node:crypto";

import type { TenantContext } from "@massion/identity";

import type { EngineeringDelivery } from "./contracts.js";
import { EngineeringDeliveryStore } from "./delivery-store.js";
import { GitWorkspaceManager } from "./git-workspace.js";
import type { EngineeringMetricStore } from "./metrics.js";
import {
  EngineeringPathLeaseOwnershipError,
  EngineeringPathLeaseStore,
  type EngineeringPathLease,
} from "./path-lease.js";
import type { SoftwareDeliveryFinalizer } from "./runtime.js";

export interface EngineeringDeliveryContinuation {
  resume(context: TenantContext, delivery: EngineeringDelivery): Promise<void>;
}

export type EngineeringRecoveryResult =
  "reconciled_commit" | "resumed" | "resume_required" | "cleaned_terminal" | "finalized";

function recoveryCauseId(category: string, detail: string): string {
  return createHash("sha256").update(`${category}:${detail}`).digest("hex");
}

export class EngineeringDeliveryRecovery {
  public constructor(
    private readonly deliveries: EngineeringDeliveryStore,
    private readonly workspaces: GitWorkspaceManager,
    private readonly leases: EngineeringPathLeaseStore,
    private readonly metrics?: EngineeringMetricStore,
    private readonly continuation?: EngineeringDeliveryContinuation,
    private readonly finalizer?: SoftwareDeliveryFinalizer,
  ) {}

  public async recover(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly deliveryId: string;
      readonly repositoryRoot: string;
      readonly repositoryId: string;
      readonly preserveLeaseCommandId?: string;
      readonly cleanupLeaseCommandId?: string;
      readonly leaseTtlMs?: number;
      readonly signal?: AbortSignal;
      readonly finalization?: {
        readonly commandId: string;
        readonly expectedWorkRevision: number;
        readonly expectedTaskRevision: number;
        readonly environment: string;
        readonly governanceApprovalId?: string;
      };
    },
  ): Promise<{ readonly delivery: EngineeringDelivery; readonly result: EngineeringRecoveryResult }> {
    const replayRequest = {
      deliveryId: input.deliveryId,
      repositoryRoot: input.repositoryRoot,
      repositoryId: input.repositoryId,
      preserveLeaseCommandId: input.preserveLeaseCommandId,
      cleanupLeaseCommandId: input.cleanupLeaseCommandId,
      leaseTtlMs: input.leaseTtlMs,
      finalization: input.finalization,
    };
    const replayed = await this.deliveries.findRecoveryReplay(context, {
      commandId: input.commandId,
      deliveryId: input.deliveryId,
      request: replayRequest,
    });
    if (replayed) {
      return {
        delivery: await this.deliveries.get(context, replayed.deliveryId),
        result: replayed.result as EngineeringRecoveryResult,
      };
    }
    let delivery = await this.deliveries.get(context, input.deliveryId);
    if (delivery.repositoryId !== input.repositoryId) {
      throw new Error("Recovery repository가 delivery 소유 계보와 다릅니다");
    }
    const recoveryLeaseCommandId = input.preserveLeaseCommandId ?? input.cleanupLeaseCommandId;
    const deliveryLeases = await this.leases.list(context, input.repositoryId);
    let recoveryLease = recoveryLeaseCommandId
      ? deliveryLeases.find(
          (lease) =>
            lease.deliveryId === delivery.deliveryId &&
            (lease.status === "active" || lease.status === "expired") &&
            lease.acquireCommandId === recoveryLeaseCommandId,
        )
      : undefined;
    const cleanupAlreadyReleased =
      input.cleanupLeaseCommandId !== undefined &&
      deliveryLeases.some(
        (lease) =>
          lease.deliveryId === delivery.deliveryId &&
          lease.status === "released" &&
          lease.acquireCommandId === input.cleanupLeaseCommandId,
      );
    if (recoveryLeaseCommandId && !recoveryLease && !cleanupAlreadyReleased) {
      throw new EngineeringPathLeaseOwnershipError("Recovery path lease owner fence가 일치하지 않습니다");
    }
    const recoveryLeaseId = recoveryLease?.leaseId;
    const assertOwnership = async (expectedDelivery?: EngineeringDelivery): Promise<void> => {
      if (input.signal?.aborted) throw new EngineeringPathLeaseOwnershipError("Recovery owner 실행이 중지됐습니다");
      if (recoveryLeaseCommandId) {
        const current = (await this.leases.list(context, input.repositoryId)).find(
          (lease) =>
            lease.leaseId === recoveryLeaseId &&
            lease.deliveryId === (expectedDelivery?.deliveryId ?? delivery.deliveryId) &&
            (lease.status === "active" || lease.status === "expired") &&
            lease.acquireCommandId === recoveryLeaseCommandId,
        );
        if (!current) {
          throw new EngineeringPathLeaseOwnershipError("Recovery path lease owner fence가 더 이상 active가 아닙니다");
        }
        recoveryLease = current;
        const expiresAt = new Date(String(current.expiresAt)).getTime();
        if (
          current.status === "active" &&
          (!Number.isFinite(expiresAt) || expiresAt > Date.now()) &&
          input.leaseTtlMs !== undefined
        ) {
          const renewed = (
            await this.leases.renew(context, {
              leaseId: current.leaseId,
              deliveryId: current.deliveryId,
              repositoryId: current.repositoryId,
              expectedVersion: current.version,
              ttlMs: input.leaseTtlMs,
            })
          ).lease;
          if (
            renewed.leaseId !== current.leaseId ||
            renewed.acquireCommandId !== recoveryLeaseCommandId ||
            renewed.status !== "active"
          ) {
            throw new EngineeringPathLeaseOwnershipError("Recovery path lease renew 결과의 owner fence가 다릅니다");
          }
          recoveryLease = renewed;
        }
      }
      if (!expectedDelivery) return;
      const currentDelivery = await this.deliveries.get(context, expectedDelivery.deliveryId);
      if (
        currentDelivery.deliveryId !== expectedDelivery.deliveryId ||
        currentDelivery.organizationId !== expectedDelivery.organizationId ||
        currentDelivery.workId !== expectedDelivery.workId ||
        currentDelivery.taskId !== expectedDelivery.taskId ||
        currentDelivery.assignmentId !== expectedDelivery.assignmentId ||
        currentDelivery.repositoryId !== expectedDelivery.repositoryId ||
        currentDelivery.repositoryRevisionId !== expectedDelivery.repositoryRevisionId ||
        currentDelivery.baseRevision !== expectedDelivery.baseRevision ||
        currentDelivery.repositoryRootRealPathHash !== expectedDelivery.repositoryRootRealPathHash ||
        currentDelivery.agentHandle !== expectedDelivery.agentHandle ||
        currentDelivery.profileVersion !== expectedDelivery.profileVersion ||
        currentDelivery.startCommandId !== expectedDelivery.startCommandId ||
        currentDelivery.status !== expectedDelivery.status ||
        currentDelivery.version !== expectedDelivery.version
      ) {
        throw new EngineeringPathLeaseOwnershipError(
          "Recovery Delivery snapshot owner fence가 더 이상 일치하지 않습니다",
        );
      }
    };
    const ownership = () =>
      recoveryLease ? { leaseId: recoveryLease.leaseId, ownerCommandId: recoveryLease.acquireCommandId } : undefined;
    await assertOwnership();
    await this.workspaces.verifyRepositoryRoot(input.repositoryRoot, delivery.repositoryRootRealPathHash);
    let result: EngineeringRecoveryResult;
    if (delivery.status === "preparing") {
      await this.cleanup(
        context,
        delivery,
        input.repositoryRoot,
        input.repositoryId,
        input.preserveLeaseCommandId,
        input.cleanupLeaseCommandId,
        assertOwnership,
        cleanupAlreadyReleased,
      );
      result = "resume_required";
    } else if (delivery.status === "green_verified") {
      let branch;
      let branchInspectionError: unknown;
      try {
        await assertOwnership();
        branch = await this.workspaces.inspectDeliveryBranch({
          repositoryRoot: input.repositoryRoot,
          baseRevision: delivery.baseRevision,
          deliveryId: delivery.deliveryId,
        });
      } catch (error) {
        if (error instanceof EngineeringPathLeaseOwnershipError) throw error;
        branchInspectionError = error;
      }
      if (branchInspectionError) {
        const detail =
          branchInspectionError instanceof Error ? branchInspectionError.message : "알 수 없는 branch 검사 실패";
        delivery = await this.fail(context, delivery, "recovery_branch_invalid", detail, ownership());
        result = "cleaned_terminal";
      } else if (branch) {
        if (branch.changeSetHash !== delivery.implementationPatchHash) {
          delivery = await this.fail(
            context,
            delivery,
            "recovery_branch_mismatch",
            "Delivery branch tree가 저장된 implementation change set과 다릅니다",
            ownership(),
          );
          result = "cleaned_terminal";
        } else {
          await this.deliveries.recordFileChanges(context, delivery.deliveryId, branch.fileChanges, ownership());
          const validationEvidenceIds = await this.deliveries.listCommandEvidenceIds(
            context,
            delivery.deliveryId,
            "validation",
          );
          const currentOwnership = ownership();
          delivery = (
            await this.deliveries.transition(context, {
              commandId: `${delivery.startCommandId}:recovery-committed`,
              deliveryId: delivery.deliveryId,
              expectedVersion: delivery.version,
              target: "committed",
              branchRef: branch.branchRef,
              commitSha: branch.commitSha,
              changeSetHash: branch.changeSetHash,
              validationEvidenceIds,
              ...(currentOwnership === undefined ? {} : { ownership: currentOwnership }),
            })
          ).delivery;
          result = "reconciled_commit";
        }
      } else {
        await assertOwnership();
        const verified = await this.verifyWorkspaceStage(input.repositoryRoot, delivery);
        if (verified) {
          await assertOwnership();
          result = await this.resume(context, delivery);
          await assertOwnership();
          if (result === "resume_required") {
            delivery = await this.rollbackForRetry(context, delivery, input, assertOwnership, cleanupAlreadyReleased);
          }
        } else {
          delivery = await this.fail(
            context,
            delivery,
            "recovery_workspace_mismatch",
            "GREEN workspace와 implementation change set이 일치하지 않습니다",
            ownership(),
          );
          result = "cleaned_terminal";
        }
      }
    } else if (["test_applied", "red_verified", "implementation_applied"].includes(delivery.status)) {
      await assertOwnership();
      const verified = await this.verifyWorkspaceStage(input.repositoryRoot, delivery);
      if (verified) {
        await assertOwnership();
        result = await this.resume(context, delivery);
        await assertOwnership();
        if (result === "resume_required") {
          delivery = await this.rollbackForRetry(context, delivery, input, assertOwnership, cleanupAlreadyReleased);
        }
      } else {
        delivery = await this.fail(
          context,
          delivery,
          "recovery_workspace_mismatch",
          `${delivery.status} workspace와 저장된 change set이 일치하지 않습니다`,
          ownership(),
        );
        result = "cleaned_terminal";
      }
    } else if (delivery.status === "committed" && this.finalizer && input.finalization) {
      await this.finalizer.finalize(context, { ...input.finalization, deliveryId: delivery.deliveryId });
      delivery = await this.deliveries.get(context, delivery.deliveryId);
      result = "finalized";
    } else {
      result = "cleaned_terminal";
    }

    delivery = await this.deliveries.get(context, delivery.deliveryId);
    if (["committed", "failed", "cancelled"].includes(delivery.status)) {
      await this.cleanup(
        context,
        delivery,
        input.repositoryRoot,
        input.repositoryId,
        undefined,
        input.cleanupLeaseCommandId,
        assertOwnership,
        cleanupAlreadyReleased,
      );
    }
    if (this.metrics) {
      await this.metrics.recordOnce(context, `recovery:${input.commandId}`, {
        name: "engineering_recovery_total",
        value: 1,
        dimensions: { result },
      });
    }
    await this.deliveries.recordRecoveryEvent(context, {
      commandId: input.commandId,
      deliveryId: delivery.deliveryId,
      request: replayRequest,
      result,
    });
    return { delivery, result };
  }

  private async verifyWorkspaceStage(repositoryRoot: string, delivery: EngineeringDelivery): Promise<boolean> {
    let snapshot;
    try {
      snapshot = await this.workspaces.inspectDeliveryWorkspace({
        repositoryRoot,
        baseRevision: delivery.baseRevision,
        deliveryId: delivery.deliveryId,
      });
    } catch {
      return false;
    }
    const expectedHash =
      delivery.status === "test_applied" || delivery.status === "red_verified"
        ? delivery.testPatchHash
        : delivery.implementationPatchHash;
    return snapshot !== undefined && expectedHash !== undefined && snapshot.changeSetHash === expectedHash;
  }

  private async fail(
    context: TenantContext,
    delivery: EngineeringDelivery,
    category: string,
    detail: string,
    ownership?: { readonly leaseId: string; readonly ownerCommandId: string },
  ): Promise<EngineeringDelivery> {
    return (
      await this.deliveries.transition(context, {
        commandId: `${delivery.startCommandId}:${category}`,
        deliveryId: delivery.deliveryId,
        expectedVersion: delivery.version,
        target: "failed",
        error: { category, causeId: recoveryCauseId(category, detail) },
        ...(ownership === undefined ? {} : { ownership }),
      })
    ).delivery;
  }

  private async resume(context: TenantContext, delivery: EngineeringDelivery): Promise<EngineeringRecoveryResult> {
    if (!this.continuation) return "resume_required";
    await this.continuation.resume(context, delivery);
    return "resumed";
  }

  private async rollbackForRetry(
    context: TenantContext,
    delivery: EngineeringDelivery,
    input: {
      readonly commandId: string;
      readonly repositoryRoot: string;
      readonly repositoryId: string;
      readonly cleanupLeaseCommandId?: string;
    },
    assertOwnership: (expectedDelivery?: EngineeringDelivery) => Promise<void>,
    cleanupAlreadyReleased: boolean,
  ): Promise<EngineeringDelivery> {
    await this.cleanup(
      context,
      delivery,
      input.repositoryRoot,
      input.repositoryId,
      undefined,
      input.cleanupLeaseCommandId,
      assertOwnership,
      cleanupAlreadyReleased,
    );
    return (
      await this.deliveries.resetForRetry(context, {
        commandId: `${input.commandId}:rollback-for-retry`,
        deliveryId: delivery.deliveryId,
        expectedVersion: delivery.version,
      })
    ).delivery;
  }

  private async cleanup(
    context: TenantContext,
    delivery: EngineeringDelivery,
    repositoryRoot: string,
    repositoryId: string,
    preserveLeaseCommandId?: string,
    cleanupLeaseCommandId?: string,
    assertOwnership: (expectedDelivery?: EngineeringDelivery) => Promise<void> = async () => undefined,
    cleanupAlreadyReleased = false,
  ): Promise<void> {
    if (cleanupAlreadyReleased) return;
    const leases = await this.leases.list(context, repositoryId);
    const releases: EngineeringPathLease[] = [];
    for (const lease of leases) {
      if (lease.deliveryId !== delivery.deliveryId || (lease.status !== "active" && lease.status !== "expired"))
        continue;
      if (lease.acquireCommandId === preserveLeaseCommandId) continue;
      if (cleanupLeaseCommandId !== undefined && lease.acquireCommandId !== cleanupLeaseCommandId) {
        throw new Error("Recovery cleanup path lease owner fence가 일치하지 않습니다");
      }
      releases.push(lease);
    }
    await assertOwnership(delivery);
    await this.workspaces.removeDeliveryWorkspaceIfExists({
      repositoryRoot,
      baseRevision: delivery.baseRevision,
      deliveryId: delivery.deliveryId,
    });
    for (const lease of releases) {
      await assertOwnership(delivery);
      await this.leases.release(context, {
        commandId: `${delivery.startCommandId}:recovery-release-lease:${lease.leaseId}`,
        leaseId: lease.leaseId,
        deliveryId: delivery.deliveryId,
        expectedAcquireCommandId: cleanupLeaseCommandId,
      });
    }
    const remaining = (await this.leases.list(context, repositoryId)).filter(
      (lease) =>
        lease.deliveryId === delivery.deliveryId &&
        (lease.status === "active" || lease.status === "expired") &&
        lease.acquireCommandId !== preserveLeaseCommandId,
    );
    if (remaining.length > 0) throw new Error("Recovery cleanup 뒤 active path lease가 남아 있습니다");
  }
}
