import type { EmergencyControl, ApprovalStore, AutonomyMode, AutonomyStore } from "@massion/governance";
import type { TenantContext } from "@massion/identity";
import type { AgentRunner, RuntimeExecutionStore } from "@massion/runtime";

import type { CoreWorkCoordinator } from "./core-work-coordinator.js";
import type { ApplicationRunStore } from "./run-store.js";

export interface AutonomyTransitionResult {
  readonly mode: AutonomyMode;
  readonly revision: number;
  readonly runtimePermissionStatus: "governed" | "full-access" | "limited";
  readonly limitedReason?: string;
}

export interface AutonomyTransitionInput {
  readonly mode: AutonomyMode;
  readonly expectedRevision: number;
}

/**
 * 자율성 변경 뒤 현재 실행과 승인 대기의 경계를 한 곳에서 정리합니다.
 * ponytail: 영속 transition table은 만들지 않고 기존 Approval·Run·Runtime·Emergency 계보를 재사용합니다.
 */
export class AutonomyTransitionCoordinator {
  public constructor(
    private readonly autonomy: Pick<AutonomyStore, "get" | "set">,
    private readonly approvals: Pick<ApprovalStore, "listPending" | "cancel">,
    private readonly runs: Pick<ApplicationRunStore, "findByApproval" | "claim">,
    private readonly workCoordinator: Pick<CoreWorkCoordinator, "reevaluateAwaitingApproval">,
    private readonly runtime: Pick<AgentRunner, "cancel" | "cancelOrganization">,
    private readonly runtimeExecutions: Pick<RuntimeExecutionStore, "listActiveByAutonomy">,
    private readonly emergency: Pick<EmergencyControl, "get" | "activate">,
  ) {}

  public async set(context: TenantContext, input: AutonomyTransitionInput): Promise<AutonomyTransitionResult> {
    const before = await this.autonomy.get(context);
    const state = await this.autonomy.set(context, input);
    try {
      if (state.mode === "full-access") await this.reconcilePending(context, state.revision);
      if (before.mode === "full-access" && state.mode !== "full-access") {
        await this.revokeRunning(context, before.mode, before.revision);
      }
      return {
        mode: state.mode,
        revision: state.revision,
        runtimePermissionStatus: state.mode === "full-access" ? "full-access" : "governed",
      };
    } catch (error) {
      const limitedReason = error instanceof Error ? error.message : "자율성 전환 정합성 복구에 실패했습니다";
      if (before.mode === "full-access" && state.mode !== "full-access") {
        await this.activateEmergencyIfNeeded(context, state.revision, limitedReason);
      }
      return {
        mode: state.mode,
        revision: state.revision,
        runtimePermissionStatus: "limited",
        limitedReason,
      };
    }
  }

  private async reconcilePending(context: TenantContext, revision: number): Promise<void> {
    const pending = await this.approvals.listPending(context);
    for (const approval of pending) {
      const link = await this.runs.findByApproval(context, approval.approval_id);
      if (link?.kind === "active" && link.run.status === "awaiting-approval") {
        const claim = await this.runs.claim(context, link.run.runId, {
          reevaluateAwaitingApproval: true,
          approvalId: approval.approval_id,
          retryAttemptId: `autonomy:${String(revision)}`,
        });
        if (claim.outcome !== "claimed") throw new Error("승인 대기 Application run 재평가 claim에 실패했습니다");
        await this.workCoordinator.reevaluateAwaitingApproval(
          context,
          link.run.runId,
          approval.approval_id,
          `autonomy:${String(revision)}`,
        );
        await this.cancelApproval(context, approval.approval_id, revision);
        continue;
      }
      if (approval.execution_id) {
        await this.runtime.cancel(context, approval.execution_id, "autonomy_changed");
        await this.cancelApproval(context, approval.approval_id, revision);
      }
    }
  }

  private async revokeRunning(
    context: TenantContext,
    previousMode: AutonomyMode,
    previousRevision: number,
  ): Promise<void> {
    await this.runtime.cancelOrganization(context, "autonomy_revoked");
    const active = await this.runtimeExecutions.listActiveByAutonomy(context, {
      mode: previousMode,
      revision: previousRevision,
    });
    await Promise.all(active.map((execution) => this.runtime.cancel(context, execution.execution_id, "autonomy_revoked")));
    const remaining = await this.runtimeExecutions.listActiveByAutonomy(context, {
      mode: previousMode,
      revision: previousRevision,
    });
    if (remaining.length > 0) throw new Error(`이전 자율성 revision ${String(previousRevision)} 실행이 남아 있습니다`);
  }

  private async cancelApproval(context: TenantContext, approvalId: string, revision: number): Promise<void> {
    await this.approvals.cancel(context, {
      commandId: `autonomy:${String(revision)}:approval:${approvalId}:cancel`,
      approvalId,
      reason: "자율성 모드 변경으로 기존 승인을 재평가했습니다",
    });
  }

  private async activateEmergencyIfNeeded(context: TenantContext, revision: number, reason: string): Promise<void> {
    const current = await this.emergency.get(context);
    if (current?.active) return;
    await this.emergency.activate(context, {
      commandId: `autonomy-revoke:${String(revision)}`,
      reason: `자율성 해제 회수 실패: ${reason}`,
    });
  }
}
