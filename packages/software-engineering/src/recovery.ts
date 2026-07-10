import { createHash } from "node:crypto";

import type { TenantContext } from "@massion/identity";

import type { EngineeringDelivery } from "./contracts.js";
import { EngineeringDeliveryStore } from "./delivery-store.js";
import { GitWorkspaceManager } from "./git-workspace.js";
import type { EngineeringMetricStore } from "./metrics.js";
import { EngineeringPathLeaseStore } from "./path-lease.js";
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
    await this.workspaces.verifyRepositoryRoot(input.repositoryRoot, delivery.repositoryRootRealPathHash);
    let result: EngineeringRecoveryResult;
    if (delivery.status === "preparing") {
      delivery = await this.fail(
        context,
        delivery,
        "recovery_preparing_interrupted",
        "workspace 준비가 완료되지 않았습니다",
      );
      result = "cleaned_terminal";
    } else if (delivery.status === "green_verified") {
      let branch;
      let branchInspectionError: unknown;
      try {
        branch = await this.workspaces.inspectDeliveryBranch({
          repositoryRoot: input.repositoryRoot,
          baseRevision: delivery.baseRevision,
          deliveryId: delivery.deliveryId,
        });
      } catch (error) {
        branchInspectionError = error;
      }
      if (branchInspectionError) {
        const detail =
          branchInspectionError instanceof Error ? branchInspectionError.message : "알 수 없는 branch 검사 실패";
        delivery = await this.fail(context, delivery, "recovery_branch_invalid", detail);
        result = "cleaned_terminal";
      } else if (branch) {
        if (branch.changeSetHash !== delivery.implementationPatchHash) {
          delivery = await this.fail(
            context,
            delivery,
            "recovery_branch_mismatch",
            "Delivery branch tree가 저장된 implementation change set과 다릅니다",
          );
          result = "cleaned_terminal";
        } else {
          await this.deliveries.recordFileChanges(context, delivery.deliveryId, branch.fileChanges);
          const validationEvidenceIds = await this.deliveries.listCommandEvidenceIds(
            context,
            delivery.deliveryId,
            "validation",
          );
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
            })
          ).delivery;
          result = "reconciled_commit";
        }
      } else {
        const verified = await this.verifyWorkspaceStage(input.repositoryRoot, delivery);
        if (verified) result = await this.resume(context, delivery);
        else {
          delivery = await this.fail(
            context,
            delivery,
            "recovery_workspace_mismatch",
            "GREEN workspace와 implementation change set이 일치하지 않습니다",
          );
          result = "cleaned_terminal";
        }
      }
    } else if (["test_applied", "red_verified", "implementation_applied"].includes(delivery.status)) {
      const verified = await this.verifyWorkspaceStage(input.repositoryRoot, delivery);
      if (verified) result = await this.resume(context, delivery);
      else {
        delivery = await this.fail(
          context,
          delivery,
          "recovery_workspace_mismatch",
          `${delivery.status} workspace와 저장된 change set이 일치하지 않습니다`,
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
      await this.cleanup(context, delivery, input.repositoryRoot, input.repositoryId);
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
  ): Promise<EngineeringDelivery> {
    return (
      await this.deliveries.transition(context, {
        commandId: `${delivery.startCommandId}:${category}`,
        deliveryId: delivery.deliveryId,
        expectedVersion: delivery.version,
        target: "failed",
        error: { category, causeId: recoveryCauseId(category, detail) },
      })
    ).delivery;
  }

  private async resume(context: TenantContext, delivery: EngineeringDelivery): Promise<EngineeringRecoveryResult> {
    if (!this.continuation) return "resume_required";
    await this.continuation.resume(context, delivery);
    return "resumed";
  }

  private async cleanup(
    context: TenantContext,
    delivery: EngineeringDelivery,
    repositoryRoot: string,
    repositoryId: string,
  ): Promise<void> {
    for (const lease of await this.leases.list(context, repositoryId)) {
      if (lease.deliveryId !== delivery.deliveryId || lease.status !== "active") continue;
      await this.leases.release(context, {
        commandId: `${delivery.startCommandId}:recovery-release-lease`,
        leaseId: lease.leaseId,
        deliveryId: delivery.deliveryId,
      });
    }
    await this.workspaces.removeDeliveryWorkspaceIfExists({
      repositoryRoot,
      baseRevision: delivery.baseRevision,
      deliveryId: delivery.deliveryId,
    });
  }
}
