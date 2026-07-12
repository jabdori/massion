import { sign } from "node:crypto";

import { createHeartbeatSignaturePayload, type ConnectorRequest } from "@massion/subscriptions";

import { EDGE_CONNECTOR_VERSION, type ActiveConnectorIdentity } from "./identity-store.js";

export const CONNECTOR_PROTOCOL = "massion.connector.v1" as const;
export const CONNECTOR_FRAME_MAX_BYTES = 1024 * 1024;
export const CONNECTOR_REQUEST_MAX_BYTES = 16 * 1024 * 1024;

export interface ConnectorHandshakeFrame {
  readonly protocol: typeof CONNECTOR_PROTOCOL;
  readonly type: "handshake";
  readonly organizationId: string;
  readonly connectorId: string;
  readonly nonce: string;
  readonly observedAt: string;
  readonly signature: string;
}

export interface ConnectorHeartbeatFrame {
  readonly protocol: typeof CONNECTOR_PROTOCOL;
  readonly type: "heartbeat";
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly observedAt: string;
  readonly profileHealthObservedAt: string;
  readonly nonce: string;
  readonly signature: string;
}

export interface ConnectorReadyFrame {
  readonly protocol: typeof CONNECTOR_PROTOCOL;
  readonly type: "ready";
}

export interface ConnectorRequestFrame extends ConnectorRequest {
  readonly type: "request";
}

export interface ConnectorCancelFrame {
  readonly protocol: typeof CONNECTOR_PROTOCOL;
  readonly type: "cancel";
  readonly requestId: string;
  readonly leaseId: string;
  readonly reason: "aborted" | "timeout" | "consumer-closed" | "shutdown";
}

export interface ConnectorEventFrame {
  readonly protocol: typeof CONNECTOR_PROTOCOL;
  readonly type: "event";
  readonly requestId: string;
  readonly leaseId: string;
  readonly sequence: number;
  readonly kind: "data" | "usage" | "error" | "done";
  readonly payload: unknown;
}

export type ConnectorServerFrame = ConnectorReadyFrame | ConnectorRequestFrame | ConnectorCancelFrame;

function text(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string") throw new Error(`${label}이 유효하지 않습니다`);
  const normalized = value.trim();
  let hasControlCharacter = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    if (code <= 31 || code === 127) hasControlCharacter = true;
  }
  if (!normalized || normalized.length > maximum || hasControlCharacter) {
    throw new Error(`${label}이 유효하지 않습니다`);
  }
  return normalized;
}

function safeJson(value: unknown, depth = 0): void {
  if (depth > 32) throw new Error("Connector frame JSON 깊이 상한을 초과했습니다");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Connector frame 숫자가 유효하지 않습니다");
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) safeJson(child, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") throw new Error("Connector frame JSON 값이 유효하지 않습니다");
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("Connector frame object가 유효하지 않습니다");
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error("Connector frame에 금지된 object key가 있습니다");
    }
    safeJson(child, depth + 1);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}이 유효하지 않습니다`);
  safeJson(value);
  return value as Record<string, unknown>;
}

function exact(source: Readonly<Record<string, unknown>>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(source).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label}에 알 수 없는 필드가 있습니다: ${unknown}`);
  const missing = fields.find((key) => source[key] === undefined);
  if (missing) throw new Error(`${label} 필드가 필요합니다: ${missing}`);
}

function parseJson(encoded: Uint8Array): Record<string, unknown> {
  if (encoded.byteLength > CONNECTOR_REQUEST_MAX_BYTES) throw new Error("Connector 요청 byte 상한을 초과했습니다");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded).toString("utf8")) as unknown;
  } catch {
    throw new Error("Connector frame JSON이 유효하지 않습니다");
  }
  return record(value, "Connector frame");
}

function encode(value: unknown): Buffer {
  safeJson(value);
  const encoded = Buffer.from(JSON.stringify(value), "utf8");
  if (encoded.byteLength > CONNECTOR_FRAME_MAX_BYTES) throw new Error("Connector event byte 상한을 초과했습니다");
  return encoded;
}

export function createHandshakeSignaturePayload(input: Omit<ConnectorHandshakeFrame, "signature">): Buffer {
  return Buffer.from(
    [input.protocol, input.type, input.organizationId, input.connectorId, input.nonce, input.observedAt].join("\n"),
    "utf8",
  );
}

export function createSignedHandshake(
  identity: ActiveConnectorIdentity,
  observedAt: string,
  nonce: string,
): ConnectorHandshakeFrame {
  const unsigned = {
    protocol: CONNECTOR_PROTOCOL,
    type: "handshake" as const,
    organizationId: text(identity.organizationId, "조직 ID"),
    connectorId: text(identity.connectorId, "Connector ID"),
    nonce: text(nonce, "Handshake nonce"),
    observedAt: text(observedAt, "Handshake 시각"),
  };
  if (unsigned.nonce.length < 16) throw new Error("Handshake nonce 길이가 유효하지 않습니다");
  return {
    ...unsigned,
    signature: sign(null, createHandshakeSignaturePayload(unsigned), identity.privateKey).toString("base64url"),
  };
}

export function createSignedHeartbeat(
  identity: ActiveConnectorIdentity,
  observedAt: string,
  profileHealthObservedAt: string,
  nonce: string,
): ConnectorHeartbeatFrame {
  const unsigned = {
    organizationId: text(identity.organizationId, "조직 ID"),
    connectorId: text(identity.connectorId, "Connector ID"),
    version: EDGE_CONNECTOR_VERSION,
    capabilities: [...new Set(identity.capabilities.map((capability) => text(capability, "Capability")))].sort(),
    observedAt: text(observedAt, "Heartbeat 시각"),
    profileHealthObservedAt: text(profileHealthObservedAt, "Provider profile 건강 증명 시각"),
    nonce: text(nonce, "Heartbeat nonce"),
  };
  if (unsigned.nonce.length < 16) throw new Error("Heartbeat nonce 길이가 유효하지 않습니다");
  return {
    protocol: CONNECTOR_PROTOCOL,
    type: "heartbeat",
    version: unsigned.version,
    capabilities: unsigned.capabilities,
    observedAt: unsigned.observedAt,
    profileHealthObservedAt: unsigned.profileHealthObservedAt,
    nonce: unsigned.nonce,
    signature: sign(null, createHeartbeatSignaturePayload(unsigned), identity.privateKey).toString("base64url"),
  };
}

export class ConnectorClientFrameCodec {
  public decodeServer(encoded: Uint8Array): ConnectorServerFrame {
    const source = parseJson(encoded);
    if (source.protocol !== CONNECTOR_PROTOCOL) throw new Error("Connector 채널 protocol이 유효하지 않습니다");
    const type = text(source.type, "Connector frame type", 32);
    if (type !== "request" && encoded.byteLength > CONNECTOR_FRAME_MAX_BYTES) {
      throw new Error("Connector frame byte 상한을 초과했습니다");
    }
    if (type === "ready") {
      exact(source, ["protocol", "type"], "Connector ready frame");
      return { protocol: CONNECTOR_PROTOCOL, type };
    }
    if (type === "cancel") {
      exact(source, ["protocol", "type", "requestId", "leaseId", "reason"], "Connector cancel frame");
      const reason = text(source.reason, "Connector 취소 사유", 32);
      if (!new Set(["aborted", "timeout", "consumer-closed", "shutdown"]).has(reason)) {
        throw new Error("Connector 취소 사유가 유효하지 않습니다");
      }
      return {
        protocol: CONNECTOR_PROTOCOL,
        type,
        requestId: text(source.requestId, "Request ID"),
        leaseId: text(source.leaseId, "Lease ID"),
        reason: reason as ConnectorCancelFrame["reason"],
      };
    }
    if (type !== "request") throw new Error("Connector server frame type이 유효하지 않습니다");
    exact(source, ["protocol", "type", "requestId", "leaseId", "operation", "payload"], "Connector request frame");
    const operation = text(source.operation, "Connector operation", 64);
    if (!new Set(["generate", "generate-structured", "agent-turn", "cancel", "quota", "health"]).has(operation)) {
      throw new Error("Connector operation이 유효하지 않습니다");
    }
    return {
      protocol: CONNECTOR_PROTOCOL,
      type,
      requestId: text(source.requestId, "Request ID"),
      leaseId: text(source.leaseId, "Lease ID"),
      operation: operation as ConnectorRequest["operation"],
      payload: source.payload,
    };
  }

  public encodeHandshake(frame: ConnectorHandshakeFrame): Buffer {
    return encode(frame);
  }

  public encodeHeartbeat(frame: ConnectorHeartbeatFrame): Buffer {
    return encode(frame);
  }

  public encodeEvent(input: Omit<ConnectorEventFrame, "protocol" | "type">): Buffer {
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0)
      throw new Error("Connector event sequence가 유효하지 않습니다");
    if (!new Set(["data", "usage", "error", "done"]).has(input.kind))
      throw new Error("Connector event kind가 유효하지 않습니다");
    return encode({
      protocol: CONNECTOR_PROTOCOL,
      type: "event",
      requestId: text(input.requestId, "Request ID"),
      leaseId: text(input.leaseId, "Lease ID"),
      sequence: input.sequence,
      kind: input.kind,
      payload: input.payload,
    });
  }
}
