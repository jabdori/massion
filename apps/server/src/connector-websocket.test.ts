import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";

import type { ConnectorEvent, ConnectorRequest } from "@massion/subscriptions";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONNECTOR_HANDSHAKE_MAX_BYTES,
  ConnectorChannelAuthenticator,
  ConnectorChannelHub,
  createChannelHandshakePayload,
  type ConnectorChannelHandshake,
} from "./connector-channel.js";
import {
  assertConnectorSendCapacity,
  ConnectorWebSocketService,
  isSecureConnectorUpgrade,
} from "./connector-websocket.js";

interface TestWebSocket {
  readonly bufferedAmount: number;
  readonly readyState: number;
  on(event: "open", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  once(event: "message", listener: (data: Buffer, isBinary: boolean) => void): this;
  once(event: "close", listener: (code: number, reason: Buffer) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
  send(data: string): void;
  close(): void;
}

interface TestWebSocketConstructor {
  new (url: string, options?: { readonly headers?: Readonly<Record<string, string>> }): TestWebSocket;
}

const require = createRequire(import.meta.url);
const TestWebSocket = (require("ws") as { readonly WebSocket: TestWebSocketConstructor }).WebSocket;

const servers = new Set<Server>();
const services = new Set<ConnectorWebSocketService>();

afterEach(async () => {
  await Promise.all([...services].map(async (service) => await service.shutdown()));
  services.clear();
  await Promise.all(
    [...servers].map(
      async (server) =>
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers.clear();
});

function handshake(privateKey: KeyObject, nonce: string): ConnectorChannelHandshake {
  const unsigned = {
    protocol: "massion.connector.v1" as const,
    type: "handshake" as const,
    organizationId: "organization-1",
    connectorId: "edge-1",
    nonce,
    observedAt: "2030-01-01T00:00:00.000Z",
  };
  return {
    ...unsigned,
    signature: sign(null, createChannelHandshakePayload(unsigned), privateKey).toString("base64url"),
  };
}

function request(requestId: string, leaseId = "lease-1"): ConnectorRequest {
  return {
    protocol: "massion.connector.v1",
    requestId,
    leaseId,
    operation: "health",
    payload: {},
  };
}

async function collect(iterable: AsyncIterable<ConnectorEvent>): Promise<ConnectorEvent[]> {
  const events: ConnectorEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

async function waitForOpen(socket: TestWebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    socket.once("error", onError);
    socket.on("open", () => {
      socket.off("error", onError);
      resolve();
    });
  });
}

async function nextJson(socket: TestWebSocket): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("message", (data, isBinary) => {
      if (isBinary) return reject(new Error("테스트 protocol frame은 text여야 합니다"));
      resolve(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
    });
  });
}

async function waitForClose(socket: TestWebSocket): Promise<{ readonly code: number; readonly reason: string }> {
  return await new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
  });
}

async function createHarness(
  options: {
    readonly requestTimeoutMs?: number;
    readonly maximumPendingRequests?: number;
    readonly trustedProxyAddresses?: readonly string[];
    readonly expirySweepIntervalMs?: number;
    readonly expire?: () => Promise<number | undefined>;
  } = {},
): Promise<{
  readonly hub: ConnectorChannelHub;
  readonly privateKey: KeyObject;
  readonly url: string;
  readonly lifecycleEvents: string[];
  connect(headers?: Readonly<Record<string, string>>): Promise<TestWebSocket>;
}> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const claimed = new Set<string>();
  const authenticator = new ConnectorChannelAuthenticator({
    now: () => new Date("2030-01-01T00:00:00.000Z"),
    publicKeys: {
      async findPublicKey() {
        return publicKey.export({ type: "spki", format: "pem" }).toString();
      },
    },
    nonceClaims: {
      async claim(input) {
        if (claimed.has(input.nonceHash)) return false;
        claimed.add(input.nonceHash);
        return true;
      },
    },
  });
  const hub = new ConnectorChannelHub();
  const lifecycleEvents: string[] = [];
  const server = createServer();
  servers.add(server);
  const service = new ConnectorWebSocketService({
    server,
    path: "/connectors",
    hub,
    authenticator,
    lifecycle: {
      async connected(input) {
        lifecycleEvents.push(`connected:${input.organizationId}:${input.connectorId}`);
      },
      async heartbeat(input) {
        lifecycleEvents.push(`heartbeat:${input.organizationId}:${input.connectorId}:${input.version}`);
      },
      async disconnected(input) {
        lifecycleEvents.push(`disconnected:${input.organizationId}:${input.connectorId}`);
      },
      async expire() {
        lifecycleEvents.push("expire");
        return await options.expire?.();
      },
    },
    trustedProxyAddresses: options.trustedProxyAddresses ?? ["127.0.0.1"],
    requestTimeoutMs: options.requestTimeoutMs,
    maximumPendingRequests: options.maximumPendingRequests,
    handshakeTimeoutMs: 250,
    closeGracePeriodMs: 50,
    expirySweepIntervalMs: options.expirySweepIntervalMs ?? 10_000,
  });
  services.add(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("테스트 server 주소가 유효하지 않습니다");
  const url = `ws://127.0.0.1:${address.port}/connectors`;
  return {
    hub,
    privateKey,
    url,
    lifecycleEvents,
    async connect(headers = { "x-forwarded-proto": "https" }) {
      const socket = new TestWebSocket(url, { headers });
      await waitForOpen(socket);
      return socket;
    },
  };
}

async function authenticate(socket: TestWebSocket, privateKey: KeyObject, nonce: string): Promise<void> {
  const ready = nextJson(socket);
  socket.send(JSON.stringify(handshake(privateKey, nonce)));
  await expect(ready).resolves.toEqual({ protocol: "massion.connector.v1", type: "ready" });
}

describe("Edge Connector WebSocket 전송", () => {
  it("직접 TLS 또는 신뢰된 proxy의 https 전달만 secure 연결로 인정한다", () => {
    expect(isSecureConnectorUpgrade({ encrypted: true, trustedProxyAddresses: [], forwardedProto: undefined })).toBe(
      true,
    );
    expect(
      isSecureConnectorUpgrade({
        encrypted: false,
        remoteAddress: "127.0.0.1",
        trustedProxyAddresses: ["127.0.0.1"],
        forwardedProto: "https",
      }),
    ).toBe(true);
    expect(
      isSecureConnectorUpgrade({
        encrypted: false,
        remoteAddress: "192.0.2.1",
        trustedProxyAddresses: ["127.0.0.1"],
        forwardedProto: "https",
      }),
    ).toBe(false);
    expect(
      isSecureConnectorUpgrade({
        encrypted: false,
        remoteAddress: "127.0.0.1",
        trustedProxyAddresses: ["127.0.0.1"],
        forwardedProto: "http, https",
      }),
    ).toBe(false);
  });

  it("실제 upgrade에서 TLS를 사칭한 신뢰되지 않은 proxy 주소를 HTTP 403으로 거부한다", async () => {
    const harness = await createHarness({ trustedProxyAddresses: ["192.0.2.1"] });
    const socket = new TestWebSocket(harness.url, { headers: { "x-forwarded-proto": "https" } });
    await expect(waitForOpen(socket)).rejects.toThrow("403");
  });

  it("첫 text frame handshake 뒤 Hub RPC를 exact request·lease와 단조 sequence로 왕복한다", async () => {
    const harness = await createHarness();
    const socket = await harness.connect();
    await authenticate(socket, harness.privateKey, "nonce-roundtrip-1");
    expect(harness.lifecycleEvents).toContain("connected:organization-1:edge-1");

    const result = collect(harness.hub.invoke("organization-1", "edge-1", request("request-1")));
    await expect(nextJson(socket)).resolves.toMatchObject({
      protocol: "massion.connector.v1",
      type: "request",
      requestId: "request-1",
      leaseId: "lease-1",
    });
    socket.send(
      JSON.stringify({
        protocol: "massion.connector.v1",
        type: "event",
        requestId: "request-1",
        leaseId: "lease-1",
        sequence: 0,
        kind: "data",
        payload: { text: "ok" },
      }),
    );
    socket.send(
      JSON.stringify({
        protocol: "massion.connector.v1",
        type: "event",
        requestId: "request-1",
        leaseId: "lease-1",
        sequence: 1,
        kind: "done",
        payload: {},
      }),
    );
    await expect(result).resolves.toEqual([
      { kind: "data", sequence: 0, payload: { text: "ok" } },
      { kind: "done", sequence: 1, payload: {} },
    ]);

    const closed = waitForClose(socket);
    socket.send(
      JSON.stringify({
        protocol: "massion.connector.v1",
        type: "event",
        requestId: "request-1",
        leaseId: "lease-1",
        sequence: 2,
        kind: "done",
        payload: {},
      }),
    );
    await expect(closed).resolves.toMatchObject({ code: 1008 });
  });

  it("인증 lifecycle·서명 heartbeat·주기적 expiry sweep을 영속 adapter port에 전달한다", async () => {
    const harness = await createHarness({ expirySweepIntervalMs: 20 });
    const socket = await harness.connect();
    await authenticate(socket, harness.privateKey, "nonce-lifecycle-1");
    socket.send(
      JSON.stringify({
        protocol: "massion.connector.v1",
        type: "heartbeat",
        version: "1.2.3",
        capabilities: ["codex"],
        observedAt: "2030-01-01T00:00:00.000Z",
        profileHealthObservedAt: "2030-01-01T00:00:00.000Z",
        nonce: "heartbeat-nonce-1",
        signature: "A".repeat(86),
      }),
    );

    await expect.poll(() => harness.lifecycleEvents.includes("heartbeat:organization-1:edge-1:1.2.3")).toBe(true);
    await expect.poll(() => harness.lifecycleEvents.includes("expire")).toBe(true);
    const closed = waitForClose(socket);
    socket.close();
    await closed;
    await expect.poll(() => harness.lifecycleEvents.includes("disconnected:organization-1:edge-1")).toBe(true);
  });

  it("느린 expiry sweep을 중첩 실행하지 않는다", async () => {
    let calls = 0;
    let releaseFirst: (() => void) | undefined;
    const firstSweep = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    await createHarness({
      expirySweepIntervalMs: 10,
      async expire() {
        calls += 1;
        if (calls === 1) await firstSweep;
        return 0;
      },
    });

    await expect.poll(() => calls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toBe(1);
    releaseFirst?.();
    await expect.poll(() => calls > 1).toBe(true);
  });

  it("lease binding이나 sequence가 다르면 연결을 닫고 pending 요청을 실패시킨다", async () => {
    const harness = await createHarness();
    const socket = await harness.connect();
    await authenticate(socket, harness.privateKey, "nonce-binding-01");
    const result = collect(harness.hub.invoke("organization-1", "edge-1", request("request-binding")));
    await nextJson(socket);
    const closed = waitForClose(socket);
    socket.send(
      JSON.stringify({
        protocol: "massion.connector.v1",
        type: "event",
        requestId: "request-binding",
        leaseId: "wrong-lease",
        sequence: 0,
        kind: "done",
        payload: { secret: "반환되면 안 됩니다" },
      }),
    );

    await expect(result).rejects.toThrow("protocol");
    await expect(closed).resolves.toMatchObject({ code: 1008 });
  });

  it("AbortSignal과 timeout은 exact cancel frame을 보내고 pending을 정리한다", async () => {
    const harness = await createHarness({ requestTimeoutMs: 40 });
    const socket = await harness.connect();
    await authenticate(socket, harness.privateKey, "nonce-cancel-001");

    const controller = new AbortController();
    const aborted = collect(
      harness.hub.invoke("organization-1", "edge-1", request("request-abort", "lease-abort"), controller.signal),
    );
    const abortedExpectation = expect(aborted).rejects.toThrow("취소");
    await nextJson(socket);
    const abortFrame = nextJson(socket);
    controller.abort();
    await expect(abortFrame).resolves.toMatchObject({
      type: "cancel",
      requestId: "request-abort",
      leaseId: "lease-abort",
      reason: "aborted",
    });
    await abortedExpectation;

    const timedOut = collect(
      harness.hub.invoke("organization-1", "edge-1", request("request-timeout", "lease-timeout")),
    );
    const timedOutExpectation = expect(timedOut).rejects.toThrow("시간");
    await nextJson(socket);
    await expect(nextJson(socket)).resolves.toMatchObject({
      type: "cancel",
      requestId: "request-timeout",
      leaseId: "lease-timeout",
      reason: "timeout",
    });
    await timedOutExpectation;
  });

  it("pending request 상한과 bufferedAmount backpressure 상한을 fail closed한다", async () => {
    expect(() => assertConnectorSendCapacity({ bufferedAmount: 8, encodedBytes: 9, maximumBufferedBytes: 16 })).toThrow(
      "backpressure",
    );

    const harness = await createHarness({ maximumPendingRequests: 1 });
    const socket = await harness.connect();
    await authenticate(socket, harness.privateKey, "nonce-pending-01");
    const first = collect(harness.hub.invoke("organization-1", "edge-1", request("request-first")));
    const firstExpectation = expect(first).rejects.toThrow("닫혔");
    await nextJson(socket);
    await expect(
      collect(harness.hub.invoke("organization-1", "edge-1", request("request-second", "lease-second"))),
    ).rejects.toThrow("pending");

    const closed = waitForClose(socket);
    socket.close();
    await closed;
    await firstExpectation;
  });

  it("첫 frame이 handshake가 아니거나 handshake byte 상한을 넘으면 인증 전에 거부한다", async () => {
    const harness = await createHarness();
    const wrongFirst = await harness.connect();
    const wrongClosed = waitForClose(wrongFirst);
    wrongFirst.send(JSON.stringify({ protocol: "massion.connector.v1", type: "event" }));
    await expect(wrongClosed).resolves.toMatchObject({ code: 1008, reason: "authentication failed" });

    const oversized = await harness.connect();
    const oversizedClosed = waitForClose(oversized);
    oversized.send("x".repeat(CONNECTOR_HANDSHAKE_MAX_BYTES + 1));
    await expect(oversizedClosed).resolves.toMatchObject({ code: 1008, reason: "authentication failed" });
  });

  it("인증 뒤 단일 frame 1 MiB 상한을 넘으면 socket과 pending 요청을 정리한다", async () => {
    const harness = await createHarness();
    const socket = await harness.connect();
    await authenticate(socket, harness.privateKey, "nonce-frame-limit-1");
    const result = collect(harness.hub.invoke("organization-1", "edge-1", request("request-frame-limit")));
    const resultExpectation = expect(result).rejects.toThrow("닫혔");
    await nextJson(socket);
    const closed = waitForClose(socket);
    socket.send("x".repeat(1024 * 1024 + 1));
    await expect(closed).resolves.toMatchObject({ code: 1009 });
    await resultExpectation;
  });

  it("중복 Connector 연결을 거부하고 service shutdown에서 Hub를 분리한다", async () => {
    const harness = await createHarness();
    const first = await harness.connect();
    await authenticate(first, harness.privateKey, "nonce-duplicate-1");
    const second = await harness.connect();
    const duplicateClosed = waitForClose(second);
    second.send(JSON.stringify(handshake(harness.privateKey, "nonce-duplicate-2")));
    await expect(duplicateClosed).resolves.toMatchObject({ code: 1008, reason: "authentication failed" });

    const service = [...services][0];
    if (!service) throw new Error("테스트 service가 없습니다");
    await service.shutdown();
    services.delete(service);
    await expect(
      collect(harness.hub.invoke("organization-1", "edge-1", request("request-after-shutdown"))),
    ).rejects.toThrow("연결되지 않았습니다");
  });
});
