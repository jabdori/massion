import { ApplicationHttpClient } from "@massion/application";
import { describe, expect, it } from "vitest";

import { parseDatabaseProvisionConfig, parseServerConfig } from "./config.js";
import { createLimitedExecutors, createMassionDaemon, provisionRemoteDatabase } from "./product.js";

describe("Massion server product", () => {
  it("team mode는 SDK 연결 전에 인증된 namespace와 database를 준비한다", async () => {
    const parsed = parseDatabaseProvisionConfig({
      MASSION_DATABASE_URL: "ws://database:8000/rpc",
      MASSION_DATABASE_PROVISION_USER: "root",
      MASSION_DATABASE_PROVISION_PASSWORD: "owner-password",
      MASSION_DATABASE_USER: "massion_runtime",
      MASSION_DATABASE_PASSWORD: 'runtime-password"; REMOVE DATABASE massion; --',
    });
    const calls: { url: string; authorization: string; body: string }[] = [];
    await provisionRemoteDatabase(parsed, async (input, init) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        body: String(init?.body),
      });
      return Response.json(Array.from({ length: 5 }, () => ({ status: "OK", result: null })));
    });
    expect(calls).toEqual([
      {
        url: "http://database:8000/sql",
        authorization: `Basic ${Buffer.from("root:owner-password").toString("base64")}`,
        body: 'DEFINE NAMESPACE IF NOT EXISTS massion; USE NS massion; DEFINE DATABASE IF NOT EXISTS massion; USE DB massion; DEFINE USER OVERWRITE massion_runtime ON DATABASE PASSWORD "runtime-password\\"; REMOVE DATABASE massion; --" ROLES EDITOR;',
      },
    ]);
  });

  it("HTTP 200 내부 SurrealQL 오류를 provisioning 성공으로 오인하지 않는다", async () => {
    const parsed = parseDatabaseProvisionConfig({
      MASSION_DATABASE_URL: "ws://database:8000/rpc",
      MASSION_DATABASE_PROVISION_USER: "root",
      MASSION_DATABASE_PROVISION_PASSWORD: "owner-password",
      MASSION_DATABASE_USER: "massion_runtime",
      MASSION_DATABASE_PASSWORD: "runtime-password",
    });
    await expect(
      provisionRemoteDatabase(parsed, async () =>
        Response.json([
          { status: "OK", result: null },
          { status: "ERR", result: "권한 오류" },
        ]),
      ),
    ).rejects.toThrow("준비에 실패");
  });

  it("실제 control plane을 조립하고 모델 없는 Work만 제한 모드로 차단한다", async () => {
    const parsed = parseServerConfig({
      MASSION_TOKEN_KEY: Buffer.alloc(32, 9).toString("base64url"),
      MASSION_DATABASE_URL: "mem://",
    });
    const config = {
      ...parsed,
      server: { ...parsed.server, port: 0 },
      metrics: { ...parsed.metrics, port: 0 },
      registry: { ...parsed.registry, port: 0 },
    };
    const daemon = await createMassionDaemon(config);
    const address = await daemon.start();
    try {
      expect((await fetch(`${address.url}/health/ready`)).status).toBe(200);
      const initialized = (await ApplicationHttpClient.bootstrap(address.url, {
        commandId: "server-bootstrap-command-0001",
        email: "owner@example.com",
        displayName: "Owner",
      })) as { access: { token: string } };
      const client = new ApplicationHttpClient({ baseUrl: address.url, token: initialized.access.token });
      await expect(client.status()).resolves.toMatchObject({
        data: { status: "ready", mode: "local", modelRuntime: "limited" },
      });
      const accepted = await client.command({
        schemaVersion: "massion.application.v1",
        commandId: "server-run-command-0001",
        correlationId: "server-run-correlation-0001",
        operation: "run.start",
        payload: { request: { text: "모델 없는 제한 모드" } },
      });
      expect(accepted).toMatchObject({ outcome: "accepted", data: { status: "ready" } });
      await expect(
        createLimitedExecutors().intake.execute(
          { userId: "user", organizationId: "organization", membershipId: "membership", role: "owner" },
          {
            runId: "run",
            commandId: "command",
            correlationId: "correlation",
            request: { text: "모델 없는 제한 모드" },
          },
        ),
      ).resolves.toEqual({ outcome: "blocked", reason: "model-unavailable" });
    } finally {
      await daemon.close();
    }
    expect(daemon.state).toBe("stopped");
  });
});
