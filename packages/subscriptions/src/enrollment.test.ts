import { generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import {
  ConnectorEnrollmentService,
  createEnrollmentSignaturePayload,
  type EnrollmentVerificationInput,
} from "./enrollment.js";

describe("Connector 일회 등록과 장치 서명", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let enrollment: ConnectorEnrollmentService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "enrollment@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    enrollment = await ConnectorEnrollmentService.create(database, organizations, {
      now: () => new Date("2030-01-01T00:00:00.000Z"),
    });
  });

  afterEach(async () => database.close());

  it("Ed25519 장치가 서명한 등록 code를 한 번만 사용한다", async () => {
    const issued = await enrollment.issue(context, {
      commandId: randomUUID(),
      location: "edge",
      executionKind: "agent-runtime",
    });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const unsigned = {
      enrollmentId: issued.enrollmentId,
      enrollmentCode: issued.enrollmentCode,
      challengeNonce: issued.challengeNonce,
      connectorId: "edge-codex-1",
      publicKey: publicKeyPem,
      protocol: "massion-connector-v1",
      version: "1.0.0",
      capabilities: ["codex", "quota"],
    } as const;
    const input: EnrollmentVerificationInput = {
      ...unsigned,
      signature: sign(null, createEnrollmentSignaturePayload(unsigned), privateKey).toString("base64url"),
    };

    await expect(enrollment.verify(input)).resolves.toMatchObject({
      organizationId: context.organizationId,
      ownerUserId: context.userId,
      location: "edge",
    });
    await expect(enrollment.verify(input)).rejects.toThrow("재사용");
    expect(JSON.stringify(await database.query("SELECT * FROM subscription_connector_enrollment;"))).not.toContain(
      issued.enrollmentCode,
    );
  });

  it("응답을 잃어도 같은 발급 명령에서 새 일회 code를 만들어내지 않는다", async () => {
    const commandId = randomUUID();
    await enrollment.issue(context, { commandId, location: "edge", executionKind: "agent-runtime" });
    await expect(
      enrollment.issue(context, { commandId, location: "edge", executionKind: "agent-runtime" }),
    ).rejects.toThrow("재사용");
    const [records] = await database.query<[unknown[]]>(
      "SELECT enrollment_id FROM subscription_connector_enrollment WHERE command_id = $command_id;",
      { command_id: commandId },
    );
    expect(records).toHaveLength(1);
  });

  it("만료된 등록 code를 거부한다", async () => {
    const issued = await enrollment.issue(context, {
      commandId: randomUUID(),
      location: "edge",
      executionKind: "model",
      ttlMs: 1,
    });
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const unsigned = {
      ...issued,
      connectorId: "server-invalid",
      publicKey: publicKeyPem,
      protocol: "massion-connector-v1",
      version: "1.0.0",
      capabilities: ["model"],
    };
    const input = {
      ...unsigned,
      signature: sign("sha256", createEnrollmentSignaturePayload(unsigned), privateKey).toString("base64url"),
    };

    await expect(enrollment.verify(input, new Date("2030-01-01T00:00:00.002Z"))).rejects.toThrow("만료");
  });

  it("서버 관리형 Connector에는 장치용 일회 등록 code를 발급하지 않는다", async () => {
    await expect(
      enrollment.issue(context, {
        commandId: randomUUID(),
        location: "server",
        executionKind: "agent-runtime",
      }),
    ).rejects.toThrow("Edge");
    const [records] = await database.query<[unknown[]]>("SELECT enrollment_id FROM subscription_connector_enrollment;");
    expect(records).toEqual([]);
  });

  it("Ed25519가 아닌 key와 다른 장치의 서명을 거부한다", async () => {
    const issued = await enrollment.issue(context, {
      commandId: randomUUID(),
      location: "edge",
      executionKind: "agent-runtime",
    });
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPublicKey = rsa.publicKey.export({ type: "spki", format: "pem" }).toString();
    const rsaUnsigned = {
      ...issued,
      connectorId: "edge-rsa",
      publicKey: rsaPublicKey,
      protocol: "massion-connector-v1",
      version: "1.0.0",
      capabilities: ["model"],
    };
    await expect(
      enrollment.verify({
        ...rsaUnsigned,
        signature: sign("sha256", createEnrollmentSignaturePayload(rsaUnsigned), rsa.privateKey).toString("base64url"),
      }),
    ).rejects.toThrow("Ed25519");

    const expectedDevice = generateKeyPairSync("ed25519");
    const differentDevice = generateKeyPairSync("ed25519");
    const publicKey = expectedDevice.publicKey.export({ type: "spki", format: "pem" }).toString();
    const unsigned = { ...rsaUnsigned, connectorId: "edge-wrong-signature", publicKey };
    await expect(
      enrollment.verify({
        ...unsigned,
        signature: sign(null, createEnrollmentSignaturePayload(unsigned), differentDevice.privateKey).toString(
          "base64url",
        ),
      }),
    ).rejects.toThrow("서명이 유효하지 않습니다");
  });
});
