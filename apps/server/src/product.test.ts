import { ApplicationHttpClient } from "@massion/application";
import { IdentityService, OrganizationService } from "@massion/identity";
import { RuntimeExecutionStore } from "@massion/runtime";
import { createDatabase } from "@massion/storage";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { parseDatabaseProvisionConfig, parseServerConfig } from "./config.js";
import {
  createLimitedExecutors,
  createMassionDaemon,
  deriveSubscriptionFingerprintKey,
  provisionRemoteDatabase,
} from "./product.js";

async function connectorUpgradeStatus(baseUrl: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const target = new URL("/connectors", baseUrl);
    const upgrade = request(target, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": Buffer.alloc(16, 1).toString("base64"),
        "sec-websocket-version": "13",
        "x-forwarded-proto": "https",
      },
    });
    upgrade.once("upgrade", (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    upgrade.once("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    upgrade.once("error", reject);
    upgrade.setTimeout(2_000, () => {
      upgrade.destroy(new Error("Connector WebSocket upgrade 응답 시간이 초과되었습니다"));
    });
    upgrade.end();
  });
}

describe("Massion server product", () => {
  it("구독 profile fingerprint key를 credential key와 도메인 분리해 결정론적으로 파생한다", () => {
    const credentialKey = Buffer.alloc(32, 31);
    const first = deriveSubscriptionFingerprintKey(credentialKey);
    expect(first).toEqual(deriveSubscriptionFingerprintKey(credentialKey));
    expect(first).toHaveLength(32);
    expect(first).not.toEqual(credentialKey);
    expect(first).not.toEqual(deriveSubscriptionFingerprintKey(Buffer.alloc(32, 32)));
  });

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

  it("서버 수신 전에 중단된 직접 Agent 실행을 복구하고 정상 종료 때 Runtime을 먼저 비운다", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "massion-runtime-recovery-"));
    const databaseUrl = `rocksdb://${join(workspaceRoot, "massion.db")}`;
    const parsed = parseServerConfig({
      MASSION_TOKEN_KEY: Buffer.alloc(32, 51).toString("base64url"),
      MASSION_CREDENTIAL_KEY: Buffer.alloc(32, 52).toString("base64url"),
      MASSION_DATABASE_URL: databaseUrl,
      MASSION_SOFTWARE_WORKSPACE_ROOT: join(workspaceRoot, "software"),
      MASSION_CONNECTOR_ROOT: join(workspaceRoot, "connectors"),
    });
    const seedDatabase = await createDatabase(parsed.database);
    const identities = await IdentityService.create(seedDatabase);
    const organizations = await OrganizationService.create(seedDatabase);
    const owner = await identities.registerPersonalUser({
      email: "runtime-recovery@example.com",
      displayName: "Runtime Recovery",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const executions = await RuntimeExecutionStore.create(seedDatabase, organizations);
    const created = await executions.createExecution(context, {
      commandId: "runtime-recovery-seed-command-0001",
      workId: "work-before-restart",
      agentHandle: "representative",
      modelRoute: "orchestration-balanced",
      correlationId: "runtime-recovery-seed-correlation-0001",
      estimatedTokens: 100,
      estimatedCostMicros: 0,
      input: "재시작 전에 중단된 직접 실행",
    });
    await executions.transition(context, {
      commandId: `${created.execution.execution_id}:running`,
      executionId: created.execution.execution_id,
      expectedVersion: created.execution.version,
      target: "running",
      payload: { agentHandle: "representative" },
    });

    const daemon = await createMassionDaemon(
      {
        ...parsed,
        server: { ...parsed.server, port: 0 },
        metrics: { ...parsed.metrics, port: 0 },
        registry: { ...parsed.registry, port: 0 },
      },
      { database: seedDatabase },
    );
    const address = await daemon.start();
    try {
      const ready = await fetch(`${address.url}/health/ready`);
      expect(ready.status).toBe(200);
      await expect(ready.json()).resolves.toMatchObject({
        components: { "runtime-recovery": "ready" },
      });
      const [recovered] = await seedDatabase.query<[{ status: string }[]]>(
        "SELECT status FROM runtime_execution WHERE execution_id = $execution_id LIMIT 1;",
        { execution_id: created.execution.execution_id },
      );
      expect(recovered).toEqual([{ status: "interrupted" }]);
    } finally {
      await daemon.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it("실제 control plane을 조립하고 모델 없는 Work만 제한 모드로 차단한다", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "massion-product-software-"));
    const parsed = parseServerConfig({
      MASSION_TOKEN_KEY: Buffer.alloc(32, 9).toString("base64url"),
      MASSION_CREDENTIAL_KEY: Buffer.alloc(32, 10).toString("base64url"),
      MASSION_DATABASE_URL: "mem://",
      MASSION_SOFTWARE_WORKSPACE_ROOT: workspaceRoot,
      MASSION_CONNECTOR_ROOT: join(workspaceRoot, "connectors"),
      MASSION_EDGE_CONNECTOR_ENABLED: "true",
      MASSION_TRUSTED_PROXIES: "127.0.0.1",
    });
    const config = {
      ...parsed,
      server: { ...parsed.server, port: 0 },
      metrics: { ...parsed.metrics, port: 0 },
      registry: { ...parsed.registry, port: 0 },
    };
    const daemon = await createMassionDaemon(config);
    expect((await stat(join(workspaceRoot, "connectors"))).mode & 0o777).toBe(0o700);
    const address = await daemon.start();
    try {
      const ready = await fetch(`${address.url}/health/ready`);
      expect(ready.status).toBe(200);
      await expect(ready.json()).resolves.toMatchObject({
        status: "ready",
        components: {
          database: "ready",
          migrations: "ready",
          connectors: "ready",
          "server-connectors": "ready",
          "subscription-quota": "ready",
          "runtime-recovery": "ready",
        },
      });
      await expect(connectorUpgradeStatus(address.url)).resolves.toBe(101);
      const initialized = (await ApplicationHttpClient.bootstrap(address.url, {
        commandId: "server-bootstrap-command-0001",
        email: "owner@example.com",
        displayName: "Owner",
      })) as { access: { token: string } };
      const client = new ApplicationHttpClient({ baseUrl: address.url, token: initialized.access.token });
      await expect(
        client.issueConnectorEnrollment({
          commandId: "server-connector-enrollment-0001",
          location: "edge",
          executionKind: "agent-runtime",
          ttlMs: 60_000,
        }),
      ).resolves.toMatchObject({
        enrollmentId: expect.any(String),
        enrollmentCode: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        challengeNonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        expiresAt: expect.any(String),
      });
      await expect(client.query("subscription.providers", {})).resolves.toMatchObject({
        data: expect.arrayContaining([expect.objectContaining({ providerId: "openai-codex" })]),
      });
      await expect(client.query("subscription.accounts", {})).resolves.toMatchObject({ data: [] });
      await expect(client.query("subscription.policy", {})).resolves.toMatchObject({ data: [] });
      const preparedSubscription = await client.command({
        schemaVersion: "massion.application.v1",
        commandId: "server-subscription-prepare-0001",
        correlationId: "server-subscription-correlation-0001",
        operation: "subscription.server.prepare",
        payload: {
          providerId: "openai-codex",
          alias: "Codex Personal",
          authKind: "cli-profile",
          billingKind: "consumer-subscription",
          priority: 1,
          weight: 1,
        },
      });
      expect(preparedSubscription).toMatchObject({
        outcome: "succeeded",
        resource: { type: "SubscriptionAccount", id: expect.any(String) },
        data: {
          providerId: "openai-codex",
          alias: "Codex Personal",
          scope: "personal",
          status: "offline",
          connectorStatus: "offline",
          loginRequired: true,
          profileHandle: expect.stringMatching(/^[a-f0-9]{64}\/[a-f0-9]{64}$/u),
        },
      });
      expect(JSON.stringify(preparedSubscription)).not.toMatch(/runtimeArtifactDigest|profileLocator|publicKey/u);
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
  }, 20_000);

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
      MASSION_CONNECTOR_ROOT: join(workspaceRoot, "connectors"),
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

  it("clean install에서 MiniMax connect-model 하나로 Core route·ready 상태·실제 run을 완성한다", async () => {
    const plan = {
      objective: "MiniMax 자동 Core 경로 검증",
      summary: "구독 연결 직후 Core 실행 경로를 검증한다",
      scopeIn: ["자동 모델 조립"],
      scopeOut: [],
      assumptions: [],
      unknowns: [],
      acceptanceCriteria: [
        {
          key: "minimax-core-path",
          statement: "자동 조립된 모델로 전달 작업이 실행된다",
          method: "evidence",
          evidenceKinds: ["check-result"],
          planLevel: false,
        },
      ],
      risks: [],
      tasks: [
        {
          key: "deliver-minimax-core",
          title: "MiniMax Core 전달",
          objective: "자동 조립된 route로 Delivery Agent를 실행한다",
          criterionKeys: ["minimax-core-path"],
          dependencyKeys: [],
          requiredCapabilities: [],
          recommendedAgentHandles: ["delivery-coordination"],
          parallelizable: false,
        },
      ],
      evidenceRequests: [],
    };
    const realFetch = globalThis.fetch;
    const upstreamRequests: Array<{ readonly url: string; readonly authorization: string }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://api.minimax.io/v1/")) return await realFetch(input, init);
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      upstreamRequests.push({ url, authorization: headers.get("authorization") ?? "" });
      if (url === "https://api.minimax.io/v1/models") {
        return Response.json({
          object: "list",
          data: [
            { id: "MiniMax-M2.7", object: "model", owned_by: "MiniMax" },
            { id: "MiniMax-M3", object: "model", owned_by: "MiniMax" },
          ],
        });
      }
      const bodyText =
        input instanceof Request ? await input.clone().text() : typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(bodyText) as { readonly response_format?: unknown };
      return Response.json({
        id: crypto.randomUUID(),
        object: "chat.completion",
        created: 1,
        model: "MiniMax-M2.7",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: body.response_format ? JSON.stringify(plan) : "완료" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      });
    });
    const workspaceRoot = await mkdtemp(join(tmpdir(), "massion-minimax-core-"));
    const parsed = parseServerConfig({
      MASSION_TOKEN_KEY: Buffer.alloc(32, 41).toString("base64url"),
      MASSION_CREDENTIAL_KEY: Buffer.alloc(32, 42).toString("base64url"),
      MASSION_DATABASE_URL: "mem://",
      MASSION_SOFTWARE_WORKSPACE_ROOT: workspaceRoot,
      MASSION_CONNECTOR_ROOT: join(workspaceRoot, "connectors"),
    });
    const daemon = await createMassionDaemon({
      ...parsed,
      server: { ...parsed.server, port: 0 },
      metrics: { ...parsed.metrics, port: 0 },
      registry: { ...parsed.registry, port: 0 },
    });
    const address = await daemon.start();
    const secret = "minimax-product-secret-never-returned";
    try {
      const initialized = (await ApplicationHttpClient.bootstrap(address.url, {
        commandId: "minimax-core-bootstrap-command-0001",
        email: "minimax-core@example.com",
        displayName: "MiniMax Core",
      })) as { access: { token: string } };
      const client = new ApplicationHttpClient({ baseUrl: address.url, token: initialized.access.token });
      const connected = await client.command({
        schemaVersion: "massion.application.v1",
        commandId: "minimax-core-connect-command-0001",
        correlationId: "minimax-core-connect-correlation-0001",
        operation: "subscription.server.connect-model",
        payload: {
          providerId: "minimax-token-plan",
          alias: "MiniMax Token Plan",
          authKind: "subscription-key",
          billingKind: "token-plan",
          secret,
        },
      });
      expect(connected).toMatchObject({
        outcome: "succeeded",
        data: {
          providerId: "minimax-token-plan",
          status: "active",
          connectorStatus: "ready",
        },
      });
      expect(JSON.stringify(connected)).not.toContain(secret);
      await expect(client.status()).resolves.toMatchObject({
        data: { status: "ready", mode: "local", modelRuntime: "ready" },
      });
      await client.command({
        schemaVersion: "massion.application.v1",
        commandId: "minimax-core-run-command-0001",
        correlationId: "minimax-core-run-correlation-0001",
        operation: "run.start",
        payload: { request: { text: "자동 MiniMax Core 경로를 검증해주세요" } },
      });
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
        ) {
          break;
        }
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
      expect(
        upstreamRequests.filter((request) => request.url.endsWith("/chat/completions")).length,
      ).toBeGreaterThanOrEqual(3);
      expect(upstreamRequests.some((request) => request.url.endsWith("/models"))).toBe(true);
      expect(upstreamRequests.every((request) => request.authorization === `Bearer ${secret}`)).toBe(true);
    } finally {
      await daemon.close();
      await rm(workspaceRoot, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  }, 20_000);
});
