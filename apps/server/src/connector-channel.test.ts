import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CONNECTOR_HANDSHAKE_MAX_BYTES,
  ConnectorChannelAuthenticator,
  ConnectorChannelHub,
  ConnectorFrameCodec,
  createChannelHandshakePayload,
  type ConnectorHandshakeNonceClaims,
} from "./connector-channel.js";

describe("구독 Connector 보안 채널", () => {
  it("TLS와 등록 장치 서명을 요구하고 재시작 뒤에도 handshake nonce 재사용을 거부한다", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const claimed = new Set<string>();
    const claims: ConnectorHandshakeNonceClaims = {
      async claim(input) {
        const key = `${input.organizationId}\0${input.connectorId}\0${input.nonceHash}`;
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      },
    };
    const options = {
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      publicKeys: {
        async findPublicKey() {
          return publicKey.export({ type: "spki", format: "pem" }).toString();
        },
      },
      nonceClaims: claims,
    };
    const authenticator = new ConnectorChannelAuthenticator(options);
    const unsigned = {
      protocol: "massion.connector.v1" as const,
      type: "handshake" as const,
      organizationId: "organization-1",
      connectorId: "edge-1",
      nonce: "channel-nonce-01",
      observedAt: "2030-01-01T00:00:00.000Z",
    };
    const handshake = {
      ...unsigned,
      signature: sign(null, createChannelHandshakePayload(unsigned), privateKey).toString("base64url"),
    };

    await expect(authenticator.verify({ secure: true, handshake })).resolves.toEqual({
      organizationId: "organization-1",
      connectorId: "edge-1",
      observedAt: "2030-01-01T00:00:00.000Z",
    });
    const restartedAuthenticator = new ConnectorChannelAuthenticator(options);
    await expect(restartedAuthenticator.verify({ secure: true, handshake })).rejects.toThrow("재사용");
    await expect(
      authenticator.verify({ secure: false, handshake: { ...handshake, nonce: "nonce-2" } }),
    ).rejects.toThrow("TLS");
  });

  it.each([
    [null, "handshake가 유효하지 않습니다"],
    [
      {
        protocol: "massion.connector.v0",
        type: "handshake",
        organizationId: "organization-1",
        connectorId: "edge-1",
        nonce: "channel-nonce-invalid-protocol",
        observedAt: "2030-01-01T00:00:00.000Z",
        signature: "invalid",
      },
      "protocol이 유효하지 않습니다",
    ],
  ])("신뢰하지 않은 handshake 입력 %#을 명시적으로 거부한다", async (handshake: unknown, message) => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const authenticator = new ConnectorChannelAuthenticator({
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      publicKeys: {
        async findPublicKey() {
          return publicKey.export({ type: "spki", format: "pem" }).toString();
        },
      },
      nonceClaims: {
        async claim() {
          return true;
        },
      },
    });

    await expect(authenticator.verify({ secure: true, handshake })).rejects.toThrow(message);
  });

  it("공개키 directory와 nonce 저장소의 민감한 원문 오류를 인증 경계 밖으로 노출하지 않는다", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const unsigned = {
      protocol: "massion.connector.v1" as const,
      type: "handshake" as const,
      organizationId: "organization-1",
      connectorId: "edge-1",
      nonce: "redaction-nonce-01",
      observedAt: "2030-01-01T00:00:00.000Z",
    };
    const handshake = {
      ...unsigned,
      signature: sign(null, createChannelHandshakePayload(unsigned), privateKey).toString("base64url"),
    };
    const publicKeyText = publicKey.export({ type: "spki", format: "pem" }).toString();
    const directoryFailure = new ConnectorChannelAuthenticator({
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      publicKeys: {
        async findPublicKey() {
          throw new Error("PRIVATE-KEY-RAW-SECRET");
        },
      },
      nonceClaims: {
        async claim() {
          return true;
        },
      },
    });
    const nonceFailure = new ConnectorChannelAuthenticator({
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      publicKeys: {
        async findPublicKey() {
          return publicKeyText;
        },
      },
      nonceClaims: {
        async claim() {
          throw new Error("NONCE-RAW-SECRET");
        },
      },
    });

    const directoryError = await directoryFailure.verify({ secure: true, handshake }).catch((error: unknown) => error);
    const nonceError = await nonceFailure.verify({ secure: true, handshake }).catch((error: unknown) => error);
    expect(String(directoryError)).not.toContain("PRIVATE-KEY-RAW-SECRET");
    expect(String(nonceError)).not.toContain("NONCE-RAW-SECRET");
  });

  it("handshake·frame·요청 각각의 byte 상한과 versioned discriminated union을 fail closed한다", () => {
    const codec = new ConnectorFrameCodec();
    const frame = codec.encode({
      protocol: "massion.connector.v1",
      type: "event",
      requestId: "request-1",
      leaseId: "lease-1",
      sequence: 1,
      kind: "data",
      payload: { text: "ok" },
    });
    expect(codec.decodeEvent(frame)).toMatchObject({ type: "event", requestId: "request-1", sequence: 1 });
    expect(() => codec.decodeHandshake(Buffer.alloc(CONNECTOR_HANDSHAKE_MAX_BYTES + 1))).toThrow("handshake byte 상한");
    expect(() => codec.decode(Buffer.alloc(1024 * 1024 + 1))).toThrow("frame byte 상한");
    expect(() => codec.assertRequestBytes(16 * 1024 * 1024 + 1)).toThrow("요청 byte 상한");
    expect(() =>
      codec.decodeEvent(
        Buffer.from(
          JSON.stringify({
            protocol: "massion.connector.v1",
            type: "event",
            requestId: "request-1",
            leaseId: "lease-1",
            sequence: 0,
            kind: "done",
            payload: {},
            signature: "노출되면 안 되는 필드",
          }),
        ),
      ),
    ).toThrow("알 수 없는 필드");
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
        void _event;
        // 연결 해제 오류를 반복 과정에서 받습니다.
      }
    }).rejects.toThrow("연결되지 않았습니다");
  });

  it("같은 조직·Connector의 중복 연결을 거부하고 shutdown에서 모든 연결을 닫는다", async () => {
    const hub = new ConnectorChannelHub();
    let closeCount = 0;
    const connection = {
      async *invoke() {
        yield { kind: "done" as const, sequence: 0, payload: {} };
      },
      async close() {
        closeCount += 1;
      },
    };
    hub.attach({ organizationId: "organization-1", connectorId: "edge-1" }, connection);

    expect(() => hub.attach({ organizationId: "organization-1", connectorId: "edge-1" }, connection)).toThrow(
      "이미 연결",
    );
    await hub.shutdown();
    expect(closeCount).toBe(1);
    await hub.shutdown();
    expect(closeCount).toBe(1);
  });

  it("특정 Edge Connector를 폐기하면 그 장치 채널만 즉시 닫고 이후 RPC를 막는다", async () => {
    const hub = new ConnectorChannelHub();
    let revokedCloseCount = 0;
    let retainedCloseCount = 0;
    const connection = (onClose: () => void) => ({
      async *invoke() {
        yield { kind: "done" as const, sequence: 0, payload: {} };
      },
      async close() {
        onClose();
      },
    });
    hub.attach(
      { organizationId: "organization-1", connectorId: "edge-revoked" },
      connection(() => {
        revokedCloseCount += 1;
      }),
    );
    hub.attach(
      { organizationId: "organization-1", connectorId: "edge-retained" },
      connection(() => {
        retainedCloseCount += 1;
      }),
    );

    await expect(hub.disconnect({ organizationId: "organization-1", connectorId: "edge-revoked" })).resolves.toBe(true);
    expect(revokedCloseCount).toBe(1);
    expect(retainedCloseCount).toBe(0);
    await expect(hub.disconnect({ organizationId: "organization-1", connectorId: "edge-revoked" })).resolves.toBe(
      false,
    );
    await expect(async () => {
      for await (const _event of hub.invoke("organization-1", "edge-revoked", {
        protocol: "massion.connector.v1",
        requestId: "request-revoked",
        leaseId: "lease-revoked",
        operation: "health",
        payload: {},
      })) {
        void _event;
      }
    }).rejects.toThrow("연결되지 않았습니다");
  });
});
