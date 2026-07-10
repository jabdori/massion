import type { TenantContext } from "@massion/identity";

import { ApprovalStore } from "./approval-store.js";

export interface PendingApprovalRecovery {
  readonly approvalId: string;
  readonly decisionId: string;
  readonly workId?: string;
  readonly executionId?: string;
  readonly status: "pending";
}

export class ApprovalRecovery {
  public constructor(private readonly approvals: ApprovalStore) {}

  public async recover(context: TenantContext): Promise<PendingApprovalRecovery[]> {
    const pending = await this.approvals.listPending(context);
    const recovered: PendingApprovalRecovery[] = [];
    for (const candidate of pending) {
      const current = await this.approvals.expire(context, candidate.approval_id);
      if (current.status !== "pending") continue;
      recovered.push({
        approvalId: current.approval_id,
        decisionId: current.decision_id,
        ...(current.work_id ? { workId: current.work_id } : {}),
        ...(current.execution_id ? { executionId: current.execution_id } : {}),
        status: "pending",
      });
    }
    return recovered;
  }
}
