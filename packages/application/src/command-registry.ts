import type { MembershipRole, TenantContext } from "@massion/identity";

import {
  type ApplicationCommandResultV1,
  type ApplicationCommandV1,
  validateApplicationCommand,
  validateApplicationResult,
} from "./contracts.js";
import { ApplicationError } from "./errors.js";
import type { ApplicationCommandStore } from "./command-store.js";

/**
 * 사용자에게는 고정된 내부 오류 문구만 나가므로 운영자가 원인을 볼 통로가 필요합니다.
 * 로그는 owner-only 파일로만 흐르고, 인증 헤더나 payload는 담지 않습니다.
 */
function logInternalCommandFailure(operation: string, error: ApplicationError, cause: unknown): void {
  const detail = cause instanceof Error ? cause : undefined;
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      event: "application.command.internal_failure",
      operation,
      errorId: error.errorId,
      category: detail?.name ?? typeof cause,
      reason: detail?.message ?? "",
    })}\n`,
  );
}

export interface ApplicationCommandDescriptor<Payload = unknown> {
  readonly operation: string;
  readonly requiredScopes: readonly string[];
  readonly allowedRoles: readonly MembershipRole[];
  readonly recovery: "replay-domain" | "operator-action";
  readonly retryFailedCommand?: boolean;
  idempotencyPayload?(payload: Payload): unknown;
  resumeAwaitingApproval?(payload: Payload): boolean;
  validate(payload: unknown): Payload;
  handle(context: TenantContext, command: ApplicationCommandV1, payload: Payload): Promise<ApplicationCommandResultV1>;
}

const OPERATION = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;
const SCOPE = /^(?:application:\*|[a-z][a-z0-9-]*:[a-z][a-z0-9-]*)$/u;

function applicationErrorFromStored(input: ReturnType<ApplicationError["publicView"]>): ApplicationError {
  return new ApplicationError({
    category: input.category,
    severity: input.severity,
    retryable: input.retryable,
    userMessage: input.userMessage,
    operatorCode: input.operatorCode,
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    ...(input.retryAfterMs === undefined ? {} : { retryAfterMs: input.retryAfterMs }),
  });
}

function commandValidationError(cause: unknown, correlationId?: string): ApplicationError {
  return new ApplicationError({
    category: "validation",
    severity: "error",
    retryable: false,
    userMessage: "Application command 입력이 유효하지 않습니다",
    operatorCode: "APP_COMMAND_VALIDATION",
    ...(correlationId === undefined ? {} : { correlationId }),
    cause,
  });
}

export class ApplicationCommandRegistry {
  private readonly descriptors = new Map<string, ApplicationCommandDescriptor>();

  public constructor(private readonly store: ApplicationCommandStore) {}

  public register<Payload>(descriptor: ApplicationCommandDescriptor<Payload>): void {
    if (!OPERATION.test(descriptor.operation)) throw new Error("Application command operation이 유효하지 않습니다");
    if (
      descriptor.requiredScopes.length === 0 ||
      descriptor.requiredScopes.some((scope) => !SCOPE.test(scope)) ||
      descriptor.allowedRoles.length === 0 ||
      !["replay-domain", "operator-action"].includes(descriptor.recovery) ||
      (descriptor.retryFailedCommand === true && descriptor.recovery !== "replay-domain")
    ) {
      throw new Error("Application command descriptor 권한이 불완전합니다");
    }
    if (this.descriptors.has(descriptor.operation)) throw new Error("Application command operation 중복입니다");
    this.descriptors.set(descriptor.operation, descriptor);
  }

  public async dispatch(
    context: TenantContext,
    callerScopes: readonly string[],
    input: unknown,
  ): Promise<ApplicationCommandResultV1> {
    let command: ApplicationCommandV1;
    try {
      command = validateApplicationCommand(input);
    } catch (error) {
      throw commandValidationError(error);
    }
    const descriptor = this.descriptors.get(command.operation);
    if (!descriptor) {
      throw new ApplicationError({
        category: "validation",
        severity: "error",
        retryable: false,
        userMessage: "지원하지 않는 Application operation입니다",
        operatorCode: "APP_OPERATION_UNKNOWN",
        correlationId: command.correlationId,
      });
    }
    if (
      !callerScopes.includes("application:*") &&
      descriptor.requiredScopes.some((scope) => !callerScopes.includes(scope))
    ) {
      throw new ApplicationError({
        category: "authorization",
        severity: "error",
        retryable: false,
        userMessage: "Application token scope가 부족합니다",
        operatorCode: "APP_SCOPE_REQUIRED",
        correlationId: command.correlationId,
      });
    }
    if (!descriptor.allowedRoles.includes(context.role)) {
      throw new ApplicationError({
        category: "authorization",
        severity: "error",
        retryable: false,
        userMessage: "조직 역할에 이 operation 권한이 없습니다",
        operatorCode: "APP_ROLE_REQUIRED",
        correlationId: command.correlationId,
      });
    }
    let payload: unknown;
    try {
      payload = descriptor.validate(command.payload);
    } catch (error) {
      throw commandValidationError(error, command.correlationId);
    }
    const identityCommand: ApplicationCommandV1 = {
      ...command,
      payload: descriptor.idempotencyPayload ? descriptor.idempotencyPayload(payload) : command.payload,
    };
    const claim = await this.store.begin(context, identityCommand, {
      resumeAwaitingApproval: descriptor.resumeAwaitingApproval?.(payload) ?? false,
      retryFailedCommand: descriptor.retryFailedCommand ?? false,
    });
    if (claim.outcome === "replayed") return claim.result;
    if (claim.outcome === "failed") throw applicationErrorFromStored(claim.error);
    if (claim.outcome === "in-progress") {
      throw new ApplicationError({
        category: "conflict",
        severity: "warning",
        retryable: true,
        userMessage: "같은 Application command가 실행 중입니다",
        operatorCode: "APP_COMMAND_IN_PROGRESS",
        correlationId: command.correlationId,
      });
    }
    if (claim.recovered && descriptor.recovery === "operator-action") {
      const blocked = validateApplicationResult({
        schemaVersion: "massion.application.v1",
        commandId: command.commandId,
        correlationId: command.correlationId,
        operation: command.operation,
        outcome: "blocked",
        data: { operatorActionRequired: true },
      });
      await this.store.complete(context, claim.commandRecordId, claim.leaseGeneration, blocked);
      return blocked;
    }
    try {
      const result = validateApplicationResult(await descriptor.handle(context, command, payload));
      await this.store.complete(context, claim.commandRecordId, claim.leaseGeneration, result);
      return result;
    } catch (error) {
      const applicationError =
        error instanceof ApplicationError ? error : ApplicationError.internal(error, command.correlationId);
      // 내부 오류는 사용자에게 고정 문구로만 나가므로, 원인을 남기지 않으면 어떤 500도 진단할 수 없습니다.
      if (applicationError.category === "internal")
        logInternalCommandFailure(command.operation, applicationError, error);
      await this.store
        .fail(context, claim.commandRecordId, claim.leaseGeneration, applicationError.publicView())
        .catch(() => undefined);
      throw applicationError;
    }
  }
}
