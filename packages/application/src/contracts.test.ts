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

  it("실제 delivery 재시도 계보의 140자 event correlationId를 허용한다", () => {
    const correlationId =
      "14000000-0000-4000-8000-000000000001:delivery:retry:14000000-0000-4000-8000-000000000002:task:14000000-0000-4000-8000-000000000003:completed";

    expect(correlationId).toHaveLength(140);
    expect(
      validateApplicationEvent({
        schemaVersion: "massion.application.event.v1",
        eventId: "event-delivery-retry-0001",
        organizationId: "organization-1",
        sequence: 640,
        type: "task.completed",
        author: { kind: "system", id: "system-1" },
        correlationId,
        occurredAt: "2026-08-02T00:00:00.000Z",
        payload: {},
      }),
    ).toMatchObject({ correlationId, sequence: 640 });
  });

  it("Application event correlationId는 256자까지 허용하고 257자를 거부한다", () => {
    const event = {
      schemaVersion: "massion.application.event.v1",
      eventId: "event-correlation-boundary-0001",
      organizationId: "organization-1",
      sequence: 1,
      type: "work.created",
      author: { kind: "system", id: "system-1" },
      occurredAt: "2026-08-02T00:00:00.000Z",
      payload: {},
    } as const;

    expect(validateApplicationEvent({ ...event, correlationId: "a".repeat(256) }).correlationId).toHaveLength(256);
    expect(() => validateApplicationEvent({ ...event, correlationId: "a".repeat(257) })).toThrow("correlationId");
    expect(() => validateApplicationEvent({ ...event, correlationId: `${"a".repeat(255)}/` })).toThrow("correlationId");
  });

  it("event correlationId 외 opaque 식별자는 128자 상한을 유지한다", () => {
    const atLimit = "a".repeat(128);
    const overLimit = "a".repeat(129);
    const result = {
      schemaVersion: APPLICATION_SCHEMA_VERSION,
      commandId: atLimit,
      correlationId: atLimit,
      operation: command.operation,
      outcome: "succeeded",
    } as const;
    const event = {
      schemaVersion: "massion.application.event.v1",
      eventId: atLimit,
      organizationId: "organization-1",
      sequence: 1,
      type: "work.created",
      author: { kind: "system", id: "system-1" },
      causationId: atLimit,
      occurredAt: "2026-08-02T00:00:00.000Z",
      payload: {},
    } as const;

    expect(validateApplicationCommand({ ...command, commandId: atLimit, correlationId: atLimit })).toMatchObject({
      commandId: atLimit,
      correlationId: atLimit,
    });
    expect(() => validateApplicationCommand({ ...command, commandId: overLimit })).toThrow("commandId");
    expect(() => validateApplicationCommand({ ...command, correlationId: overLimit })).toThrow("correlationId");
    expect(validateApplicationResult(result)).toMatchObject({ commandId: atLimit, correlationId: atLimit });
    expect(() => validateApplicationResult({ ...result, commandId: overLimit })).toThrow("commandId");
    expect(() => validateApplicationResult({ ...result, correlationId: overLimit })).toThrow("correlationId");
    expect(validateApplicationEvent(event)).toMatchObject({ eventId: atLimit, causationId: atLimit });
    expect(() => validateApplicationEvent({ ...event, eventId: overLimit })).toThrow("eventId");
    expect(() => validateApplicationEvent({ ...event, causationId: overLimit })).toThrow("causationId");
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
