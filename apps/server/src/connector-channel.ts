import { createPublicKey, verify as verifySignature } from "node:crypto";

import type { ConnectorEvent, ConnectorRequest, ConnectorTransportDirectory } from "@massion/subscriptions";

export const CONNECTOR_PROTOCOL = "massion.connector.v1" as const;
export const CONNECTOR_FRAME_MAX_BYTES = 1024 * 1024;
export const CONNECTOR_REQUEST_MAX_BYTES = 16 * 1024 * 1024;

export interface ConnectorChannelHandshakeUnsigned {
  readonly protocol: typeof CONNECTOR_PROTOCOL;
  readonly organizationId: string;
  readonly connectorId: string;
  readonly nonce: string;
  readonly observedAt: string;
}

export interface ConnectorChannelHandshake extends ConnectorChannelHandshakeUnsigned {
  readonly signature: string;
}

export interface ConnectorChannelFrame {
  readonly protocol: typeof CONNECTOR_PROTOCOL;
  readonly requestId: string;
  readonly leaseId: string;
  readonly sequence: number;
  readonly kind: "data" | "usage" | "error" | "done";
  readonly payload: unknown;
}

function text(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${label}이 유효하지 않습니다`);
  }
  return value;
}

function assertSafeJson(value: unknown, depth = 0): void {
  if (depth > 32) throw new Error("Connector frame JSON 깊이 상한을 초과했습니다");
  if (Array.isArray(value)) {
    for (const child of value) assertSafeJson(child, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error("Connector frame에 금지된 object key가 있습니다");
    }
    assertSafeJson(child, depth + 1);
  }
}

export function createChannelHandshakePayload(input: ConnectorChannelHandshakeUnsigned): Buffer {
  return Buffer.from(
    [input.protocol, input.organizationId, input.connectorId, input.nonce, input.observedAt].join("\n"),
    "utf8",
  );
}

export class ConnectorChannelAuthenticator {
  private readonly usedNonces = new Set<string>();
  private readonly now: () => Date;
  private readonly maximumClockSkewMs: number;

  public constructor(options: { readonly now?: () => Date; readonly maximumClockSkewMs?: number } = {}) {
    this.now = options.now ?? (() => new Date());
    this.maximumClockSkewMs = options.maximumClockSkewMs ?? 5 * 60 * 1_000;
  }

  public verify(input: {
    readonly secure: boolean;
    readonly publicKey: string;
    readonly handshake: ConnectorChannelHandshake;
  }): { readonly organizationId: string; readonly connectorId: string } {
    if (!input.secure) throw new Error("Edge Connector 채널은 TLS가 필요합니다");
    const handshake = input.handshake;
    if (handshake.protocol !== CONNECTOR_PROTOCOL) throw new Error("Connector 채널 protocol이 유효하지 않습니다");
    const organizationId = text(handshake.organizationId, "조직 ID");
    const connectorId = text(handshake.connectorId, "Connector ID");
    const nonce = text(handshake.nonce, "Handshake nonce");
    const observedAt = new Date(text(handshake.observedAt, "Handshake 시각"));
    if (!Number.isFinite(observedAt.getTime())) throw new Error("Handshake 시각이 유효하지 않습니다");
    if (Math.abs(this.now().getTime() - observedAt.getTime()) > this.maximumClockSkewMs) {
      throw new Error("Handshake 시각 허용 범위를 벗어났습니다");
    }
    const nonceKey = `${organizationId}\0${connectorId}\0${nonce}`;
    if (this.usedNonces.has(nonceKey)) throw new Error("Handshake nonce를 재사용할 수 없습니다");
    const publicKey = createPublicKey(input.publicKey);
    if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Connector 장치 key는 Ed25519여야 합니다");
    const verified = verifySignature(
      null,
      createChannelHandshakePayload(handshake),
      publicKey,
      Buffer.from(text(handshake.signature, "Handshake 서명", 2048), "base64url"),
    );
    if (!verified) throw new Error("Connector Handshake 서명이 유효하지 않습니다");
    this.usedNonces.add(nonceKey);
    return { organizationId, connectorId };
  }
}

export class ConnectorFrameCodec {
  public encode(frame: ConnectorChannelFrame): Buffer {
    this.validate(frame);
    const encoded = Buffer.from(JSON.stringify(frame), "utf8");
    if (encoded.byteLength > CONNECTOR_FRAME_MAX_BYTES) throw new Error("Connector frame byte 상한을 초과했습니다");
    return encoded;
  }

  public decode(encoded: Uint8Array): ConnectorChannelFrame {
    if (encoded.byteLength > CONNECTOR_FRAME_MAX_BYTES) throw new Error("Connector frame byte 상한을 초과했습니다");
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(encoded).toString("utf8")) as unknown;
    } catch (error) {
      throw new Error("Connector frame JSON이 유효하지 않습니다", { cause: error });
    }
    return this.validate(value);
  }

  public assertRequestBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > CONNECTOR_REQUEST_MAX_BYTES) {
      throw new Error("Connector 요청 byte 상한을 초과했습니다");
    }
  }

  private validate(value: unknown): ConnectorChannelFrame {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Connector frame이 유효하지 않습니다");
    assertSafeJson(value);
    const source = value as Record<string, unknown>;
    const allowed = new Set(["protocol", "requestId", "leaseId", "sequence", "kind", "payload"]);
    const unknown = Object.keys(source).find((key) => !allowed.has(key));
    if (unknown) throw new Error(`Connector frame에 알 수 없는 필드가 있습니다: ${unknown}`);
    if (source.protocol !== CONNECTOR_PROTOCOL) throw new Error("Connector frame protocol이 유효하지 않습니다");
    const sequence = source.sequence;
    if (!Number.isSafeInteger(sequence) || (sequence as number) < 0)
      throw new Error("Connector frame sequence가 유효하지 않습니다");
    if (!new Set(["data", "usage", "error", "done"]).has(String(source.kind))) {
      throw new Error("Connector frame kind가 유효하지 않습니다");
    }
    return {
      protocol: CONNECTOR_PROTOCOL,
      requestId: text(source.requestId, "Request ID"),
      leaseId: text(source.leaseId, "Lease ID"),
      sequence: sequence as number,
      kind: source.kind as ConnectorChannelFrame["kind"],
      payload: source.payload,
    };
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

  public async shutdown(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(connections.map(async (connection) => await connection.close()));
  }

  private key(organizationId: string, connectorId: string): string {
    return `${text(organizationId, "조직 ID")}\0${text(connectorId, "Connector ID")}`;
  }
}
