import { describe, expect, it } from "vitest";

import {
  APPLICATION_SCHEMA_VERSION,
  validateApplicationCommand,
  validateApplicationEvent,
  validateApplicationResult,
} from "./contracts.js";
import { ApplicationError, applicationErrorToCliExitCode, applicationErrorToHttpStatus } from "./errors.js";

const command = {
  schemaVersion: "massion.application.v1",
  commandId: "command-01hz7w4dqj7cn1",
  correlationId: "correlation-01hz7w4dqj7cn1",
  operation: "work.create",
  expectedRevision: 3,
  payload: { text: "제품을 완성해 주세요" },
} as const;

describe("Application wire contracts", () => {
  it("strict command·result·event를 검증하고 외부 입력을 재귀적으로 동결한다", () => {
    const parsed = validateApplicationCommand(command);
    expect(parsed.schemaVersion).toBe(APPLICATION_SCHEMA_VERSION);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.payload)).toBe(true);

    expect(
      validateApplicationResult({
        schemaVersion: APPLICATION_SCHEMA_VERSION,
        commandId: command.commandId,
        correlationId: command.correlationId,
        operation: command.operation,
        outcome: "succeeded",
        resource: { type: "Work", id: "work-1", revision: 1 },
        data: { workId: "work-1" },
      }),
    ).toMatchObject({ outcome: "succeeded" });
    expect(
      validateApplicationEvent({
        schemaVersion: "massion.application.event.v1",
        eventId: "event-01hz7w4dqj7cn1",
        organizationId: "organization-1",
        sequence: 1,
        type: "work.created",
        author: { kind: "user", id: "user-1" },
        correlationId: command.correlationId,
        resource: { type: "Work", id: "work-1", revision: 1 },
        occurredAt: "2026-07-11T00:00:00.000Z",
        payload: { status: "draft" },
      }),
    ).toMatchObject({ sequence: 1 });
  });

  it("unknown field·prototype key·non-finite number·깊이·배열·byte 상한을 거부한다", () => {
    expect(() => validateApplicationCommand({ ...command, surprise: true })).toThrow("알 수 없는");
    expect(() =>
      validateApplicationCommand({ ...command, payload: JSON.parse('{"__proto__":{"polluted":true}}') }),
    ).toThrow("prototype");
    expect(() => validateApplicationCommand({ ...command, expectedRevision: Number.NaN })).toThrow("finite");
    let deep: unknown = "value";
    for (let index = 0; index < 22; index += 1) deep = { child: deep };
    expect(() => validateApplicationCommand({ ...command, payload: deep })).toThrow("깊이");
    expect(() => validateApplicationCommand({ ...command, payload: Array.from({ length: 1_001 }, () => 1) })).toThrow(
      "배열",
    );
    expect(() => validateApplicationCommand({ ...command, payload: { text: "x".repeat(1024 * 1024) } })).toThrow(
      "byte",
    );
  });

  it("operation·식별자·시간·resource의 잘못된 형태를 거부한다", () => {
    expect(() => validateApplicationCommand({ ...command, operation: "DROP TABLE" })).toThrow("operation");
    expect(() => validateApplicationCommand({ ...command, commandId: "x" })).toThrow("commandId");
    expect(() =>
      validateApplicationEvent({
        schemaVersion: "massion.application.event.v1",
        eventId: "event-valid-12345678",
        organizationId: "organization-1",
        sequence: 0,
        type: "work.created",
        author: { kind: "root", id: "root" },
        occurredAt: "today",
        payload: {},
      }),
    ).toThrow();
  });
});

describe("Application errors", () => {
  it.each([
    ["validation", 400, 2],
    ["authentication", 401, 3],
    ["authorization", 403, 4],
    ["policy", 403, 4],
    ["conflict", 409, 5],
    ["not-found", 404, 6],
    ["rate-limit", 429, 7],
    ["unavailable", 503, 7],
    ["internal", 500, 70],
  ] as const)("%s category를 HTTP %i·CLI %i로 고정한다", (category, http, cli) => {
    const error = new ApplicationError({
      category,
      severity: "error",
      retryable: category === "rate-limit" || category === "unavailable",
      userMessage: "요청을 처리할 수 없습니다",
      operatorCode: `APP_${category.toUpperCase().replace("-", "_")}`,
    });
    expect(applicationErrorToHttpStatus(error)).toBe(http);
    expect(applicationErrorToCliExitCode(error)).toBe(cli);
    expect(error.publicView()).not.toHaveProperty("stack");
  });

  it("내부 cause·secret·path를 public error에 노출하지 않는다", () => {
    const cause = new Error("postgres://root:secret@localhost/db /Users/private/key Bearer abcdefghijklmnop");
    const error = ApplicationError.internal(cause, "correlation-safe-12345678");
    const encoded = JSON.stringify(error.publicView());
    expect(encoded).not.toContain("postgres");
    expect(encoded).not.toContain("secret");
    expect(encoded).not.toContain("/Users");
    expect(encoded).not.toContain("Bearer");
    expect(encoded).not.toContain("stack");
  });
});
