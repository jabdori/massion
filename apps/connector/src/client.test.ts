import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EdgeConnectorClient, type EdgeWebSocket, type EdgeWebSocketFactory } from "./client.js";
import { EdgeRequestExecutor } from "./executor.js";
import { ConnectorIdentityStore } from "./identity-store.js";
import { ProviderReauthenticationRequiredError } from "./profile-health.js";
import { ProviderProfilePermissionError } from "./profile-permissions.js";
import { fixtureDirectory } from "./test-fixtures.js";

class ScriptedSocket extends EventEmitter implements EdgeWebSocket {
  public bufferedAmount = 0;
  public readyState = 0;
  public protocol = "massion.connector.v1";
  public readonly frames: Array<Record<string, unknown>> = [];

  public constructor(private readonly closeAfterReady: boolean) {
    super();
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open");
    });
  }

  public send(data: string, _options: { readonly binary: false; readonly compress: false }): void {
    void _options;
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.frames.push(frame);
    if (frame.type === "handshake") {
      queueMicrotask(() => {
        this.emit("message", Buffer.from(JSON.stringify({ protocol: "massion.connector.v1", type: "ready" })), false);
        if (this.closeAfterReady) {
          queueMicrotask(() => {
            this.readyState = 3;
            this.emit("close", 1006, Buffer.alloc(0));
          });
        }
      });
    }
  }

  public close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", 1001, Buffer.alloc(0)));
  }

  public terminate(): void {
    this.close();
  }
}

describe("Edge Connector 재연결", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
  });

  const healthyProfile = {
    verify: vi.fn(async (input: { readonly expectedAuthKind: "cli-profile" | "api-key" }) => ({
      authKind: input.expectedAuthKind,
    })),
  };

  async function identity() {
    const fixture = await fixtureDirectory("massion-connector-client-");
    cleanups.push(fixture.cleanup);
    const profileRoot = join(fixture.path, "profile");
    const workspaceRoot = join(fixture.path, "workspace");
    await mkdir(profileRoot, { mode: 0o700 });
    await mkdir(workspaceRoot, { mode: 0o700 });
    const path = join(fixture.path, "identity.json");
    const pending = await ConnectorIdentityStore.createPending(path, {
      baseUrl: "https://massion.example:8443",
      enrollmentId: "enrollment-12345678",
      connectorId: "connector-12345678",
      commandId: "connector-command-12345678",
      providerId: "openai-codex",
      accountAlias: "개인 Codex",
      authKind: "cli-profile",
      billingKind: "consumer-subscription",
      enrollmentDigest: "a".repeat(64),
      profileRoot,
      workspaceRoots: [workspaceRoot],
    });
    return await new ConnectorIdentityStore(path).activate(pending, {
      organizationId: "organization-12345678",
      userId: "user-owner-12345678",
      membershipId: "membership-12345678",
      role: "owner",
    });
  }

  it("bounded backoff 뒤 다시 wss에 연결하며 handshake·heartbeat nonce를 재사용하지 않는다", async () => {
    const active = await identity();
    const sockets: ScriptedSocket[] = [];
    const urls: string[] = [];
    const socketFactory: EdgeWebSocketFactory = (url, _protocol, options) => {
      expect(options).toEqual({
        perMessageDeflate: false,
        maxPayload: 16 * 1024 * 1024,
        followRedirects: false,
        handshakeTimeout: 500,
      });
      urls.push(url.toString());
      const socket = new ScriptedSocket(sockets.length === 0);
      sockets.push(socket);
      return socket;
    };
    const sleep = vi.fn(async () => undefined);
    const executor = new EdgeRequestExecutor({ identity: active, factory: { create: vi.fn() } });
    const client = new EdgeConnectorClient({
      identity: active,
      executor,
      socketFactory,
      heartbeatIntervalMs: 300_000,
      handshakeTimeoutMs: 500,
      maximumReconnectAttempts: 2,
      reconnectBaseDelayMs: 25,
      reconnectMaximumDelayMs: 100,
      noncePrefix: "unit-test-nonce-prefix",
      sleep,
      healthProbe: healthyProfile,
    });
    const stop = new AbortController();
    const running = client.run(stop.signal);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await vi.waitFor(() => expect(sockets[1]?.frames.some((frame) => frame.type === "heartbeat")).toBe(true));
    stop.abort();
    await running;

    expect(urls).toEqual(["wss://massion.example:8443/connectors", "wss://massion.example:8443/connectors"]);
    expect(sleep).toHaveBeenCalledWith(25, expect.any(AbortSignal));
    expect(healthyProfile.verify).toHaveBeenCalledTimes(2);
    const nonces = sockets.flatMap((socket) =>
      socket.frames.flatMap((frame) => (typeof frame.nonce === "string" ? [frame.nonce] : [])),
    );
    expect(nonces.length).toBeGreaterThanOrEqual(4);
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  it("연속 연결 실패가 상한을 넘으면 원문 transport 오류 없이 종료한다", async () => {
    const active = await identity();
    let attempts = 0;
    const socketFactory: EdgeWebSocketFactory = () => {
      attempts += 1;
      const socket = new ScriptedSocket(false);
      queueMicrotask(() => {
        socket.readyState = 3;
        socket.emit("close", 1006, Buffer.from("Bearer secret user@example.com"));
      });
      return socket;
    };
    const logs: string[] = [];
    const executor = new EdgeRequestExecutor({ identity: active, factory: { create: vi.fn() } });
    const client = new EdgeConnectorClient({
      identity: active,
      executor,
      socketFactory,
      maximumReconnectAttempts: 1,
      reconnectBaseDelayMs: 1,
      reconnectMaximumDelayMs: 1,
      sleep: async () => undefined,
      log: (message) => logs.push(message),
      healthProbe: healthyProfile,
    });

    await expect(client.run()).rejects.toThrow(/재연결 횟수 상한/u);
    expect(attempts).toBe(2);
    expect(JSON.stringify(logs)).not.toContain("Bearer secret");
    expect(JSON.stringify(logs)).not.toContain("user@example.com");
  });

  it("연결 종료 시 실행기 취소가 멈춰도 shutdown timeout 안에 재연결 판단을 계속한다", async () => {
    const active = await identity();
    class HangingShutdownExecutor extends EdgeRequestExecutor {
      public override shutdown(): Promise<void> {
        return new Promise(() => undefined);
      }
    }
    const executor = new HangingShutdownExecutor({ identity: active, factory: { create: vi.fn() } });
    const client = new EdgeConnectorClient({
      identity: active,
      executor,
      socketFactory: () => {
        const socket = new ScriptedSocket(false);
        queueMicrotask(() => {
          socket.readyState = 3;
          socket.emit("close", 1006, Buffer.alloc(0));
        });
        return socket;
      },
      heartbeatIntervalMs: 300_000,
      handshakeTimeoutMs: 500,
      maximumReconnectAttempts: 0,
      shutdownTimeoutMs: 50,
      healthProbe: healthyProfile,
    });

    const outcome = await Promise.race([
      client.run().then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.message : "unknown-error"),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 250)),
    ]);

    expect(outcome).toMatch(/재연결 횟수 상한/u);
  });

  it("ready 연결이 성립하면 이전 실패 횟수를 초기화하고 이후 연속 실패만 센다", async () => {
    const active = await identity();
    const sockets: ScriptedSocket[] = [];
    const socketFactory: EdgeWebSocketFactory = () => {
      const attempt = sockets.length + 1;
      const socket = new ScriptedSocket(attempt === 2);
      sockets.push(socket);
      if (attempt === 1 || attempt === 3) {
        queueMicrotask(() => {
          socket.readyState = 3;
          socket.emit("close", 1006, Buffer.alloc(0));
        });
      }
      return socket;
    };
    const client = new EdgeConnectorClient({
      identity: active,
      executor: new EdgeRequestExecutor({ identity: active, factory: { create: vi.fn() } }),
      socketFactory,
      heartbeatIntervalMs: 300_000,
      handshakeTimeoutMs: 500,
      maximumReconnectAttempts: 2,
      reconnectBaseDelayMs: 1,
      reconnectMaximumDelayMs: 1,
      sleep: async () => undefined,
      healthProbe: healthyProfile,
    });
    const stop = new AbortController();
    const running = client.run(stop.signal);
    await vi.waitFor(() => expect(sockets).toHaveLength(4));
    await vi.waitFor(() => expect(sockets[3]?.frames.some((frame) => frame.type === "heartbeat")).toBe(true));
    stop.abort("test complete");
    await expect(running).resolves.toBeUndefined();
  });

  it("WSS 연결 전 profile health가 만료되면 socket을 열지 않고 needs-reauth로 종료한다", async () => {
    const active = await identity();
    const socketFactory = vi.fn<EdgeWebSocketFactory>();
    const healthProbe = { verify: vi.fn(() => Promise.reject(new ProviderReauthenticationRequiredError())) };
    const client = new EdgeConnectorClient({
      identity: active,
      executor: new EdgeRequestExecutor({ identity: active, factory: { create: vi.fn() } }),
      socketFactory,
      healthProbe,
    });

    await expect(client.run()).rejects.toMatchObject({ code: "needs-reauth" });
    expect(healthProbe.verify).toHaveBeenCalledWith({
      providerId: active.providerId,
      profileRoot: active.profileRoot,
      expectedAuthKind: active.authKind,
      billingKind: active.billingKind,
      signal: expect.any(AbortSignal),
    });
    expect(socketFactory).not.toHaveBeenCalled();
  });

  it("WSS 연결 전 profile 권한이 바뀌면 migration 가능한 안전 오류를 그대로 반환한다", async () => {
    const active = await identity();
    const socketFactory = vi.fn<EdgeWebSocketFactory>();
    const client = new EdgeConnectorClient({
      identity: active,
      executor: new EdgeRequestExecutor({ identity: active, factory: { create: vi.fn() } }),
      socketFactory,
      healthProbe: { verify: () => Promise.reject(new ProviderProfilePermissionError()) },
    });

    await expect(client.run()).rejects.toMatchObject({ code: "profile-permissions-required" });
    expect(socketFactory).not.toHaveBeenCalled();
  });

  it("외부 ACP heartbeat health에 등록된 runtime artifact 계보를 전달한다", async () => {
    const fixture = await fixtureDirectory("massion-connector-client-acp-");
    cleanups.push(fixture.cleanup);
    const profileRoot = join(fixture.path, "profile");
    const workspaceRoot = join(fixture.path, "workspace");
    const executable = join(fixture.path, "copilot");
    await mkdir(profileRoot, { mode: 0o700 });
    await mkdir(workspaceRoot, { mode: 0o700 });
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const path = join(fixture.path, "identity.json");
    const pending = await ConnectorIdentityStore.createPending(path, {
      baseUrl: "https://massion.example",
      enrollmentId: "enrollment-12345678",
      connectorId: "connector-12345678",
      commandId: "connector-command-12345678",
      providerId: "github-copilot",
      accountAlias: "Copilot",
      authKind: "cli-profile",
      billingKind: "consumer-subscription",
      enrollmentDigest: "a".repeat(64),
      profileRoot,
      workspaceRoots: [workspaceRoot],
      runtimeArtifact: { executable, digest: "b".repeat(64), version: "1.2.3" },
    });
    const active = await new ConnectorIdentityStore(path).activate(pending, {
      organizationId: "organization-12345678",
      userId: "user-owner-12345678",
      membershipId: "membership-12345678",
      role: "owner",
    });
    const healthProbe = { verify: vi.fn(() => Promise.reject(new ProviderReauthenticationRequiredError())) };
    const socketFactory = vi.fn<EdgeWebSocketFactory>();
    const runtimeArtifact = active.runtimeArtifact;
    if (runtimeArtifact === undefined) {
      throw new Error("external provider identity must include a runtime artifact");
    }
    const runtimeAttestor = vi.fn(async () => runtimeArtifact);

    await expect(
      new EdgeConnectorClient({
        identity: active,
        executor: new EdgeRequestExecutor({ identity: active, factory: { create: vi.fn() } }),
        healthProbe,
        runtimeAttestor,
        socketFactory,
      }).run(),
    ).rejects.toMatchObject({ code: "needs-reauth" });

    expect(healthProbe.verify).toHaveBeenCalledWith({
      providerId: "github-copilot",
      profileRoot,
      expectedAuthKind: "cli-profile",
      billingKind: "consumer-subscription",
      runtimeArtifact: active.runtimeArtifact,
      signal: expect.any(AbortSignal),
    });
    expect(runtimeAttestor).toHaveBeenCalledWith("github-copilot", active.runtimeArtifact);
    expect(socketFactory).not.toHaveBeenCalled();
  });
});
