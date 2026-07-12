import { createPublicKey, verify } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { createHeartbeatSignaturePayload } from "@massion/subscriptions";
import { afterEach, describe, expect, it } from "vitest";

import {
  ConnectorChannelAuthenticator,
  ConnectorFrameCodec as ServerFrameCodec,
  createChannelHandshakePayload,
} from "../../server/src/connector-channel.js";
import { ConnectorIdentityStore } from "./identity-store.js";
import {
  CONNECTOR_REQUEST_MAX_BYTES,
  ConnectorClientFrameCodec,
  createSignedHandshake,
  createSignedHeartbeat,
} from "./protocol.js";
import { fixtureDirectory } from "./test-fixtures.js";

describe("Edge Connector protocol codec", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
  });

  async function identity() {
    const fixture = await fixtureDirectory("massion-connector-protocol-");
    cleanups.push(fixture.cleanup);
    const profileRoot = join(fixture.path, "profile");
    const workspaceRoot = join(fixture.path, "workspace");
    await mkdir(profileRoot, { mode: 0o700 });
    await mkdir(workspaceRoot, { mode: 0o700 });
    const pending = await ConnectorIdentityStore.createPending(join(fixture.path, "identity.json"), {
      baseUrl: "https://massion.example",
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
    return await new ConnectorIdentityStore(join(fixture.path, "identity.json")).activate(pending, {
      organizationId: "organization-12345678",
      userId: "user-owner-12345678",
      membershipId: "membership-12345678",
      role: "owner",
    });
  }

  it("서버의 실제 authenticator가 handshake 서명과 일회 nonce를 검증한다", async () => {
    const active = await identity();
    const handshake = createSignedHandshake(active, "2026-07-12T10:00:00.000Z", "handshake-nonce-12345678");
    expect(
      verify(
        null,
        createChannelHandshakePayload(handshake),
        createPublicKey(active.publicKey),
        Buffer.from(handshake.signature, "base64url"),
      ),
    ).toBe(true);
    const authenticator = new ConnectorChannelAuthenticator({
      publicKeys: { findPublicKey: async () => active.publicKey },
      nonceClaims: { claim: async () => true },
      now: () => new Date("2026-07-12T10:00:00.000Z"),
    });
    await expect(authenticator.verify({ secure: true, handshake })).resolves.toMatchObject({
      organizationId: active.organizationId,
      connectorId: active.connectorId,
    });
  });

  it("heartbeat마다 새 nonce로 서버 Registry와 동일한 payload에 서명한다", async () => {
    const active = await identity();
    const heartbeat = createSignedHeartbeat(
      active,
      "2026-07-12T10:00:05.000Z",
      "2026-07-12T10:00:04.000Z",
      "heartbeat-nonce-12345678",
    );
    expect(
      verify(
        null,
        createHeartbeatSignaturePayload({
          organizationId: active.organizationId,
          connectorId: active.connectorId,
          version: heartbeat.version,
          capabilities: heartbeat.capabilities,
          observedAt: heartbeat.observedAt,
          profileHealthObservedAt: heartbeat.profileHealthObservedAt,
          nonce: heartbeat.nonce,
        }),
        createPublicKey(active.publicKey),
        Buffer.from(heartbeat.signature, "base64url"),
      ),
    ).toBe(true);
  });

  it("서버 codec이 만든 request·cancel만 exact field로 받고 event를 서버 codec과 호환되게 보낸다", async () => {
    const server = new ServerFrameCodec();
    const client = new ConnectorClientFrameCodec();
    const request = {
      protocol: "massion.connector.v1" as const,
      requestId: "request-12345678",
      leaseId: "lease-12345678",
      operation: "agent-turn" as const,
      payload: { prompt: "hello" },
    };
    expect(client.decodeServer(server.encodeRequest(request))).toMatchObject({ type: "request", ...request });
    expect(
      client.decodeServer(
        server.encode({
          protocol: "massion.connector.v1",
          type: "cancel",
          requestId: request.requestId,
          leaseId: request.leaseId,
          reason: "timeout",
        }),
      ),
    ).toMatchObject({ type: "cancel", reason: "timeout" });
    expect(
      server.decodeEvent(
        client.encodeEvent({
          requestId: request.requestId,
          leaseId: request.leaseId,
          sequence: 0,
          kind: "data",
          payload: { type: "text-delta", delta: "hello" },
        }),
      ),
    ).toMatchObject({ type: "event", sequence: 0, kind: "data" });
  });

  it("알 수 없는 field, binary 상한 초과, prototype key를 fail-closed로 거부한다", () => {
    const client = new ConnectorClientFrameCodec();
    expect(() =>
      client.decodeServer(
        Buffer.from(
          JSON.stringify({
            protocol: "massion.connector.v1",
            type: "ready",
            unexpected: true,
          }),
        ),
      ),
    ).toThrow(/알 수 없는 필드/u);
    expect(() => client.decodeServer(Buffer.alloc(CONNECTOR_REQUEST_MAX_BYTES + 1))).toThrow(/byte 상한/u);
    expect(() =>
      client.decodeServer(
        Buffer.from(
          '{"protocol":"massion.connector.v1","type":"request","requestId":"request-12345678","leaseId":"lease-12345678","operation":"agent-turn","payload":{"__proto__":{}}}',
        ),
      ),
    ).toThrow(/금지된 object key/u);
  });
});
