import { ApplicationHttpClient } from "@massion/application";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const workspaceRoot = await mkdtemp(join(tmpdir(), "massion-product-software-"));
    const parsed = parseServerConfig({
      MASSION_TOKEN_KEY: Buffer.alloc(32, 9).toString("base64url"),
      MASSION_CREDENTIAL_KEY: Buffer.alloc(32, 10).toString("base64url"),
      MASSION_DATABASE_URL: "mem://",
      MASSION_SOFTWARE_WORKSPACE_ROOT: workspaceRoot,
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
      let snapshot:
        | {
            data?: {
              works?: readonly { workId: string; status: string }[];
              executions?: readonly { agentHandle: string; status: string }[];
            };
          }
        | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        snapshot = (await client.snapshot()) as typeof snapshot;
        if ((snapshot?.data?.executions?.length ?? 0) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(snapshot?.data?.works).toEqual([expect.objectContaining({ status: "draft" })]);
      expect(snapshot?.data?.executions).toEqual([
        expect.objectContaining({ agentHandle: "representative", status: "blocked_model_unavailable" }),
      ]);
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
      await rm(workspaceRoot, { recursive: true, force: true });
    }
    expect(daemon.state).toBe("stopped");
  });

  it("OpenAI 호환 route가 있으면 Representative→Strategy→Delivery 실제 Core 경로를 실행한다", async () => {
    const plan = {
      objective: "실제 Core 경로 검증",
      summary: "한 작업을 전달하고 검증 단계까지 진행한다",
      scopeIn: ["제품 경로"],
      scopeOut: [],
      assumptions: [],
      unknowns: [],
      acceptanceCriteria: [
        {
          key: "core-path",
          statement: "전달 작업이 완료된다",
          method: "evidence",
          evidenceKinds: ["check-result"],
          planLevel: false,
        },
      ],
      risks: [],
      tasks: [
        {
          key: "deliver-core",
          title: "Core 전달",
          objective: "실제 Delivery Agent를 실행한다",
          criterionKeys: ["core-path"],
          dependencyKeys: [],
          requiredCapabilities: [],
          recommendedAgentHandles: ["delivery-coordination"],
          parallelizable: false,
        },
      ],
      evidenceRequests: [],
    };
    const modelServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { response_format?: unknown };
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: crypto.randomUUID(),
            object: "chat.completion",
            created: 1,
            model: "massion-test-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: body.response_format ? JSON.stringify(plan) : "완료" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
    const modelAddress = modelServer.address();
    if (!modelAddress || typeof modelAddress === "string") throw new Error("테스트 모델 주소를 찾을 수 없습니다");
    const workspaceRoot = await mkdtemp(join(tmpdir(), "massion-live-core-"));
    const parsed = parseServerConfig({
      MASSION_TOKEN_KEY: Buffer.alloc(32, 21).toString("base64url"),
      MASSION_CREDENTIAL_KEY: Buffer.alloc(32, 22).toString("base64url"),
      MASSION_DATABASE_URL: "mem://",
      MASSION_SOFTWARE_WORKSPACE_ROOT: workspaceRoot,
    });
    const daemon = await createMassionDaemon({
      ...parsed,
      server: { ...parsed.server, port: 0 },
      metrics: { ...parsed.metrics, port: 0 },
      registry: { ...parsed.registry, port: 0 },
    });
    const address = await daemon.start();
    try {
      const initialized = (await ApplicationHttpClient.bootstrap(address.url, {
        commandId: "live-core-bootstrap-command-0001",
        email: "live-core@example.com",
        displayName: "Live Core",
      })) as { access: { token: string } };
      const client = new ApplicationHttpClient({ baseUrl: address.url, token: initialized.access.token });
      const command = async (operation: string, payload: unknown) =>
        (await client.command({
          schemaVersion: "massion.application.v1",
          commandId: crypto.randomUUID(),
          correlationId: crypto.randomUUID(),
          operation,
          payload,
        })) as { data: Record<string, unknown> };
      await command("router.provider.register", {
        providerId: "local-openai",
        displayName: "Local OpenAI",
        adapterKind: "openai-compatible",
      });
      const endpoint = await command("router.endpoint.register", {
        providerId: "local-openai",
        name: "Test API",
        baseUrl: `http://127.0.0.1:${String(modelAddress.port)}/v1`,
        local: true,
      });
      await command("router.credential.add", {
        providerId: "local-openai",
        endpointId: endpoint.data.endpointId,
        label: "test-account",
        credentialType: "api_key",
        secret: "test-secret",
        priority: 1,
        weight: 1,
      });
      const model = await command("router.model.register", {
        providerId: "local-openai",
        endpointId: endpoint.data.endpointId,
        modelId: "massion-test-model",
        routeKind: "chat",
        contextWindow: 200000,
        supportsTools: true,
        supportsStructuredOutput: true,
        supportsVision: false,
        supportsStreaming: true,
        equivalenceGroup: "core-test",
        evalScore: 1,
        inputCostMicrosPerMillion: 0,
        outputCostMicrosPerMillion: 0,
        verified: true,
      });
      for (const name of [
        "orchestration-balanced",
        "planning-quality",
        "delivery-quality",
        "assurance-independent",
        "software-engineering-quality",
      ]) {
        const route = await command("router.route.configure", {
          name,
          routeKind: "chat",
          credentialPolicy: "round-robin",
          dataPolicy: "external-allowed",
          equivalenceGroup: "core-test",
          minEvalScore: 0,
          requireTools: false,
          requireStructuredOutput: name === "planning-quality",
          requireVision: false,
          requireStreaming: false,
          maxContextTokens: 200000,
          requestBudgetMicros: 1000000,
          totalBudgetMicros: 10000000,
        });
        await command("router.candidate.add", {
          routeId: route.data.routeId,
          modelProfileId: model.data.modelProfileId,
          priority: 1,
        });
      }
      await expect(client.status()).resolves.toMatchObject({ data: { modelRuntime: "ready" } });
      await command("run.start", { request: { text: "실제 Core 경로를 검증해주세요" } });
      let snapshot: {
        data?: {
          works?: readonly { status: string }[];
          executions?: readonly { agentHandle: string; status: string }[];
        };
      } = {};
      for (let attempt = 0; attempt < 300; attempt += 1) {
        snapshot = (await client.snapshot()) as typeof snapshot;
        if (
          (snapshot.data?.executions?.length ?? 0) >= 3 &&
          snapshot.data?.works?.some((work) => work.status === "verifying")
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(snapshot.data?.works).toEqual([expect.objectContaining({ status: "verifying" })]);
      expect(snapshot.data?.executions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agentHandle: "representative", status: "succeeded" }),
          expect.objectContaining({ agentHandle: "context-strategy", status: "succeeded" }),
          expect.objectContaining({ agentHandle: "delivery-coordination", status: "succeeded" }),
        ]),
      );
    } finally {
      await daemon.close();
      await rm(workspaceRoot, { recursive: true, force: true });
      await new Promise<void>((resolve, reject) => modelServer.close((error) => (error ? reject(error) : resolve())));
    }
  }, 20_000);
});
