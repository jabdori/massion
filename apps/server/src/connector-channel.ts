import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";

import type { ConnectorEvent, ConnectorRequest, ConnectorTransportDirectory } from "@massion/subscriptions";

export const CONNECTOR_PROTOCOL = "massion.connector.v1" as const;
export const CONNECTOR_HANDSHAKE_MAX_BYTES = 16 * 1024;
export const CONNECTOR_FRAME_MAX_BYTES = 1024 * 1024;
export const CONNECTOR_REQUEST_MAX_BYTES = 16 * 1024 * 1024;

export interface ConnectorChannelHandshakeUnsigned {
  readonly protocol: typeof CONNECTOR_PROTOCOL;
  readonly type: "handshake";
  readonly organizationId: string;
  readonly connectorId: string;
  readonly nonce: string;
  readonly observedAt: string;
}

export interface ConnectorChannelHandshake extends ConnectorChannelHandshakeUnsigned {
  readonly signature: string;
}

export interface ConnectorChannelReadyFrame {
  readonly protocol: typeof CONNECTOR_PROTOCOL;
  readonly type: "ready";
}

export interface ConnectorChannelRequestFrame extends ConnectorRequest {
  readonly type: "request";
}

export interface ConnectorChannelCancelFrame {
  readonly protocol: typeof CONNECTOR_PROTOCOL;
  readonly type: "cancel";
  readonly requestId: string;
  readonly leaseId: string;
  readonly reason: "aborted" | "timeout" | "consumer-closed" | "shutdown";
}

export interface ConnectorChannelEventFrame {
  readonly protocol: typeof CONNECTOR_PROTOCOL;
  readonly type: "event";
  readonly requestId: string;
  readonly leaseId: string;
  readonly sequence: number;
  readonly kind: ConnectorEvent["kind"];
  readonly payload: unknown;
}

export interface ConnectorChannelHeartbeatFrame {
  readonly protocol: typeof CONNECTOR_PROTOCOL;
  readonly type: "heartbeat";
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly observedAt: string;
  readonly profileHealthObservedAt: string;
  readonly nonce: string;
  readonly signature: string;
}

/** @deprecated ConnectorChannelEventFrame을 사용해 주세요. */
export type ConnectorChannelFrame = ConnectorChannelEventFrame;

export type ConnectorChannelClientFrame =
  ConnectorChannelHandshake | ConnectorChannelHeartbeatFrame | ConnectorChannelEventFrame;
export type ConnectorChannelServerFrame =
  ConnectorChannelReadyFrame | ConnectorChannelRequestFrame | ConnectorChannelCancelFrame;
export type ConnectorChannelProtocolFrame = ConnectorChannelClientFrame | ConnectorChannelServerFrame;

export interface ConnectorPublicKeyDirectory {
  findPublicKey(identity: {
    readonly organizationId: string;
    readonly connectorId: string;
  }): Promise<string | undefined>;
}

/**
 * nonce hash를 원자적으로 선점합니다. 영속 구현은 이미 선점된 값이면 false를 반환해야 합니다.
 */
export interface ConnectorHandshakeNonceClaims {
  claim(input: {
    readonly organizationId: string;
    readonly connectorId: string;
    readonly nonceHash: string;
    readonly observedAt: string;
    readonly claimedAt: string;
  }): Promise<boolean>;
}

function text(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string") throw new Error(`${label}이 유효하지 않습니다`);
  const normalized = value.trim();
  let hasControlCharacter = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    if (code <= 31 || code === 127) hasControlCharacter = true;
  }
  if (normalized.length === 0 || normalized.length > maximum || hasControlCharacter) {
    throw new Error(`${label}이 유효하지 않습니다`);
  }
  return normalized;
}

function assertSafeJson(value: unknown, depth = 0): void {
  if (depth > 32) throw new Error("Connector frame JSON 깊이 상한을 초과했습니다");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Connector frame에 유효하지 않은 숫자가 있습니다");
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) assertSafeJson(child, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") throw new Error("Connector frame JSON 값이 유효하지 않습니다");
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Connector frame JSON object가 유효하지 않습니다");
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error("Connector frame에 금지된 object key가 있습니다");
    }
    assertSafeJson(child, depth + 1);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}이 유효하지 않습니다`);
  assertSafeJson(value);
  return value as Record<string, unknown>;
}

function exactFields(source: Readonly<Record<string, unknown>>, allowed: readonly string[], label: string): void {
  const names = new Set(allowed);
  const unknown = Object.keys(source).find((key) => !names.has(key));
  if (unknown) throw new Error(`${label}에 알 수 없는 필드가 있습니다: ${unknown}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function createChannelHandshakePayload(input: ConnectorChannelHandshakeUnsigned): Buffer {
  return Buffer.from(
    [input.protocol, input.type, input.organizationId, input.connectorId, input.nonce, input.observedAt].join("\n"),
    "utf8",
  );
}

export class ConnectorChannelAuthenticator {
  private readonly now: () => Date;
  private readonly maximumClockSkewMs: number;
  private readonly publicKeys: ConnectorPublicKeyDirectory;
  private readonly nonceClaims: ConnectorHandshakeNonceClaims;

  public constructor(options: {
    readonly publicKeys: ConnectorPublicKeyDirectory;
    readonly nonceClaims: ConnectorHandshakeNonceClaims;
    readonly now?: () => Date;
    readonly maximumClockSkewMs?: number;
  }) {
    this.publicKeys = options.publicKeys;
    this.nonceClaims = options.nonceClaims;
    this.now = options.now ?? (() => new Date());
    this.maximumClockSkewMs = options.maximumClockSkewMs ?? 5 * 60 * 1_000;
    if (!Number.isSafeInteger(this.maximumClockSkewMs) || this.maximumClockSkewMs < 0) {
      throw new Error("Handshake 허용 시각 오차가 유효하지 않습니다");
    }
  }

  public async verify(input: { readonly secure: boolean; readonly handshake: unknown }): Promise<{
    readonly organizationId: string;
    readonly connectorId: string;
    readonly observedAt: string;
  }> {
    if (!input.secure) throw new Error("Edge Connector 채널은 TLS가 필요합니다");
    const handshake = ConnectorFrameCodec.validateHandshake(input.handshake);
    const observedAt = new Date(handshake.observedAt);
    if (!Number.isFinite(observedAt.getTime())) throw new Error("Handshake 시각이 유효하지 않습니다");
    const now = this.now();
    if (Math.abs(now.getTime() - observedAt.getTime()) > this.maximumClockSkewMs) {
      throw new Error("Handshake 시각 허용 범위를 벗어났습니다");
    }

    let publicKeyText: string | undefined;
    try {
      publicKeyText = await this.publicKeys.findPublicKey({
        organizationId: handshake.organizationId,
        connectorId: handshake.connectorId,
      });
    } catch {
      throw new Error("등록된 Connector 장치 key를 조회할 수 없습니다");
    }
    if (!publicKeyText) throw new Error("등록된 Connector 장치 key를 찾을 수 없습니다");
    let publicKey;
    try {
      publicKey = createPublicKey(publicKeyText);
    } catch {
      throw new Error("등록된 Connector 장치 key가 유효하지 않습니다");
    }
    if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Connector 장치 key는 Ed25519여야 합니다");
    const signature = text(handshake.signature, "Handshake 서명", 128);
    if (!/^[A-Za-z0-9_-]{86}$/u.test(signature)) throw new Error("Connector Handshake 서명 형식이 유효하지 않습니다");
    if (
      !verifySignature(null, createChannelHandshakePayload(handshake), publicKey, Buffer.from(signature, "base64url"))
    ) {
      throw new Error("Connector Handshake 서명이 유효하지 않습니다");
    }

    let claimed: boolean;
    try {
      claimed = await this.nonceClaims.claim({
        organizationId: handshake.organizationId,
        connectorId: handshake.connectorId,
        nonceHash: sha256(handshake.nonce),
        observedAt: observedAt.toISOString(),
        claimedAt: now.toISOString(),
      });
    } catch {
      throw new Error("Handshake nonce를 선점할 수 없습니다");
    }
    if (!claimed) throw new Error("Handshake nonce를 재사용할 수 없습니다");
    return {
      organizationId: handshake.organizationId,
      connectorId: handshake.connectorId,
      observedAt: observedAt.toISOString(),
    };
  }
}

export class ConnectorFrameCodec {
  public encode(frame: ConnectorChannelProtocolFrame, maximumBytes = CONNECTOR_FRAME_MAX_BYTES): Buffer {
    const validated = ConnectorFrameCodec.validate(frame);
    let encoded: Buffer;
    try {
      encoded = Buffer.from(JSON.stringify(validated), "utf8");
    } catch {
      throw new Error("Connector frame JSON을 직렬화할 수 없습니다");
    }
    if (encoded.byteLength > maximumBytes) throw new Error("Connector frame byte 상한을 초과했습니다");
    return encoded;
  }

  public encodeRequest(request: ConnectorRequest): Buffer {
    const encoded = this.encode({ ...request, type: "request" }, CONNECTOR_REQUEST_MAX_BYTES);
    this.assertRequestBytes(encoded.byteLength);
    return encoded;
  }

  public decode(encoded: Uint8Array): ConnectorChannelProtocolFrame {
    return this.decodeWithMaximum(encoded, CONNECTOR_FRAME_MAX_BYTES, "Connector frame byte 상한을 초과했습니다");
  }

  public decodeHandshake(encoded: Uint8Array): ConnectorChannelHandshake {
    const frame = this.decodeWithMaximum(
      encoded,
      CONNECTOR_HANDSHAKE_MAX_BYTES,
      "Connector handshake byte 상한을 초과했습니다",
    );
    if (frame.type !== "handshake") throw new Error("첫 Connector frame은 handshake여야 합니다");
    return frame;
  }

  public decodeEvent(encoded: Uint8Array): ConnectorChannelEventFrame {
    const frame = this.decode(encoded);
    if (frame.type !== "event") throw new Error("Connector 응답 frame이 유효하지 않습니다");
    return frame;
  }

  public assertRequestBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > CONNECTOR_REQUEST_MAX_BYTES) {
      throw new Error("Connector 요청 byte 상한을 초과했습니다");
    }
  }

  public static validateHandshake(value: unknown): ConnectorChannelHandshake {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Connector 채널 handshake가 유효하지 않습니다");
    }
    const frame = ConnectorFrameCodec.validate(value);
    if (frame.type !== "handshake") throw new Error("Connector 채널 handshake가 유효하지 않습니다");
    return frame;
  }

  private decodeWithMaximum(
    encoded: Uint8Array,
    maximumBytes: number,
    maximumMessage: string,
  ): ConnectorChannelProtocolFrame {
    if (encoded.byteLength > maximumBytes) throw new Error(maximumMessage);
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(encoded).toString("utf8")) as unknown;
    } catch {
      throw new Error("Connector frame JSON이 유효하지 않습니다");
    }
    return ConnectorFrameCodec.validate(value);
  }

  private static validate(value: unknown): ConnectorChannelProtocolFrame {
    const source = object(value, "Connector frame");
    if (source.protocol !== CONNECTOR_PROTOCOL) throw new Error("Connector 채널 protocol이 유효하지 않습니다");
    const type = text(source.type, "Connector frame type", 32);
    switch (type) {
      case "handshake": {
        exactFields(
          source,
          ["protocol", "type", "organizationId", "connectorId", "nonce", "observedAt", "signature"],
          "Connector handshake",
        );
        const nonce = text(source.nonce, "Handshake nonce");
        if (nonce.length < 16) throw new Error("Handshake nonce 길이가 유효하지 않습니다");
        return {
          protocol: CONNECTOR_PROTOCOL,
          type,
          organizationId: text(source.organizationId, "조직 ID"),
          connectorId: text(source.connectorId, "Connector ID"),
          nonce,
          observedAt: text(source.observedAt, "Handshake 시각"),
          signature: text(source.signature, "Handshake 서명", 128),
        };
      }
      case "ready":
        exactFields(source, ["protocol", "type"], "Connector ready frame");
        return { protocol: CONNECTOR_PROTOCOL, type };
      case "heartbeat": {
        exactFields(
          source,
          [
            "protocol",
            "type",
            "version",
            "capabilities",
            "observedAt",
            "profileHealthObservedAt",
            "nonce",
            "signature",
          ],
          "Connector heartbeat frame",
        );
        if (
          !Array.isArray(source.capabilities) ||
          source.capabilities.length === 0 ||
          source.capabilities.length > 256
        ) {
          throw new Error("Connector heartbeat capability가 유효하지 않습니다");
        }
        const capabilities = [
          ...new Set(source.capabilities.map((capability) => text(capability, "Capability"))),
        ].sort();
        const nonce = text(source.nonce, "Heartbeat nonce");
        const signature = text(source.signature, "Heartbeat 서명", 128);
        if (nonce.length < 16 || !/^[A-Za-z0-9_-]{86}$/u.test(signature)) {
          throw new Error("Connector heartbeat 인증 값이 유효하지 않습니다");
        }
        return {
          protocol: CONNECTOR_PROTOCOL,
          type,
          version: text(source.version, "Connector version", 64),
          capabilities,
          observedAt: text(source.observedAt, "Heartbeat 시각"),
          profileHealthObservedAt: text(source.profileHealthObservedAt, "Provider profile 건강 증명 시각"),
          nonce,
          signature,
        };
      }
      case "request": {
        exactFields(
          source,
          ["protocol", "type", "requestId", "leaseId", "operation", "payload"],
          "Connector 요청 frame",
        );
        const operation = text(source.operation, "Connector 요청 operation", 64);
        if (!new Set(["generate", "generate-structured", "agent-turn", "cancel", "quota", "health"]).has(operation)) {
          throw new Error("Connector 요청 operation이 유효하지 않습니다");
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
      case "cancel": {
        exactFields(source, ["protocol", "type", "requestId", "leaseId", "reason"], "Connector 취소 frame");
        const reason = text(source.reason, "Connector 취소 사유", 32);
        if (!new Set(["aborted", "timeout", "consumer-closed", "shutdown"]).has(reason)) {
          throw new Error("Connector 취소 사유가 유효하지 않습니다");
        }
        return {
          protocol: CONNECTOR_PROTOCOL,
          type,
          requestId: text(source.requestId, "Request ID"),
          leaseId: text(source.leaseId, "Lease ID"),
          reason: reason as ConnectorChannelCancelFrame["reason"],
        };
      }
      case "event": {
        exactFields(
          source,
          ["protocol", "type", "requestId", "leaseId", "sequence", "kind", "payload"],
          "Connector frame",
        );
        const sequence = source.sequence;
        if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) {
          throw new Error("Connector frame sequence가 유효하지 않습니다");
        }
        const kind = text(source.kind, "Connector frame kind", 16);
        if (!new Set(["data", "usage", "error", "done"]).has(kind)) {
          throw new Error("Connector frame kind가 유효하지 않습니다");
        }
        return {
          protocol: CONNECTOR_PROTOCOL,
          type,
          requestId: text(source.requestId, "Request ID"),
          leaseId: text(source.leaseId, "Lease ID"),
          sequence: sequence as number,
          kind: kind as ConnectorEvent["kind"],
          payload: source.payload,
        };
      }
      default:
        throw new Error("Connector frame type이 유효하지 않습니다");
    }
  }
}

export interface ConnectorChannelConnection {
  invoke(request: ConnectorRequest, signal?: AbortSignal): AsyncIterable<ConnectorEvent>;
  close(): Promise<void>;
}

export class ConnectorChannelHub implements ConnectorTransportDirectory {
  private readonly connections = new Map<string, ConnectorChannelConnection>();

  public attach(
    identity: { readonly organizationId: string; readonly connectorId: string },
    connection: ConnectorChannelConnection,
  ): () => Promise<void> {
    const organizationId = text(identity.organizationId, "조직 ID");
    const connectorId = text(identity.connectorId, "Connector ID");
    const key = this.key(organizationId, connectorId);
    if (this.connections.has(key)) throw new Error("Connector 채널이 이미 연결되어 있습니다");
    this.connections.set(key, connection);
    return async () => {
      if (this.connections.get(key) !== connection) return;
      this.connections.delete(key);
      await connection.close();
    };
  }

  public async *invoke(
    organizationId: string,
    connectorId: string,
    request: ConnectorRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ConnectorEvent> {
    const connection = this.connections.get(this.key(organizationId, connectorId));
    if (!connection) throw new Error("Connector 채널이 연결되지 않았습니다");
    yield* connection.invoke(request, signal);
  }

  public async disconnect(identity: {
    readonly organizationId: string;
    readonly connectorId: string;
  }): Promise<boolean> {
    const key = this.key(identity.organizationId, identity.connectorId);
    const connection = this.connections.get(key);
    if (!connection) return false;
    this.connections.delete(key);
    await connection.close();
    return true;
  }

  public async shutdown(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(connections.map((connection) => connection.close()));
  }

  private key(organizationId: string, connectorId: string): string {
    return `${text(organizationId, "조직 ID")}\0${text(connectorId, "Connector ID")}`;
  }
}
