export const APPLICATION_SCHEMA_VERSION = "massion.application.v1" as const;
export const APPLICATION_EVENT_SCHEMA_VERSION = "massion.application.event.v1" as const;
export const APPLICATION_ERROR_SCHEMA_VERSION = "massion.error.v1" as const;

export type ApplicationCommandOutcome = "succeeded" | "accepted" | "awaiting-approval" | "blocked";
export type ApplicationAuthorKind = "user" | "agent" | "system";

export interface ApplicationResourceV1 {
  readonly type: string;
  readonly id: string;
  readonly revision?: number;
}

export interface ApplicationCommandV1 {
  readonly schemaVersion: typeof APPLICATION_SCHEMA_VERSION;
  readonly commandId: string;
  readonly correlationId: string;
  readonly operation: string;
  readonly expectedRevision?: number;
  readonly payload: unknown;
}

export interface ApplicationCommandResultV1 {
  readonly schemaVersion: typeof APPLICATION_SCHEMA_VERSION;
  readonly commandId: string;
  readonly correlationId: string;
  readonly operation: string;
  readonly outcome: ApplicationCommandOutcome;
  readonly resource?: ApplicationResourceV1;
  readonly data?: unknown;
}

export interface ApplicationEventV1 {
  readonly schemaVersion: typeof APPLICATION_EVENT_SCHEMA_VERSION;
  readonly eventId: string;
  readonly organizationId: string;
  readonly sequence: number;
  readonly type: string;
  readonly author: { readonly kind: ApplicationAuthorKind; readonly id: string };
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly resource?: ApplicationResourceV1;
  readonly occurredAt: string;
  readonly payload: unknown;
}

const COMMAND_FIELDS = new Set([
  "schemaVersion",
  "commandId",
  "correlationId",
  "operation",
  "expectedRevision",
  "payload",
]);
const RESULT_FIELDS = new Set([
  "schemaVersion",
  "commandId",
  "correlationId",
  "operation",
  "outcome",
  "resource",
  "data",
]);
const EVENT_FIELDS = new Set([
  "schemaVersion",
  "eventId",
  "organizationId",
  "sequence",
  "type",
  "author",
  "correlationId",
  "causationId",
  "resource",
  "occurredAt",
  "payload",
]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OPAQUE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const OPERATION = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;
const MAX_WIRE_BYTES = 1024 * 1024;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}은 object여야 합니다`);
  return value as Record<string, unknown>;
}

function exact(value: unknown, fields: ReadonlySet<string>, label: string): Record<string, unknown> {
  const candidate = record(value, label);
  const unknown = Object.keys(candidate).find((key) => !fields.has(key));
  if (unknown) throw new Error(`${label}에 알 수 없는 필드가 있습니다: ${unknown}`);
  return candidate;
}

function text(value: unknown, label: string, maximum = 64 * 1024): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} 문자열 길이가 유효하지 않습니다`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  const candidate = text(value, label, 128);
  if (!IDENTIFIER.test(candidate)) throw new Error(`${label}가 유효하지 않습니다`);
  return candidate;
}

function opaqueIdentifier(value: unknown, label: string): string {
  const candidate = text(value, label, 128);
  if (!OPAQUE_IDENTIFIER.test(candidate)) throw new Error(`${label}가 유효하지 않습니다`);
  return candidate;
}

function operation(value: unknown): string {
  const candidate = text(value, "operation", 128);
  if (!OPERATION.test(candidate)) throw new Error("operation이 유효하지 않습니다");
  return candidate;
}

function revision(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label}이 유효하지 않습니다`);
  return value as number;
}

function validateJson(value: unknown, depth = 0): void {
  if (depth > 20) throw new Error("Application wire 값의 깊이 상한을 초과했습니다");
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (typeof value === "string" && value.length > 64 * 1024) {
      throw new Error("Application wire 문자열 상한을 초과했습니다");
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Application wire number는 finite여야 합니다");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new Error("Application wire 배열 상한을 초과했습니다");
    for (const child of value) validateJson(child, depth + 1);
    return;
  }
  if (typeof value !== "object") throw new Error("Application wire 값은 JSON이어야 합니다");
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error("Application wire 값에 prototype key를 사용할 수 없습니다");
    }
    validateJson(child, depth + 1);
  }
}

function validateWire(value: unknown): void {
  if (value === undefined) throw new Error("Application wire 값은 JSON이어야 합니다");
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error("Application wire 값은 JSON으로 직렬화할 수 있어야 합니다");
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_WIRE_BYTES) {
    throw new Error("Application wire byte 상한을 초과했습니다");
  }
  validateJson(value);
}

function resource(value: unknown): ApplicationResourceV1 {
  const candidate = exact(value, new Set(["type", "id", "revision"]), "resource");
  const result: ApplicationResourceV1 = {
    type: identifier(candidate.type, "resource.type"),
    id: identifier(candidate.id, "resource.id"),
    ...(candidate.revision === undefined ? {} : { revision: revision(candidate.revision, "resource.revision", 0) }),
  };
  return result;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function validateApplicationCommand(value: unknown): ApplicationCommandV1 {
  validateWire(value);
  const candidate = exact(value, COMMAND_FIELDS, "Application command");
  if (candidate.schemaVersion !== APPLICATION_SCHEMA_VERSION)
    throw new Error("Application schemaVersion이 유효하지 않습니다");
  const result: ApplicationCommandV1 = {
    schemaVersion: APPLICATION_SCHEMA_VERSION,
    commandId: opaqueIdentifier(candidate.commandId, "commandId"),
    correlationId: opaqueIdentifier(candidate.correlationId, "correlationId"),
    operation: operation(candidate.operation),
    ...(candidate.expectedRevision === undefined
      ? {}
      : { expectedRevision: revision(candidate.expectedRevision, "expectedRevision", 0) }),
    payload: candidate.payload,
  };
  validateJson(result.payload);
  return deepFreeze(result);
}

export function validateApplicationResult(value: unknown): ApplicationCommandResultV1 {
  validateWire(value);
  const candidate = exact(value, RESULT_FIELDS, "Application result");
  if (candidate.schemaVersion !== APPLICATION_SCHEMA_VERSION)
    throw new Error("Application schemaVersion이 유효하지 않습니다");
  if (!(["succeeded", "accepted", "awaiting-approval", "blocked"] as const).includes(candidate.outcome as never)) {
    throw new Error("Application result outcome이 유효하지 않습니다");
  }
  const result: ApplicationCommandResultV1 = {
    schemaVersion: APPLICATION_SCHEMA_VERSION,
    commandId: opaqueIdentifier(candidate.commandId, "commandId"),
    correlationId: opaqueIdentifier(candidate.correlationId, "correlationId"),
    operation: operation(candidate.operation),
    outcome: candidate.outcome as ApplicationCommandOutcome,
    ...(candidate.resource === undefined ? {} : { resource: resource(candidate.resource) }),
    ...(candidate.data === undefined ? {} : { data: candidate.data }),
  };
  if (result.data !== undefined) validateJson(result.data);
  return deepFreeze(result);
}

export function validateApplicationEvent(value: unknown): ApplicationEventV1 {
  validateWire(value);
  const candidate = exact(value, EVENT_FIELDS, "Application event");
  if (candidate.schemaVersion !== APPLICATION_EVENT_SCHEMA_VERSION) {
    throw new Error("Application event schemaVersion이 유효하지 않습니다");
  }
  const author = exact(candidate.author, new Set(["kind", "id"]), "event.author");
  if (!(["user", "agent", "system"] as const).includes(author.kind as never)) {
    throw new Error("event.author.kind가 유효하지 않습니다");
  }
  const occurredAt = text(candidate.occurredAt, "occurredAt", 64);
  if (new Date(occurredAt).toISOString() !== occurredAt) throw new Error("occurredAt이 ISO datetime이 아닙니다");
  const result: ApplicationEventV1 = {
    schemaVersion: APPLICATION_EVENT_SCHEMA_VERSION,
    eventId: opaqueIdentifier(candidate.eventId, "eventId"),
    organizationId: identifier(candidate.organizationId, "organizationId"),
    sequence: revision(candidate.sequence, "sequence", 1),
    type: operation(candidate.type),
    author: { kind: author.kind as ApplicationAuthorKind, id: identifier(author.id, "event.author.id") },
    ...(candidate.correlationId === undefined
      ? {}
      : { correlationId: opaqueIdentifier(candidate.correlationId, "correlationId") }),
    ...(candidate.causationId === undefined
      ? {}
      : { causationId: opaqueIdentifier(candidate.causationId, "causationId") }),
    ...(candidate.resource === undefined ? {} : { resource: resource(candidate.resource) }),
    occurredAt,
    payload: candidate.payload,
  };
  validateJson(result.payload);
  return deepFreeze(result);
}
