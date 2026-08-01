import type { TenantContext } from "@massion/identity";

import type { ApplicationCommandRegistry } from "./command-registry.js";
import type { ApplicationCommandResultV1, ApplicationCommandV1 } from "./contracts.js";
import type { CoreWorkCoordinator } from "./core-work-coordinator.js";
import type { ApplicationRunStore } from "./run-store.js";

interface ApprovalVoteRecord {
  readonly approval_id: string;
  readonly status: string;
  readonly revision: number;
  readonly execution_id?: string;
  readonly resume_target?: string;
}

interface ApprovalCommandDependencies {
  readonly approvals: {
    vote(
      context: TenantContext,
      input: {
        readonly commandId: string;
        readonly approvalId: string;
        readonly expectedRevision: number;
        readonly vote: "approve" | "reject";
        readonly reason: string;
      },
    ): Promise<ApprovalVoteRecord>;
  };
  readonly runs: Pick<ApplicationRunStore, "findByApproval" | "prepareApprovalResume">;
  readonly coordinator: Pick<CoreWorkCoordinator, "recover">;
  readonly runtime?: {
    resume(context: TenantContext, executionId: string, input?: unknown): Promise<unknown>;
  };
  readonly schedule: (context: TenantContext, continuation: () => Promise<void>) => void;
}

interface ApprovalDecidePayload {
  readonly approvalId: string;
  readonly expectedApprovalRevision: number;
  readonly vote: "approve" | "reject";
  readonly reason: string;
}

function payload(value: unknown): ApprovalDecidePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Approval decide payload는 object여야 합니다");
  }
  const record = value as Record<string, unknown>;
  const fields = ["approvalId", "expectedApprovalRevision", "vote", "reason"];
  const extra = Object.keys(record).find((key) => !fields.includes(key));
  if (extra) throw new Error(`Approval decide payload에 알 수 없는 필드가 있습니다: ${extra}`);
  if (Object.keys(record).length !== fields.length || fields.some((field) => record[field] === undefined)) {
    throw new Error("Approval decide payload는 정확히 네 필드가 필요합니다");
  }
  if (typeof record.approvalId !== "string" || record.approvalId.length < 8 || record.approvalId.length > 128) {
    throw new Error("approvalId가 유효하지 않습니다");
  }
  if (!Number.isSafeInteger(record.expectedApprovalRevision) || (record.expectedApprovalRevision as number) < 1) {
    throw new Error("expectedApprovalRevision이 유효하지 않습니다");
  }
  if (record.vote !== "approve" && record.vote !== "reject") throw new Error("vote가 유효하지 않습니다");
  if (
    typeof record.reason !== "string" ||
    record.reason.trim().length === 0 ||
    Buffer.byteLength(record.reason, "utf8") > 4_096 ||
    /\0/u.test(record.reason)
  ) {
    throw new Error("reason이 유효하지 않습니다");
  }
  return record as unknown as ApprovalDecidePayload;
}

function result(command: ApplicationCommandV1, voted: ApprovalVoteRecord): ApplicationCommandResultV1 {
  return {
    schemaVersion: "massion.application.v1",
    commandId: command.commandId,
    correlationId: command.correlationId,
    operation: command.operation,
    outcome: "succeeded",
    resource: { type: "Approval", id: voted.approval_id, revision: voted.revision },
    data: { approvalId: voted.approval_id, status: voted.status, revision: voted.revision },
  };
}

async function prepareTerminalDecision(
  context: TenantContext,
  dependencies: ApprovalCommandDependencies,
  voted: ApprovalVoteRecord,
): Promise<(() => Promise<void>) | undefined> {
  if (voted.status !== "approved" && voted.status !== "rejected") return undefined;
  if (voted.resume_target !== undefined && voted.resume_target !== "runtime-subscription") {
    throw new Error("Approval 재개 대상이 유효하지 않습니다");
  }
  if (voted.resume_target === "runtime-subscription") {
    if (!dependencies.runtime || !voted.execution_id) {
      throw new Error("runtime-subscription Approval 재개 대상이 구성되지 않았습니다");
    }
    await dependencies.runtime.resume(context, voted.execution_id, { approvalId: voted.approval_id });
    return undefined;
  }

  const link = await dependencies.runs.findByApproval(context, voted.approval_id);
  if (!link) return undefined;
  const run = link.run;
  if (run.organizationId !== context.organizationId) {
    throw new Error("Approval에 연결된 Application run 조직이 일치하지 않습니다");
  }
  if (link.approvalId !== voted.approval_id) {
    throw new Error("Application run의 Approval 연결이 일치하지 않습니다");
  }
  if (link.kind === "historical") return undefined;
  if (link.kind === "active" && (run.status !== "awaiting-approval" || run.approvalId !== voted.approval_id)) {
    throw new Error("Application run의 Approval 연결이 일치하지 않습니다");
  }
  const prepared =
    link.kind === "active" ? await dependencies.runs.prepareApprovalResume(context, run.runId, voted.approval_id) : run;
  if (prepared.organizationId !== context.organizationId || prepared.resumeInput?.approvalId !== voted.approval_id) {
    throw new Error("Application run의 영속 승인 재개 입력이 일치하지 않습니다");
  }
  if (prepared.status !== "ready" && prepared.status !== "running") return undefined;
  return async () => {
    await dependencies.coordinator.recover(context, prepared.runId);
  };
}

export function registerApplicationApprovalCommands(
  registry: ApplicationCommandRegistry,
  dependencies: ApprovalCommandDependencies,
): void {
  registry.register({
    operation: "approval.decide",
    requiredScopes: ["approval:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    retryFailedCommand: true,
    validate: payload,
    async handle(context, command, value) {
      const voted = await dependencies.approvals.vote(context, {
        commandId: command.commandId,
        approvalId: value.approvalId,
        expectedRevision: value.expectedApprovalRevision,
        vote: value.vote,
        reason: value.reason,
      });
      if (voted.approval_id !== value.approvalId) {
        throw new Error("Approval 결과가 요청한 Approval과 일치하지 않습니다");
      }
      const continuation = await prepareTerminalDecision(context, dependencies, voted);
      if (continuation) dependencies.schedule(context, continuation);
      return result(command, voted);
    },
  });
}
