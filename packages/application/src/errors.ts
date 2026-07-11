import { randomUUID } from "node:crypto";

import { APPLICATION_ERROR_SCHEMA_VERSION } from "./contracts.js";

export type ApplicationErrorCategory =
  | "validation"
  | "authentication"
  | "authorization"
  | "policy"
  | "conflict"
  | "not-found"
  | "rate-limit"
  | "unavailable"
  | "internal";
export type ApplicationErrorSeverity = "info" | "warning" | "error" | "critical";

export interface ApplicationErrorInput {
  readonly category: ApplicationErrorCategory;
  readonly severity: ApplicationErrorSeverity;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly operatorCode: string;
  readonly correlationId?: string;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

export interface ApplicationErrorV1 {
  readonly schemaVersion: typeof APPLICATION_ERROR_SCHEMA_VERSION;
  readonly errorId: string;
  readonly category: ApplicationErrorCategory;
  readonly severity: ApplicationErrorSeverity;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly operatorCode: string;
  readonly correlationId?: string;
  readonly retryAfterMs?: number;
}

const HTTP_STATUS: Readonly<Record<ApplicationErrorCategory, number>> = {
  validation: 400,
  authentication: 401,
  authorization: 403,
  policy: 403,
  conflict: 409,
  "not-found": 404,
  "rate-limit": 429,
  unavailable: 503,
  internal: 500,
};
const CLI_EXIT: Readonly<Record<ApplicationErrorCategory, number>> = {
  validation: 2,
  authentication: 3,
  authorization: 4,
  policy: 4,
  conflict: 5,
  "not-found": 6,
  "rate-limit": 7,
  unavailable: 7,
  internal: 70,
};

function safeText(value: string, fallback: string): string {
  let normalized = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (!((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127)) {
      normalized += character;
    }
  }
  const cleaned = normalized.trim();
  return cleaned.length > 0 && cleaned.length <= 1024 ? cleaned : fallback;
}

export class ApplicationError extends Error {
  public readonly errorId: string;
  public readonly category: ApplicationErrorCategory;
  public readonly severity: ApplicationErrorSeverity;
  public readonly retryable: boolean;
  public readonly userMessage: string;
  public readonly operatorCode: string;
  public readonly correlationId: string | undefined;
  public readonly retryAfterMs: number | undefined;

  public constructor(input: ApplicationErrorInput) {
    super(input.userMessage, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "ApplicationError";
    this.errorId = randomUUID();
    this.category = input.category;
    this.severity = input.severity;
    this.retryable = input.retryable;
    this.userMessage = safeText(input.userMessage, "요청을 처리할 수 없습니다");
    this.operatorCode = safeText(input.operatorCode, "APP_ERROR");
    this.correlationId = input.correlationId;
    this.retryAfterMs = input.retryAfterMs;
  }

  public static internal(cause: unknown, correlationId?: string): ApplicationError {
    return new ApplicationError({
      category: "internal",
      severity: "error",
      retryable: false,
      userMessage: "내부 오류로 요청을 처리하지 못했습니다",
      operatorCode: "APP_INTERNAL",
      ...(correlationId === undefined ? {} : { correlationId }),
      cause,
    });
  }

  public publicView(): ApplicationErrorV1 {
    return {
      schemaVersion: APPLICATION_ERROR_SCHEMA_VERSION,
      errorId: this.errorId,
      category: this.category,
      severity: this.severity,
      retryable: this.retryable,
      userMessage: this.userMessage,
      operatorCode: this.operatorCode,
      ...(this.correlationId === undefined ? {} : { correlationId: this.correlationId }),
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
    };
  }
}

export function applicationErrorToHttpStatus(error: ApplicationError): number {
  return HTTP_STATUS[error.category];
}

export function applicationErrorToCliExitCode(error: ApplicationError): number {
  return CLI_EXIT[error.category];
}
