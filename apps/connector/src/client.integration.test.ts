import { execFile } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";

import type { SubscriptionAgentAdapter } from "@massion/runtime";
import {
  createEdgeWorkspaceExecutionCapability,
  createHeartbeatSignaturePayload,
  type ConnectorEvent,
  type ConnectorRequest,
} from "@massion/subscriptions";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectorChannelAuthenticator, ConnectorChannelHub } from "../../server/src/connector-channel.js";
import { ConnectorWebSocketService } from "../../server/src/connector-websocket.js";
import { EdgeConnectorClient, type EdgeWebSocket, type EdgeWebSocketFactory } from "./client.js";
import { EdgeRequestExecutor } from "./executor.js";
import { ConnectorIdentityStore } from "./identity-store.js";
import { fixtureDirectory } from "./test-fixtures.js";

const executeFile = promisify(execFile);
const require = createRequire(import.meta.url);

interface TestWebSocketConstructor {
  new (
    url: string,
    protocols: readonly string[],
    options: {
      readonly ca: Buffer;
      readonly perMessageDeflate: false;
      readonly maxPayload: number;
      readonly followRedirects: false;
      readonly handshakeTimeout: number;
    },
  ): EdgeWebSocket;
}

const TestWebSocket = (require("ws") as { readonly WebSocket: TestWebSocketConstructor }).WebSocket;

describe("실제 WSS Edge Connector 왕복", () => {
  const cleanups: Array<() => Promise<void>> = [];
  const services = new Set<ConnectorWebSocketService>();
  const servers = new Set<Server>();

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
    await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
  });

  it("실제 TLS WebSocket server와 fake adapter 사이에서 handshake·heartbeat·agent-turn·shutdown을 완주한다", async () => {
    const fixture = await fixtureDirectory("massion-connector-wss-");
    cleanups.push(fixture.cleanup);
    const keyPath = join(fixture.path, "tls.key");
    const certificatePath = join(fixture.path, "tls.crt");
    await executeFile("/usr/bin/openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
    ]);
    const [key, certificate] = await Promise.all([readFile(keyPath), readFile(certificatePath)]);
    const profileRoot = join(fixture.path, "profile");
    const workspaceRoot = join(fixture.path, "workspace");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(profileRoot, { mode: 0o700 });
    await mkdir(workspaceRoot, { mode: 0o700 });
    const identityPath = join(fixture.path, "identity.json");
    const pending = await ConnectorIdentityStore.createPending(identityPath, {
      baseUrl: "https://localhost",
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
    const identity = await new ConnectorIdentityStore(identityPath).activate(pending, {
      organizationId: "organization-12345678",
      userId: "user-owner-12345678",
      membershipId: "membership-12345678",
      role: "owner",
    });
    const claimed = new Set<string>();
    const authenticator = new ConnectorChannelAuthenticator({
      publicKeys: { findPublicKey: async () => identity.publicKey },
      nonceClaims: {
        async claim(input) {
          if (claimed.has(input.nonceHash)) return false;
          claimed.add(input.nonceHash);
          return true;
        },
      },
      maximumClockSkewMs: 60_000,
    });
    const lifecycle: string[] = [];
    const heartbeatNonces: string[] = [];
    const hub = new ConnectorChannelHub();
    const server = createServer({ key, cert: certificate });
    servers.add(server);
    const service = new ConnectorWebSocketService({
      server,
      path: "/connectors",
      hub,
      authenticator,
      lifecycle: {
        async connected(input) {
          lifecycle.push(`connected:${input.connectorId}`);
        },
        async heartbeat(input) {
          expect(
            verify(
              null,
              createHeartbeatSignaturePayload(input),
              createPublicKey(identity.publicKey),
              Buffer.from(input.signature, "base64url"),
            ),
          ).toBe(true);
          heartbeatNonces.push(input.nonce);
        },
        async disconnected(input) {
          lifecycle.push(`disconnected:${input.connectorId}`);
        },
        async expire() {
          return 0;
        },
      },
      handshakeTimeoutMs: 2_000,
      closeGracePeriodMs: 100,
      expirySweepIntervalMs: 60_000,
    });
    services.add(service);
    await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("테스트 WSS 주소가 유효하지 않습니다");
    const activeIdentity = { ...identity, baseUrl: `https://localhost:${String(address.port)}` };

    const adapter: SubscriptionAgentAdapter = {
      execute: async (_context, input) => ({
        outcome: "completed",
        executionId: input.executionId,
        sessionId: "session-wss-12345678",
        value: "실제 채널 완료",
        usage: { input_tokens: 7, output_tokens: 2 },
      }),
      resume: vi.fn(),
      cancel: vi.fn(),
    };
    const healthProbe = {
      verify: vi.fn(async (input: { readonly expectedAuthKind: "cli-profile" | "api-key" }) => ({
        authKind: input.expectedAuthKind,
      })),
    };
    const executor = new EdgeRequestExecutor({
      identity: activeIdentity,
      factory: { create: () => adapter },
      healthProbe,
    });
    const socketFactory: EdgeWebSocketFactory = (url, protocol, options) =>
      new TestWebSocket(url.toString(), [protocol], { ...options, ca: certificate });
    const client = new EdgeConnectorClient({
      identity: activeIdentity,
      executor,
      socketFactory,
      heartbeatIntervalMs: 20,
      handshakeTimeoutMs: 2_000,
      maximumReconnectAttempts: 2,
      healthProbe,
    });
    const stop = new AbortController();
    const running = client.run(stop.signal);
    await expect.poll(() => lifecycle.includes("connected:connector-12345678")).toBe(true);

    const request: ConnectorRequest = {
      protocol: "massion.connector.v1",
      requestId: "request-wss-12345678",
      leaseId: "lease-wss-12345678",
      operation: "agent-turn",
      payload: {
        providerId: "openai-codex",
        modelId: "gpt-5.6",
        accountId: "account-wss-12345678",
        routeAttemptId: "route-attempt-wss-12345678",
        sessionLeaseId: "lease-wss-12345678",
        executionId: "execution-wss-12345678",
        workId: "work-wss-12345678",
        agentHandle: "software-engineering.backend-specialist",
        prompt: "실제 WSS를 검증해주세요",
        workspaceCapability: createEdgeWorkspaceExecutionCapability(
          identity.capabilities.find((capability) => capability.startsWith("massion.workspace-root.v1.")) ?? "",
          {
            organizationId: identity.organizationId,
            connectorId: identity.connectorId,
            providerId: identity.providerId,
            accountId: "account-wss-12345678",
            routeAttemptId: "route-attempt-wss-12345678",
            sessionLeaseId: "lease-wss-12345678",
            executionId: "execution-wss-12345678",
            workId: "work-wss-12345678",
            agentHandle: "software-engineering.backend-specialist",
          },
        ),
        allowedTools: [],
        disallowedTools: [],
        policy: { sandboxMode: "workspace-write", approvalPolicy: "never", networkAccessEnabled: false },
      },
    };
    expect(JSON.stringify(request)).not.toContain(workspaceRoot);
    const events: ConnectorEvent[] = [];
    for await (const event of hub.invoke(identity.organizationId, identity.connectorId, request)) events.push(event);
    expect(events.map((event) => event.kind)).toEqual(["data", "usage", "done"]);
    expect(events[0]?.payload).toEqual({ type: "text-delta", delta: "실제 채널 완료" });
    expect(healthProbe.verify).toHaveBeenCalledTimes(2);
    expect(healthProbe.verify).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        providerId: identity.providerId,
        profileRoot: identity.profileRoot,
        expectedAuthKind: identity.authKind,
        billingKind: identity.billingKind,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(healthProbe.verify).toHaveBeenNthCalledWith(2, {
      providerId: identity.providerId,
      profileRoot: identity.profileRoot,
      expectedAuthKind: identity.authKind,
      billingKind: identity.billingKind,
    });
    await expect.poll(() => heartbeatNonces.length >= 2).toBe(true);
    expect(new Set(heartbeatNonces).size).toBe(heartbeatNonces.length);

    stop.abort("test shutdown");
    await expect(running).resolves.toBeUndefined();
    await expect.poll(() => lifecycle.includes("disconnected:connector-12345678")).toBe(true);
  }, 15_000);
});
