import { randomBytes } from "node:crypto";
import type { EventEmitter } from "node:events";
import { createRequire } from "node:module";

import type { EdgeRequestExecutor } from "./executor.js";
import type { ActiveConnectorIdentity } from "./identity-store.js";
import {
  PinnedProviderProfileHealthProbe,
  ProviderReauthenticationRequiredError,
  type ProviderProfileHealthProbe,
} from "./profile-health.js";
import {
  ProviderProfileOwnershipError,
  ProviderProfilePathError,
  ProviderProfilePermissionError,
} from "./profile-permissions.js";
import {
  CONNECTOR_FRAME_MAX_BYTES,
  CONNECTOR_PROTOCOL,
  CONNECTOR_REQUEST_MAX_BYTES,
  ConnectorClientFrameCodec,
  createSignedHandshake,
  createSignedHeartbeat,
  type ConnectorEventFrame,
} from "./protocol.js";
import { assertEdgeRuntimeArtifact, type EdgeRuntimeArtifact } from "./runtime-artifact.js";

const WEB_SOCKET_CONNECTING = 0;
const WEB_SOCKET_OPEN = 1;
const WEB_SOCKET_CLOSED = 3;

export interface EdgeWebSocket extends EventEmitter {
  readonly bufferedAmount: number;
  readonly readyState: number;
  readonly protocol: string;
  send(
    data: string,
    options: { readonly binary: false; readonly compress: false },
    callback?: (error?: Error) => void,
  ): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export interface EdgeWebSocketOptions {
  readonly perMessageDeflate: false;
  readonly maxPayload: number;
  readonly followRedirects: false;
  readonly handshakeTimeout: number;
}

export type EdgeWebSocketFactory = (
  url: URL,
  protocol: typeof CONNECTOR_PROTOCOL,
  options: EdgeWebSocketOptions,
) => EdgeWebSocket;

interface EdgeWebSocketConstructor {
  new (url: string, protocols: readonly string[], options: EdgeWebSocketOptions): EdgeWebSocket;
}

export interface EdgeConnectorClientOptions {
  readonly identity: ActiveConnectorIdentity;
  readonly executor: EdgeRequestExecutor;
  readonly healthProbe?: ProviderProfileHealthProbe;
  readonly runtimeAttestor?: (
    providerId: ActiveConnectorIdentity["providerId"],
    artifact: EdgeRuntimeArtifact,
  ) => Promise<EdgeRuntimeArtifact>;
  readonly socketFactory?: EdgeWebSocketFactory;
  readonly heartbeatIntervalMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly maximumReconnectAttempts?: number;
  readonly reconnectBaseDelayMs?: number;
  readonly reconnectMaximumDelayMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly now?: () => Date;
  readonly noncePrefix?: string;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly log?: (message: string) => void;
}

const require = createRequire(import.meta.url);
const OfficialWebSocket = (require("ws") as { readonly WebSocket: EdgeWebSocketConstructor }).WebSocket;

const DEFAULT_SOCKET_FACTORY: EdgeWebSocketFactory = (url, protocol, options) =>
  new OfficialWebSocket(url.toString(), [protocol], options);

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(`${label}이 유효하지 않습니다`);
  }
  return selected;
}

function endpoint(identity: ActiveConnectorIdentity): URL {
  const url = new URL(identity.baseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Edge Connector에는 credential 없는 HTTPS base URL이 필요합니다");
  }
  url.protocol = "wss:";
  url.pathname = "/connectors";
  return url;
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    function finish(): void {
      signal.removeEventListener("abort", finish);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function rawData(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value) && value.every((part) => Buffer.isBuffer(part))) return Buffer.concat(value);
  throw new Error("Connector WebSocket frame 형식이 유효하지 않습니다");
}

function providerHealthFailure(): never {
  throw new Error("Provider profile health를 안전하게 확인할 수 없습니다");
}

export class EdgeConnectorClient {
  private readonly identity: ActiveConnectorIdentity;
  private readonly executor: EdgeRequestExecutor;
  private readonly healthProbe: ProviderProfileHealthProbe;
  private readonly runtimeAttestor: NonNullable<EdgeConnectorClientOptions["runtimeAttestor"]>;
  private readonly socketFactory: EdgeWebSocketFactory;
  private readonly heartbeatIntervalMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly maximumReconnectAttempts: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaximumDelayMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly now: () => Date;
  private readonly noncePrefix: string;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly log: (message: string) => void;
  private readonly codec = new ConnectorClientFrameCodec();
  private currentSocket: EdgeWebSocket | undefined;
  private stopController: AbortController | undefined;
  private running = false;
  private stopping = false;
  private nonceCounter = 0;

  public constructor(options: EdgeConnectorClientOptions) {
    this.identity = options.identity;
    this.executor = options.executor;
    this.healthProbe = options.healthProbe ?? new PinnedProviderProfileHealthProbe();
    this.runtimeAttestor = options.runtimeAttestor ?? assertEdgeRuntimeArtifact;
    this.socketFactory = options.socketFactory ?? DEFAULT_SOCKET_FACTORY;
    this.heartbeatIntervalMs = boundedInteger(options.heartbeatIntervalMs, 10_000, 10, 300_000, "Heartbeat 주기");
    this.handshakeTimeoutMs = boundedInteger(options.handshakeTimeoutMs, 10_000, 100, 60_000, "Handshake timeout");
    this.maximumReconnectAttempts = boundedInteger(options.maximumReconnectAttempts, 8, 0, 100, "재연결 횟수 상한");
    this.reconnectBaseDelayMs = boundedInteger(options.reconnectBaseDelayMs, 250, 1, 60_000, "재연결 기본 지연");
    this.reconnectMaximumDelayMs = boundedInteger(
      options.reconnectMaximumDelayMs,
      10_000,
      this.reconnectBaseDelayMs,
      300_000,
      "재연결 최대 지연",
    );
    this.shutdownTimeoutMs = boundedInteger(options.shutdownTimeoutMs, 2_000, 50, 30_000, "종료 timeout");
    this.now = options.now ?? (() => new Date());
    this.noncePrefix = options.noncePrefix ?? randomBytes(24).toString("base64url");
    if (this.noncePrefix.length < 16 || this.noncePrefix.length > 128 || /[\0\r\n]/u.test(this.noncePrefix)) {
      throw new Error("Connector nonce prefix가 유효하지 않습니다");
    }
    this.sleep = options.sleep ?? defaultSleep;
    this.log = options.log ?? (() => undefined);
    endpoint(this.identity);
  }

  public async run(signal?: AbortSignal): Promise<void> {
    if (this.running) throw new Error("Edge Connector client가 이미 실행 중입니다");
    this.running = true;
    this.stopping = false;
    const controller = new AbortController();
    this.stopController = controller;
    const stop = (): void => {
      if (controller.signal.aborted) return;
      this.stopping = true;
      controller.abort(signal?.reason ?? "shutdown");
      this.closeCurrent();
    };
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    let reconnectAttempts = 0;
    try {
      while (!controller.signal.aborted) {
        let profileHealthObservedAt: string;
        try {
          if (this.identity.runtimeArtifact) {
            await this.runtimeAttestor(this.identity.providerId, this.identity.runtimeArtifact);
          }
          await this.healthProbe.verify({
            providerId: this.identity.providerId,
            profileRoot: this.identity.profileRoot,
            expectedAuthKind: this.identity.authKind,
            billingKind: this.identity.billingKind,
            ...(this.identity.runtimeArtifact ? { runtimeArtifact: this.identity.runtimeArtifact } : {}),
            signal: controller.signal,
          });
          profileHealthObservedAt = this.now().toISOString();
        } catch (error) {
          if (this.stopRequested(signal)) break;
          if (error instanceof ProviderReauthenticationRequiredError) {
            this.log("Provider profile 재인증이 필요합니다");
            throw error;
          }
          if (
            error instanceof ProviderProfilePermissionError ||
            error instanceof ProviderProfileOwnershipError ||
            error instanceof ProviderProfilePathError
          ) {
            throw error;
          }
          providerHealthFailure();
        }
        let reachedReady = false;
        try {
          reachedReady = await this.connectOnce(controller.signal, profileHealthObservedAt);
        } catch {
          this.log("Edge Connector 채널 연결이 중단됐습니다");
        }
        if (this.stopRequested(signal)) break;
        if (reachedReady) reconnectAttempts = 0;
        reconnectAttempts += 1;
        if (reconnectAttempts > this.maximumReconnectAttempts) {
          throw new Error("Edge Connector 재연결 횟수 상한을 초과했습니다");
        }
        const delay = Math.min(
          this.reconnectMaximumDelayMs,
          this.reconnectBaseDelayMs * 2 ** Math.min(reconnectAttempts - 1, 20),
        );
        await this.sleep(delay, controller.signal);
      }
    } finally {
      signal?.removeEventListener("abort", stop);
      this.stopping = true;
      this.closeCurrent();
      await this.boundedExecutorShutdown();
      this.running = false;
      this.currentSocket = undefined;
      this.stopController = undefined;
    }
  }

  public async shutdown(): Promise<void> {
    this.stopping = true;
    this.stopController?.abort("shutdown");
    this.closeCurrent();
    await this.boundedExecutorShutdown();
  }

  private async connectOnce(signal: AbortSignal, profileHealthObservedAt: string): Promise<boolean> {
    const socket = this.socketFactory(endpoint(this.identity), CONNECTOR_PROTOCOL, {
      perMessageDeflate: false,
      maxPayload: CONNECTOR_REQUEST_MAX_BYTES,
      followRedirects: false,
      handshakeTimeout: this.handshakeTimeoutMs,
    });
    this.currentSocket = socket;
    return await new Promise<boolean>((resolve, reject) => {
      let phase: "connecting" | "handshaking" | "ready" | "closed" = "connecting";
      let reachedReady = false;
      let settled = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        phase = "closed";
        clearTimeout(handshakeTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        signal.removeEventListener("abort", onAbort);
        if (this.currentSocket === socket) this.currentSocket = undefined;
        void this.boundedExecutorShutdown().finally(() => {
          if (error) reject(error);
          else resolve(reachedReady);
        });
      };
      const terminateSoon = (): void => {
        if (socket.readyState === WEB_SOCKET_CLOSED) return;
        try {
          socket.close(1008, "protocol violation");
        } catch {
          socket.terminate();
        }
        const timer = setTimeout(
          () => {
            if (socket.readyState !== WEB_SOCKET_CLOSED) socket.terminate();
          },
          Math.min(this.shutdownTimeoutMs, 1_000),
        );
        timer.unref();
      };
      const send = (encoded: Buffer): void => {
        if (
          socket.readyState !== WEB_SOCKET_OPEN ||
          socket.bufferedAmount > CONNECTOR_FRAME_MAX_BYTES - encoded.byteLength
        ) {
          throw new Error("Connector WebSocket backpressure 상한을 초과했습니다");
        }
        socket.send(encoded.toString("utf8"), { binary: false, compress: false }, (error) => {
          if (error) socket.terminate();
        });
      };
      const heartbeat = (): void => {
        const frame = createSignedHeartbeat(
          this.identity,
          this.now().toISOString(),
          profileHealthObservedAt,
          this.nextNonce(),
        );
        send(this.codec.encodeHeartbeat(frame));
      };
      const onAbort = (): void => {
        if (socket.readyState === WEB_SOCKET_CONNECTING || socket.readyState === WEB_SOCKET_OPEN) {
          try {
            socket.close(1001, "connector shutdown");
          } catch {
            socket.terminate();
          }
        }
        const timer = setTimeout(() => {
          if (socket.readyState !== WEB_SOCKET_CLOSED) socket.terminate();
        }, this.shutdownTimeoutMs);
        timer.unref();
      };
      const handshakeTimer = setTimeout(() => {
        terminateSoon();
        finish(new Error("Connector handshake 시간이 초과되었습니다"));
      }, this.handshakeTimeoutMs);
      handshakeTimer.unref();
      signal.addEventListener("abort", onAbort, { once: true });
      socket.on("open", () => {
        if (phase !== "connecting" || socket.protocol !== CONNECTOR_PROTOCOL) {
          terminateSoon();
          return;
        }
        phase = "handshaking";
        try {
          send(
            this.codec.encodeHandshake(
              createSignedHandshake(this.identity, this.now().toISOString(), this.nextNonce()),
            ),
          );
        } catch {
          terminateSoon();
        }
      });
      socket.on("message", (data: unknown, isBinary: boolean) => {
        try {
          if (isBinary) throw new Error("Connector binary frame은 허용되지 않습니다");
          const frame = this.codec.decodeServer(rawData(data));
          if (phase === "handshaking") {
            if (frame.type !== "ready") throw new Error("Connector ready frame이 필요합니다");
            phase = "ready";
            reachedReady = true;
            clearTimeout(handshakeTimer);
            heartbeat();
            heartbeatTimer = setInterval(() => {
              try {
                heartbeat();
              } catch {
                terminateSoon();
              }
            }, this.heartbeatIntervalMs);
            heartbeatTimer.unref();
            return;
          }
          if (phase !== "ready" || frame.type === "ready")
            throw new Error("Connector server frame 순서가 유효하지 않습니다");
          if (frame.type === "cancel") {
            void this.executor.cancel(frame).catch(() => {
              terminateSoon();
            });
            return;
          }
          void this.executor.execute(frame, (event: ConnectorEventFrame) => {
            send(this.codec.encodeEvent(event));
          });
        } catch {
          terminateSoon();
        }
      });
      socket.on("error", () => {
        // 원문 transport 오류를 log나 원격 frame에 포함하지 않습니다.
      });
      socket.on("close", () => {
        finish(
          phase === "ready" || signal.aborted ? undefined : new Error("Connector handshake가 완료되지 않았습니다"),
        );
      });
    });
  }

  private nextNonce(): string {
    this.nonceCounter += 1;
    if (!Number.isSafeInteger(this.nonceCounter)) throw new Error("Connector nonce sequence 상한을 초과했습니다");
    return `${this.noncePrefix}.${this.nonceCounter.toString(36)}`;
  }

  private stopRequested(signal: AbortSignal | undefined): boolean {
    return this.stopping || signal?.aborted === true || this.stopController?.signal.aborted === true;
  }

  private closeCurrent(): void {
    const socket = this.currentSocket;
    if (!socket || socket.readyState === WEB_SOCKET_CLOSED) return;
    try {
      socket.close(1001, "connector shutdown");
    } catch {
      socket.terminate();
    }
  }

  private async boundedExecutorShutdown(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.executor.shutdown(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.shutdownTimeoutMs);
        timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}
