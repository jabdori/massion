import type { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import type { Socket } from "node:net";
import type { EventEmitter } from "node:events";

import type { ConnectorEvent, ConnectorRequest } from "@massion/subscriptions";

import {
  CONNECTOR_FRAME_MAX_BYTES,
  CONNECTOR_PROTOCOL,
  CONNECTOR_REQUEST_MAX_BYTES,
  ConnectorChannelAuthenticator,
  type ConnectorChannelCancelFrame,
  type ConnectorChannelConnection,
  type ConnectorChannelEventFrame,
  type ConnectorChannelHeartbeatFrame,
  ConnectorChannelHub,
  ConnectorFrameCodec,
} from "./connector-channel.js";

export interface ConnectorWebSocketUpgradeServer {
  on(event: "upgrade", listener: ConnectorWebSocketUpgradeListener): this;
  off(event: "upgrade", listener: ConnectorWebSocketUpgradeListener): this;
}

export type ConnectorWebSocketUpgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

interface WebSocketLike extends EventEmitter {
  readonly bufferedAmount: number;
  readonly readyState: number;
  send(
    data: string,
    options: { readonly binary: false; readonly compress: false },
    callback?: (error?: Error) => void,
  ): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

interface WebSocketServerLike extends EventEmitter {
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (socket: WebSocketLike, request: IncomingMessage) => void,
  ): void;
  close(callback: (error?: Error) => void): void;
}

interface WebSocketServerConstructor {
  new (options: {
    readonly noServer: true;
    readonly clientTracking: false;
    readonly allowSynchronousEvents: false;
    readonly perMessageDeflate: false;
    readonly maxPayload: number;
  }): WebSocketServerLike;
}

const require = createRequire(import.meta.url);
const WebSocketServer = (require("ws") as { readonly WebSocketServer: WebSocketServerConstructor }).WebSocketServer;
const WEB_SOCKET_OPEN = 1;
const WEB_SOCKET_CLOSED = 3;

const DEFAULT_PATH = "/connectors";
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAXIMUM_PENDING_REQUESTS = 64;
const DEFAULT_MAXIMUM_BUFFERED_BYTES = CONNECTOR_REQUEST_MAX_BYTES;
const DEFAULT_MAXIMUM_REQUESTS_PER_CONNECTION = 100_000;
const DEFAULT_MAXIMUM_QUEUED_EVENTS = 256;
const DEFAULT_CLOSE_GRACE_PERIOD_MS = 1_000;
const DEFAULT_EXPIRY_SWEEP_INTERVAL_MS = 10_000;

export interface ConnectorChannelLifecycle {
  connected(input: {
    readonly organizationId: string;
    readonly connectorId: string;
    readonly observedAt: string;
  }): Promise<void>;
  heartbeat(input: {
    readonly organizationId: string;
    readonly connectorId: string;
    readonly version: string;
    readonly capabilities: readonly string[];
    readonly observedAt: string;
    readonly profileHealthObservedAt: string;
    readonly nonce: string;
    readonly signature: string;
  }): Promise<void>;
  disconnected(input: { readonly organizationId: string; readonly connectorId: string }): Promise<void>;
  expire(): Promise<number | undefined>;
}

export interface ConnectorUpgradeSecurityInput {
  readonly encrypted: boolean;
  readonly remoteAddress?: string | undefined;
  readonly forwardedProto?: string | readonly string[] | undefined;
  readonly trustedProxyAddresses: readonly string[];
}

export function isSecureConnectorUpgrade(input: ConnectorUpgradeSecurityInput): boolean {
  if (input.encrypted) return true;
  if (!input.remoteAddress || !input.trustedProxyAddresses.includes(input.remoteAddress)) return false;
  return typeof input.forwardedProto === "string" && input.forwardedProto.trim().toLowerCase() === "https";
}

export function assertConnectorSendCapacity(input: {
  readonly bufferedAmount: number;
  readonly encodedBytes: number;
  readonly maximumBufferedBytes: number;
}): void {
  if (
    !Number.isSafeInteger(input.bufferedAmount) ||
    input.bufferedAmount < 0 ||
    !Number.isSafeInteger(input.encodedBytes) ||
    input.encodedBytes < 0 ||
    !Number.isSafeInteger(input.maximumBufferedBytes) ||
    input.maximumBufferedBytes < 1 ||
    input.bufferedAmount > input.maximumBufferedBytes - input.encodedBytes
  ) {
    throw new Error("Connector WebSocket backpressure 상한을 초과했습니다");
  }
}

export interface ConnectorWebSocketServiceOptions {
  readonly server: ConnectorWebSocketUpgradeServer;
  readonly path?: string;
  readonly hub: ConnectorChannelHub;
  readonly authenticator: ConnectorChannelAuthenticator;
  readonly lifecycle: ConnectorChannelLifecycle;
  readonly trustedProxyAddresses?: readonly string[] | undefined;
  readonly handshakeTimeoutMs?: number | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly maximumPendingRequests?: number | undefined;
  readonly maximumBufferedBytes?: number | undefined;
  readonly maximumRequestsPerConnection?: number | undefined;
  readonly maximumQueuedEventsPerRequest?: number | undefined;
  readonly closeGracePeriodMs?: number | undefined;
  readonly expirySweepIntervalMs?: number | undefined;
}

interface PendingWaiter {
  readonly resolve: (event: ConnectorEvent | undefined) => void;
  readonly reject: (error: Error) => void;
}

interface PendingRequest {
  readonly requestId: string;
  readonly leaseId: string;
  readonly events: ConnectorEvent[];
  nextSequence: number;
  ended: boolean;
  failure?: Error;
  waiter?: PendingWaiter;
  timeout?: ReturnType<typeof setTimeout>;
  removeAbort?: () => void;
}

interface ManagedSession {
  readonly identity: { readonly organizationId: string; readonly connectorId: string };
  readonly connection: WebSocketConnectorConnection;
  detach: () => Promise<void>;
  lifecycleConnected: boolean;
  release?: Promise<void>;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) throw new Error(`${label}이 유효하지 않습니다`);
  return selected;
}

function normalizePath(value: string | undefined): string {
  const path = value ?? DEFAULT_PATH;
  if (!path.startsWith("/") || path.includes("?") || path.includes("#") || path.length > 256) {
    throw new Error("Connector WebSocket 경로가 유효하지 않습니다");
  }
  return path;
}

function rawDataToBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value) && value.every((part) => Buffer.isBuffer(part))) return Buffer.concat(value);
  throw new Error("Connector WebSocket frame 형식이 유효하지 않습니다");
}

function socketEncrypted(request: IncomingMessage): boolean {
  return (request.socket as Socket & { readonly encrypted?: boolean }).encrypted === true;
}

function requestPath(request: IncomingMessage): string | undefined {
  if (!request.url) return undefined;
  try {
    return new URL(request.url, "http://massion.invalid").pathname;
  } catch {
    return undefined;
  }
}

function rejectUpgrade(socket: Duplex, status: 403 | 404 | 503): void {
  if (socket.destroyed) return;
  const label = status === 403 ? "Forbidden" : status === 404 ? "Not Found" : "Service Unavailable";
  socket.end(`HTTP/1.1 ${String(status)} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function closeSocket(socket: WebSocketLike, code: number, reason: string, closeGracePeriodMs: number): Promise<void> {
  if (socket.readyState === WEB_SOCKET_CLOSED) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      socket.terminate();
      finish();
    }, closeGracePeriodMs);
    timer.unref();
    socket.once("close", finish);
    try {
      socket.close(code, reason);
    } catch {
      socket.terminate();
      finish();
    }
  });
}

class WebSocketConnectorConnection implements ConnectorChannelConnection {
  private readonly codec = new ConnectorFrameCodec();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly seenRequestIds = new Set<string>();
  private state: "handshaking" | "open" | "closing" | "closed" = "handshaking";
  private messageChain: Promise<void> = Promise.resolve();
  private closePromise?: Promise<void>;

  public constructor(
    private readonly socket: WebSocketLike,
    private readonly identity: { readonly organizationId: string; readonly connectorId: string },
    private readonly lifecycle: ConnectorChannelLifecycle,
    private readonly requestTimeoutMs: number,
    private readonly maximumPendingRequests: number,
    private readonly maximumBufferedBytes: number,
    private readonly maximumRequestsPerConnection: number,
    private readonly maximumQueuedEventsPerRequest: number,
    private readonly closeGracePeriodMs: number,
  ) {}

  public activate(): void {
    if (this.state !== "handshaking") throw new Error("Connector WebSocket 연결 상태가 유효하지 않습니다");
    this.state = "open";
    this.sendFrame({ protocol: CONNECTOR_PROTOCOL, type: "ready" });
  }

  public receive(value: unknown, isBinary: boolean): void {
    if (this.state !== "open") {
      this.protocolViolation();
      return;
    }
    this.messageChain = this.messageChain
      .then(async () => {
        if (isBinary) throw new Error("Connector protocol violation");
        const frame = this.codec.decode(rawDataToBuffer(value));
        if (frame.type === "heartbeat") {
          await this.acceptHeartbeat(frame);
          return;
        }
        if (frame.type !== "event") throw new Error("Connector protocol violation");
        this.acceptEvent(frame);
      })
      .catch(() => {
        this.protocolViolation();
      });
  }

  public handleSocketClosed(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.failAll(new Error("Connector WebSocket 연결이 닫혔습니다"));
  }

  public async *invoke(request: ConnectorRequest, signal?: AbortSignal): AsyncIterable<ConnectorEvent> {
    if (this.state !== "open") throw new Error("Connector WebSocket 연결이 준비되지 않았습니다");
    if (signal?.aborted) throw new Error("Connector 요청이 취소되었습니다");
    if (this.pending.size >= this.maximumPendingRequests) {
      throw new Error("Connector WebSocket pending request 상한을 초과했습니다");
    }
    if (this.seenRequestIds.has(request.requestId)) throw new Error("Connector Request ID를 재사용할 수 없습니다");
    if (this.seenRequestIds.size >= this.maximumRequestsPerConnection) {
      throw new Error("Connector WebSocket 연결의 요청 수 상한을 초과했습니다");
    }
    const encoded = this.codec.encodeRequest(request);
    const pending: PendingRequest = {
      requestId: request.requestId,
      leaseId: request.leaseId,
      events: [],
      nextSequence: 0,
      ended: false,
    };
    this.seenRequestIds.add(request.requestId);
    this.pending.set(request.requestId, pending);
    pending.timeout = setTimeout(() => {
      this.cancelPending(pending, "timeout", new Error("Connector 요청 응답 시간이 초과되었습니다"));
    }, this.requestTimeoutMs);
    pending.timeout.unref();
    if (signal) {
      const abort = (): void => {
        this.cancelPending(pending, "aborted", new Error("Connector 요청이 취소되었습니다"));
      };
      signal.addEventListener("abort", abort, { once: true });
      pending.removeAbort = () => {
        signal.removeEventListener("abort", abort);
      };
    }

    try {
      this.sendEncoded(encoded);
      let event = await this.readPending(pending);
      while (event) {
        yield event;
        event = await this.readPending(pending);
      }
    } finally {
      if (this.pending.get(pending.requestId) === pending) {
        this.cancelPending(pending, "consumer-closed", new Error("Connector 응답 소비가 종료되었습니다"));
      }
    }
  }

  public async close(): Promise<void> {
    if (this.state === "closed") return;
    if (this.closePromise) {
      await this.closePromise;
      return;
    }
    this.state = "closing";
    for (const pending of [...this.pending.values()]) {
      this.sendCancel(pending, "shutdown");
      this.failPending(pending, new Error("Connector WebSocket 연결이 닫혔습니다"));
    }
    this.closePromise = closeSocket(this.socket, 1001, "server shutdown", this.closeGracePeriodMs).then(() => {
      this.handleSocketClosed();
    });
    await this.closePromise;
  }

  private async acceptHeartbeat(frame: ConnectorChannelHeartbeatFrame): Promise<void> {
    await this.lifecycle.heartbeat({
      organizationId: this.identity.organizationId,
      connectorId: this.identity.connectorId,
      version: frame.version,
      capabilities: frame.capabilities,
      observedAt: frame.observedAt,
      profileHealthObservedAt: frame.profileHealthObservedAt,
      nonce: frame.nonce,
      signature: frame.signature,
    });
  }

  private acceptEvent(frame: ConnectorChannelEventFrame): void {
    const pending = this.pending.get(frame.requestId);
    if (!pending || pending.leaseId !== frame.leaseId || frame.sequence !== pending.nextSequence) {
      throw new Error("Connector protocol violation");
    }
    pending.nextSequence += 1;
    const event: ConnectorEvent = { kind: frame.kind, sequence: frame.sequence, payload: frame.payload };
    if (pending.events.length >= this.maximumQueuedEventsPerRequest && !pending.waiter) {
      throw new Error("Connector protocol violation");
    }
    if (pending.waiter) {
      const waiter = pending.waiter;
      delete pending.waiter;
      waiter.resolve(event);
    } else {
      pending.events.push(event);
    }
    if (frame.kind === "done" || frame.kind === "error") this.finishPending(pending);
  }

  private readPending(pending: PendingRequest): Promise<ConnectorEvent | undefined> {
    const event = pending.events.shift();
    if (event) return Promise.resolve(event);
    if (pending.failure) return Promise.reject(pending.failure);
    if (pending.ended) return Promise.resolve(undefined);
    return new Promise<ConnectorEvent | undefined>((resolve, reject) => {
      pending.waiter = { resolve, reject };
    });
  }

  private finishPending(pending: PendingRequest): void {
    if (this.pending.get(pending.requestId) !== pending) return;
    this.pending.delete(pending.requestId);
    this.clearPendingResources(pending);
    pending.ended = true;
    if (pending.waiter) {
      const waiter = pending.waiter;
      delete pending.waiter;
      waiter.resolve(undefined);
    }
  }

  private failPending(pending: PendingRequest, error: Error): void {
    if (this.pending.get(pending.requestId) === pending) this.pending.delete(pending.requestId);
    this.clearPendingResources(pending);
    pending.events.length = 0;
    pending.failure = error;
    pending.ended = true;
    if (pending.waiter) {
      const waiter = pending.waiter;
      delete pending.waiter;
      waiter.reject(error);
    }
  }

  private cancelPending(pending: PendingRequest, reason: ConnectorChannelCancelFrame["reason"], error: Error): void {
    if (this.pending.get(pending.requestId) !== pending) return;
    this.sendCancel(pending, reason);
    this.failPending(pending, error);
  }

  private sendCancel(pending: PendingRequest, reason: ConnectorChannelCancelFrame["reason"]): void {
    if (this.socket.readyState !== WEB_SOCKET_OPEN) return;
    try {
      this.sendFrame({
        protocol: CONNECTOR_PROTOCOL,
        type: "cancel",
        requestId: pending.requestId,
        leaseId: pending.leaseId,
        reason,
      });
    } catch {
      this.transportFailure();
    }
  }

  private clearPendingResources(pending: PendingRequest): void {
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.removeAbort?.();
    delete pending.timeout;
    delete pending.removeAbort;
  }

  private failAll(error: Error): void {
    for (const pending of [...this.pending.values()]) this.failPending(pending, error);
  }

  private sendFrame(frame: Parameters<ConnectorFrameCodec["encode"]>[0]): void {
    this.sendEncoded(this.codec.encode(frame));
  }

  private sendEncoded(encoded: Buffer): void {
    if (this.socket.readyState !== WEB_SOCKET_OPEN) throw new Error("Connector WebSocket 연결이 닫혔습니다");
    assertConnectorSendCapacity({
      bufferedAmount: this.socket.bufferedAmount,
      encodedBytes: encoded.byteLength,
      maximumBufferedBytes: this.maximumBufferedBytes,
    });
    this.socket.send(encoded.toString("utf8"), { binary: false, compress: false }, (error) => {
      if (error) this.transportFailure();
    });
  }

  private protocolViolation(): void {
    if (this.state === "closing" || this.state === "closed") return;
    this.state = "closing";
    this.failAll(new Error("Connector protocol violation로 연결을 닫았습니다"));
    void closeSocket(this.socket, 1008, "protocol violation", this.closeGracePeriodMs).then(() => {
      this.handleSocketClosed();
    });
  }

  private transportFailure(): void {
    if (this.state === "closing" || this.state === "closed") return;
    this.state = "closing";
    this.failAll(new Error("Connector WebSocket 전송이 중단되었습니다"));
    this.socket.terminate();
  }
}

export class ConnectorWebSocketService {
  private readonly webSockets: WebSocketServerLike;
  private readonly server: ConnectorWebSocketUpgradeServer;
  private readonly path: string;
  private readonly hub: ConnectorChannelHub;
  private readonly authenticator: ConnectorChannelAuthenticator;
  private readonly lifecycle: ConnectorChannelLifecycle;
  private readonly trustedProxyAddresses: readonly string[];
  private readonly handshakeTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maximumPendingRequests: number;
  private readonly maximumBufferedBytes: number;
  private readonly maximumRequestsPerConnection: number;
  private readonly maximumQueuedEventsPerRequest: number;
  private readonly closeGracePeriodMs: number;
  private readonly sockets = new Set<WebSocketLike>();
  private readonly sessions = new Set<ManagedSession>();
  private readonly expiryTimer: ReturnType<typeof setInterval>;
  private readonly upgradeListener: ConnectorWebSocketUpgradeListener;
  private expirySweep?: Promise<void>;
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;

  public constructor(options: ConnectorWebSocketServiceOptions) {
    this.server = options.server;
    this.path = normalizePath(options.path);
    this.hub = options.hub;
    this.authenticator = options.authenticator;
    this.lifecycle = options.lifecycle;
    this.trustedProxyAddresses = [...new Set(options.trustedProxyAddresses ?? [])];
    this.handshakeTimeoutMs = positiveInteger(
      options.handshakeTimeoutMs,
      DEFAULT_HANDSHAKE_TIMEOUT_MS,
      "Handshake timeout",
    );
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "요청 timeout");
    this.maximumPendingRequests = positiveInteger(
      options.maximumPendingRequests,
      DEFAULT_MAXIMUM_PENDING_REQUESTS,
      "Pending request 상한",
    );
    this.maximumBufferedBytes = positiveInteger(
      options.maximumBufferedBytes,
      DEFAULT_MAXIMUM_BUFFERED_BYTES,
      "Buffered byte 상한",
    );
    this.maximumRequestsPerConnection = positiveInteger(
      options.maximumRequestsPerConnection,
      DEFAULT_MAXIMUM_REQUESTS_PER_CONNECTION,
      "연결별 요청 상한",
    );
    this.maximumQueuedEventsPerRequest = positiveInteger(
      options.maximumQueuedEventsPerRequest,
      DEFAULT_MAXIMUM_QUEUED_EVENTS,
      "요청별 event queue 상한",
    );
    this.closeGracePeriodMs = positiveInteger(
      options.closeGracePeriodMs,
      DEFAULT_CLOSE_GRACE_PERIOD_MS,
      "WebSocket close 유예 시간",
    );
    const expirySweepIntervalMs = positiveInteger(
      options.expirySweepIntervalMs,
      DEFAULT_EXPIRY_SWEEP_INTERVAL_MS,
      "Connector 만료 sweep 주기",
    );
    this.webSockets = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      allowSynchronousEvents: false,
      perMessageDeflate: false,
      maxPayload: CONNECTOR_FRAME_MAX_BYTES,
    });
    this.webSockets.on("connection", (socket: WebSocketLike) => {
      this.acceptSocket(socket);
    });
    this.webSockets.on("error", () => {
      // Listener 오류의 원문을 외부에 노출하지 않습니다.
    });
    this.upgradeListener = (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    };
    this.server.on("upgrade", this.upgradeListener);
    this.expiryTimer = setInterval(() => {
      this.startExpirySweep();
    }, expirySweepIntervalMs);
    this.expiryTimer.unref();
  }

  public async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return;
    }
    this.shuttingDown = true;
    clearInterval(this.expiryTimer);
    this.server.off("upgrade", this.upgradeListener);
    this.shutdownPromise = (async () => {
      let failed = false;
      if (this.expirySweep) await this.expirySweep;
      const released = await Promise.allSettled([...this.sessions].map((session) => this.releaseSession(session)));
      failed ||= released.some((result) => result.status === "rejected");
      const closed = await Promise.allSettled(
        [...this.sockets].map((socket) => closeSocket(socket, 1001, "server shutdown", this.closeGracePeriodMs)),
      );
      failed ||= closed.some((result) => result.status === "rejected");
      try {
        await new Promise<void>((resolve, reject) => {
          this.webSockets.close((error) => {
            if (error) reject(new Error("Connector WebSocket listener를 닫지 못했습니다"));
            else resolve();
          });
        });
      } catch {
        failed = true;
      }
      if (failed) throw new Error("Connector WebSocket service 종료 중 오류가 발생했습니다");
    })();
    await this.shutdownPromise;
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (requestPath(request) !== this.path) {
      rejectUpgrade(socket, 404);
      return;
    }
    if (this.shuttingDown) {
      rejectUpgrade(socket, 503);
      return;
    }
    const forwardedProto = request.headers["x-forwarded-proto"];
    if (
      !isSecureConnectorUpgrade({
        encrypted: socketEncrypted(request),
        remoteAddress: request.socket.remoteAddress,
        forwardedProto,
        trustedProxyAddresses: this.trustedProxyAddresses,
      })
    ) {
      rejectUpgrade(socket, 403);
      return;
    }
    try {
      this.webSockets.handleUpgrade(request, socket, head, (webSocket, upgradedRequest) => {
        this.webSockets.emit("connection", webSocket, upgradedRequest);
      });
    } catch {
      socket.destroy();
    }
  }

  private startExpirySweep(): void {
    if (this.expirySweep) return;
    const sweep = (async () => {
      try {
        await this.lifecycle.expire();
      } catch {
        // 다음 sweep에서 다시 시도합니다.
      }
    })();
    this.expirySweep = sweep;
    void sweep.then(() => {
      if (this.expirySweep === sweep) delete this.expirySweep;
    });
  }

  private acceptSocket(socket: WebSocketLike): void {
    if (this.shuttingDown) {
      void closeSocket(socket, 1001, "server shutdown", this.closeGracePeriodMs);
      return;
    }
    this.sockets.add(socket);
    let phase: "waiting" | "authenticating" | "ready" | "closed" = "waiting";
    let connection: WebSocketConnectorConnection | undefined;
    let session: ManagedSession | undefined;
    const authenticationWasInterrupted = (): boolean => phase === "closed";
    const handshakeTimer = setTimeout(() => {
      if (phase === "waiting" || phase === "authenticating") {
        phase = "closed";
        void closeSocket(socket, 1008, "authentication failed", this.closeGracePeriodMs);
      }
    }, this.handshakeTimeoutMs);
    handshakeTimer.unref();

    socket.on("message", (data: unknown, isBinary: boolean) => {
      if (phase === "ready") {
        connection?.receive(data, isBinary);
        return;
      }
      if (phase !== "waiting") {
        phase = "closed";
        void closeSocket(socket, 1008, "authentication failed", this.closeGracePeriodMs);
        return;
      }
      phase = "authenticating";
      void (async () => {
        try {
          if (isBinary) throw new Error("Connector handshake 형식이 유효하지 않습니다");
          const handshake = new ConnectorFrameCodec().decodeHandshake(rawDataToBuffer(data));
          const authenticated = await this.authenticator.verify({ secure: true, handshake });
          if (authenticationWasInterrupted() || socket.readyState !== WEB_SOCKET_OPEN || this.shuttingDown) return;
          connection = new WebSocketConnectorConnection(
            socket,
            { organizationId: authenticated.organizationId, connectorId: authenticated.connectorId },
            this.lifecycle,
            this.requestTimeoutMs,
            this.maximumPendingRequests,
            this.maximumBufferedBytes,
            this.maximumRequestsPerConnection,
            this.maximumQueuedEventsPerRequest,
            this.closeGracePeriodMs,
          );
          session = {
            identity: { organizationId: authenticated.organizationId, connectorId: authenticated.connectorId },
            connection,
            detach: () => Promise.resolve(),
            lifecycleConnected: false,
          };
          session.detach = this.hub.attach(session.identity, connection);
          await this.lifecycle.connected({ ...session.identity, observedAt: authenticated.observedAt });
          session.lifecycleConnected = true;
          this.sessions.add(session);
          connection.activate();
          phase = "ready";
          clearTimeout(handshakeTimer);
        } catch {
          phase = "closed";
          clearTimeout(handshakeTimer);
          if (session) await this.releaseSession(session);
          await closeSocket(socket, 1008, "authentication failed", this.closeGracePeriodMs);
        }
      })();
    });
    socket.on("error", () => {
      // ws가 protocol close 절차를 완료하게 두고 원문 오류는 노출하지 않습니다.
    });
    socket.on("close", () => {
      phase = "closed";
      clearTimeout(handshakeTimer);
      this.sockets.delete(socket);
      connection?.handleSocketClosed();
      if (session) void this.releaseSession(session);
    });
  }

  private releaseSession(session: ManagedSession): Promise<void> {
    if (session.release) return session.release;
    session.release = (async () => {
      this.sessions.delete(session);
      let failed = false;
      try {
        await session.detach();
      } catch {
        failed = true;
      }
      if (session.lifecycleConnected) {
        session.lifecycleConnected = false;
        try {
          await this.lifecycle.disconnected(session.identity);
        } catch {
          failed = true;
        }
      }
      if (failed) throw new Error("Connector WebSocket session 정리 중 오류가 발생했습니다");
    })();
    return session.release;
  }
}
