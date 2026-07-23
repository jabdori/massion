import type { TenantContext } from "@massion/identity";

import type { ApplicationCommandRegistry } from "./command-registry.js";
import type { ApplicationCommandResultV1, ApplicationCommandV1 } from "./contracts.js";
import { ApplicationError } from "./errors.js";
import type { ApplicationRunStore } from "./run-store.js";
import type { WorkDirectiveMode, WorkDirectiveStore } from "./work-directive-store.js";

interface WorkDirectiveCommandDependencies {
  readonly directives: Pick<WorkDirectiveStore, "submit">;
  readonly runs: Pick<ApplicationRunStore, "get">;
  readonly schedule: (context: TenantContext, runId: string) => void | Promise<void>;
}

interface WorkDirectivePayload {
  readonly workId: string;
  readonly runId: string;
  readonly content: string;
  readonly mode: WorkDirectiveMode;
}

function payload(value: unknown): WorkDirectivePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Work directive payload는 object여야 합니다");
  }
  const record = value as Record<string, unknown>;
  const allowed = ["workId", "runId", "content", "mode"];
  const extra = Object.keys(record).find((key) => !allowed.includes(key));
  if (extra) throw new Error(`Work directive payload에 알 수 없는 필드가 있습니다: ${extra}`);
  const identifier = (input: unknown, label: string): string => {
    if (typeof input !== "string" || input.length < 8 || input.length > 128) {
      throw new Error(`${label}가 유효하지 않습니다`);
    }
    return input;
  };
  if (
    typeof record.content !== "string" ||
    !record.content.trim() ||
    Buffer.byteLength(record.content.trim(), "utf8") > 64 * 1024 ||
    /\0/u.test(record.content)
  ) {
    throw new Error("Work directive content가 유효하지 않습니다");
  }
  if (record.mode !== "now" && record.mode !== "next-stage") {
    throw new Error("Work directive mode가 유효하지 않습니다");
  }
  return {
    workId: identifier(record.workId, "workId"),
    runId: identifier(record.runId, "runId"),
    content: record.content.trim(),
    mode: record.mode,
  };
}

function revision(command: ApplicationCommandV1): number {
  if (command.expectedRevision === undefined) throw new Error("expectedRevision이 필요합니다");
  return command.expectedRevision;
}

function directiveError(error: unknown, correlationId: string): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/expectedRevision.*필요/iu.test(message)) {
    throw new ApplicationError({
      category: "validation",
      severity: "error",
      retryable: false,
      userMessage: "expectedRevision이 필요합니다",
      operatorCode: "APP_WORK_DIRECTIVE_REVISION_REQUIRED",
      correlationId,
      cause: error,
    });
  }
  if (/종료된/iu.test(message)) {
    throw new ApplicationError({
      category: "validation",
      severity: "warning",
      retryable: false,
      userMessage: "이 실행은 종료되었습니다. work.follow-up으로 후속 Work를 생성해주세요",
      operatorCode: "APP_WORK_DIRECTIVE_TERMINAL",
      correlationId,
      cause: error,
    });
  }
  if (/revision/iu.test(message)) {
    throw new ApplicationError({
      category: "conflict",
      severity: "warning",
      retryable: true,
      userMessage: "실행 상태가 바뀌었습니다. 최신 상태를 읽은 뒤 다시 지시해주세요",
      operatorCode: "APP_WORK_DIRECTIVE_REVISION_CONFLICT",
      correlationId,
      cause: error,
    });
  }
  if (/찾을 수 없|연결/iu.test(message)) {
    throw new ApplicationError({
      category: "not-found",
      severity: "error",
      retryable: false,
      userMessage: "지시할 Work와 실행 연결을 찾을 수 없습니다",
      operatorCode: "APP_WORK_DIRECTIVE_TARGET_NOT_FOUND",
      correlationId,
      cause: error,
    });
  }
  throw error;
}

function result(command: ApplicationCommandV1, directive: Awaited<ReturnType<WorkDirectiveStore["submit"]>>): ApplicationCommandResultV1 {
  return {
    schemaVersion: "massion.application.v1",
    commandId: command.commandId,
    correlationId: command.correlationId,
    operation: command.operation,
    outcome: "accepted",
    resource: { type: "WorkDirective", id: directive.directiveId, revision: directive.leaseGeneration },
    data: {
      directiveId: directive.directiveId,
      workId: directive.workId,
      runId: directive.runId,
      status: directive.status,
      mode: directive.mode,
      sequence: directive.sequence,
    },
  };
}

export function registerWorkDirectiveCommands(
  registry: ApplicationCommandRegistry,
  dependencies: WorkDirectiveCommandDependencies,
): void {
  registry.register({
    operation: "work.directive.submit",
    requiredScopes: ["work:write"],
    allowedRoles: ["owner", "admin", "member"],
    recovery: "replay-domain",
    validate: payload,
    async handle(context, command, value) {
      try {
        const directive = await dependencies.directives.submit(context, {
          commandId: command.commandId,
          correlationId: command.correlationId,
          expectedRevision: revision(command),
          ...value,
        });
        const run = await dependencies.runs.get(context, value.runId);
        if (run.status === "ready") await dependencies.schedule(context, run.runId);
        return result(command, directive);
      } catch (error) {
        return directiveError(error, command.correlationId);
      }
    },
  });
}
