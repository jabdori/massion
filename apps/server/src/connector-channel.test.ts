import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ConnectorChannelAuthenticator,
  ConnectorChannelHub,
  ConnectorFrameCodec,
  createChannelHandshakePayload,
} from "./connector-channel.js";

describe("구독 Connector 보안 채널", () => {
  it("TLS와 장치 서명을 요구하고 handshake nonce 재사용을 거부한다", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const authenticator = new ConnectorChannelAuthenticator({
      now: () => new Date("2030-01-01T00:00:00.000Z"),
    });
    const unsigned = {
      protocol: "massion.connector.v1" as const,
      organizationId: "organization-1",
      connectorId: "edge-1",
      nonce: "channel-nonce-1",
      observedAt: "2030-01-01T00:00:00.000Z",
    };
    const handshake = {
      ...unsigned,
      signature: sign(null, createChannelHandshakePayload(unsigned), privateKey).toString("base64url"),
    };
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

    expect(authenticator.verify({ secure: true, publicKey: publicKeyPem, handshake })).toEqual({
      organizationId: "organization-1",
      connectorId: "edge-1",
    });
    expect(() => authenticator.verify({ secure: true, publicKey: publicKeyPem, handshake })).toThrow("재사용");
    expect(() =>
      authenticator.verify({ secure: false, publicKey: publicKeyPem, handshake: { ...handshake, nonce: "nonce-2" } }),
    ).toThrow("TLS");
  });

  it("frame 1 MiB와 요청 전체 16 MiB 상한을 fail closed한다", () => {
    const codec = new ConnectorFrameCodec();
    const frame = codec.encode({
      protocol: "massion.connector.v1",
      requestId: "request-1",
      leaseId: "lease-1",
      sequence: 1,
      kind: "data",
      payload: { text: "ok" },
    });
    expect(codec.decode(frame)).toMatchObject({ requestId: "request-1", sequence: 1 });
    expect(() => codec.decode(Buffer.alloc(1024 * 1024 + 1))).toThrow("frame byte 상한");
    expect(() => codec.assertRequestBytes(16 * 1024 * 1024 + 1)).toThrow("요청 byte 상한");
  });

  it("인증된 조직·Connector 연결에만 RPC를 전달하고 분리 뒤 거부한다", async () => {
    const hub = new ConnectorChannelHub();
    const detached = hub.attach(
      { organizationId: "organization-1", connectorId: "edge-1" },
      {
        async *invoke() {
          yield { kind: "done" as const, sequence: 0, payload: {} };
        },
        async close() {},
      },
    );
    const request = {
      protocol: "massion.connector.v1" as const,
      requestId: "request-1",
      leaseId: "lease-1",
      operation: "health" as const,
      payload: {},
    };

    const events = [];
    for await (const event of hub.invoke("organization-1", "edge-1", request)) events.push(event);
    expect(events).toEqual([{ kind: "done", sequence: 0, payload: {} }]);
    await detached();
    await expect(async () => {
      for await (const _event of hub.invoke("organization-1", "edge-1", request)) {
        // 연결 해제 오류를 반복 과정에서 받습니다.
      }
    }).rejects.toThrow("연결되지 않았습니다");
  });
});
