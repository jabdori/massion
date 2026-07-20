import { ApplicationHttpClient } from "@massion/application";
import {
  EvidenceIndexer,
  EvidenceParser,
  IndexStore,
  RepositoryRevisionCollector,
  RepositoryScanner,
  RepositoryStore,
} from "@massion/evidence";
import { IdentityService, OrganizationService } from "@massion/identity";
import { RuntimeExecutionStore } from "@massion/runtime";
import { SOFTWARE_ENGINEERING_TEAM_PROFILE } from "@massion/software-engineering";
import { createDatabase } from "@massion/storage";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
      for (let attempt = 0; attempt < 300; attempt += 1) {
        snapshot = (await client.snapshot()) as typeof snapshot;
        if (
          snapshot?.data?.executions?.some(
            (execution) =>
              execution.agentHandle === "representative" && execution.status === "blocked_model_unavailable",
          )
        )
          break;
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
          evidenceKinds: ["artifact-version"],
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
          (snapshot.data?.executions?.length ?? 0) >= 4 &&
          snapshot.data?.works?.some((work) => work.status === "completed")
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(snapshot.data?.works).toEqual([expect.objectContaining({ status: "completed" })]);
      expect(snapshot.data?.executions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agentHandle: "representative", status: "succeeded" }),
          expect.objectContaining({ agentHandle: "context-strategy", status: "succeeded" }),
          expect.objectContaining({ agentHandle: "delivery-coordination", status: "succeeded" }),
          expect.objectContaining({ agentHandle: "assurance", status: "succeeded" }),
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
          evidenceKinds: ["artifact-version"],
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
          (snapshot.data?.executions?.length ?? 0) >= 4 &&
          snapshot.data?.works?.some((work) => work.status === "completed")
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(snapshot.data?.works).toEqual([expect.objectContaining({ status: "completed" })]);
      expect(snapshot.data?.executions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agentHandle: "representative", status: "succeeded" }),
          expect.objectContaining({ agentHandle: "context-strategy", status: "succeeded" }),
          expect.objectContaining({ agentHandle: "delivery-coordination", status: "succeeded" }),
          expect.objectContaining({ agentHandle: "assurance", status: "succeeded" }),
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

  it("설치된 Software Engineering 조직이 실제 Git 변경과 독립 Assurance까지 완성한다", async () => {
    const plan = {
      objective: "값 모듈 변경",
      summary: "백엔드 전문 담당자가 테스트 우선으로 값을 변경한다",
      scopeIn: ["src/value.mjs", "src/value.test.mjs"],
      scopeOut: [],
      assumptions: [],
      unknowns: [],
      acceptanceCriteria: [
        {
          key: "value-is-two",
          statement: "value 모듈은 2를 내보낸다",
          method: "evidence",
          evidenceKinds: ["artifact-version"],
          planLevel: false,
        },
      ],
      risks: [],
      tasks: [
        {
          key: "implement-value-change",
          title: "value 모듈 변경",
          objective: "src/value.mjs의 value를 1에서 2로 바꾸고 src/value.test.mjs로 검증한다",
          criterionKeys: ["value-is-two"],
          dependencyKeys: [],
          requiredCapabilities: ["backend-engineering"],
          recommendedAgentHandles: ["software-engineering.backend-specialist"],
          parallelizable: false,
        },
      ],
      evidenceRequests: [],
    };
    const proposal = {
      testPatch: [
        "diff --git a/src/value.test.mjs b/src/value.test.mjs",
        "--- a/src/value.test.mjs",
        "+++ b/src/value.test.mjs",
        "@@ -1,3 +1,3 @@",
        ' import assert from "node:assert/strict";',
        ' import { value } from "./value.mjs";',
        '-assert.equal(value, 1, "MASSION_EXPECTED_VALUE");',
        '+assert.equal(value, 2, "MASSION_EXPECTED_VALUE");',
        "",
      ].join("\n"),
      implementationPatch: [
        "diff --git a/src/value.mjs b/src/value.mjs",
        "--- a/src/value.mjs",
        "+++ b/src/value.mjs",
        "@@ -1 +1 @@",
        "-export const value = 1;",
        "+export const value = 2;",
        "",
      ].join("\n"),
      focusedCommand: {
        executable: "node",
        args: ["src/value.test.mjs"],
        cwd: ".",
        timeoutMs: 10_000,
        maxOutputBytes: 8_192,
        environment: {},
      },
      redFailureMarker: "MASSION_EXPECTED_VALUE",
      validationCommands: [],
      commitMessage: "feat: update value",
    };
    const modelServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          readonly messages?: unknown;
          readonly response_format?: unknown;
        };
        const structuredPrompt = `${JSON.stringify(body.messages) ?? ""}\n${JSON.stringify(body.response_format) ?? ""}`;
        const content = structuredPrompt.includes("software_patch_proposal") || structuredPrompt.includes("testPatch")
          ? JSON.stringify(proposal)
          : structuredPrompt.includes("massion-strategy-plan") || body.response_format
            ? JSON.stringify(plan)
            : "완료";
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: crypto.randomUUID(),
            object: "chat.completion",
            created: 1,
            model: "massion-test-model",
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
    const modelAddress = modelServer.address();
    if (!modelAddress || typeof modelAddress === "string") throw new Error("테스트 모델 주소를 찾을 수 없습니다");

    const workspaceRoot = await mkdtemp(join(tmpdir(), "massion-software-product-"));
    const repositoryRoot = join(workspaceRoot, "fixture-repository");
    const runFile = promisify(execFile);
    await mkdir(join(repositoryRoot, "src"), { recursive: true });
    await writeFile(join(repositoryRoot, "src", "value.mjs"), "export const value = 1;\n", "utf8");
    await writeFile(
      join(repositoryRoot, "src", "value.test.mjs"),
      'import assert from "node:assert/strict";\nimport { value } from "./value.mjs";\nassert.equal(value, 1, "MASSION_EXPECTED_VALUE");\n',
      "utf8",
    );
    await runFile("git", ["init", "--initial-branch=main"], { cwd: repositoryRoot });
    await runFile("git", ["config", "user.name", "Massion Product Test"], { cwd: repositoryRoot });
    await runFile("git", ["config", "user.email", "massion-product@example.invalid"], { cwd: repositoryRoot });
    await runFile("git", ["add", "src/value.mjs", "src/value.test.mjs"], { cwd: repositoryRoot });
    await runFile("git", ["commit", "-m", "test: add software fixture"], { cwd: repositoryRoot });

    const parsed = parseServerConfig({
      MASSION_TOKEN_KEY: Buffer.alloc(32, 61).toString("base64url"),
      MASSION_CREDENTIAL_KEY: Buffer.alloc(32, 62).toString("base64url"),
      MASSION_DATABASE_URL: "mem://",
      MASSION_SOFTWARE_WORKSPACE_ROOT: join(workspaceRoot, "massion-workspaces"),
      MASSION_CONNECTOR_ROOT: join(workspaceRoot, "connectors"),
    });
    const database = await createDatabase(parsed.database);
    const daemon = await createMassionDaemon(
      {
        ...parsed,
        server: { ...parsed.server, port: 0 },
        metrics: { ...parsed.metrics, port: 0 },
        registry: { ...parsed.registry, port: 0 },
      },
      { database },
    );
    const address = await daemon.start();
    try {
      const initialized = (await ApplicationHttpClient.bootstrap(address.url, {
        commandId: "software-product-bootstrap-command-0001",
        email: "software-product@example.com",
        displayName: "Software Product",
      })) as {
        readonly access: { readonly token: string };
        readonly context: { readonly userId: string; readonly organizationId: string; readonly membershipId: string; readonly role: "owner" };
      };
      const client = new ApplicationHttpClient({ baseUrl: address.url, token: initialized.access.token });
      const command = async (operation: string, payload: unknown, expectedRevision?: number) =>
        (await client.command({
          schemaVersion: "massion.application.v1",
          commandId: crypto.randomUUID(),
          correlationId: crypto.randomUUID(),
          operation,
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
          payload,
        })) as { readonly data: Record<string, unknown> };

      await command(
        "organization.command",
        {
          kind: "install-profile",
          profileId: SOFTWARE_ENGINEERING_TEAM_PROFILE.profileId,
          profileVersion: SOFTWARE_ENGINEERING_TEAM_PROFILE.profileVersion,
          nodes: SOFTWARE_ENGINEERING_TEAM_PROFILE.nodes,
        },
        1,
      );
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
        contextWindow: 200_000,
        supportsTools: true,
        supportsStructuredOutput: true,
        supportsVision: false,
        supportsStreaming: true,
        equivalenceGroup: "software-product-test",
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
          equivalenceGroup: "software-product-test",
          minEvalScore: 0,
          requireTools: false,
          requireStructuredOutput: name === "planning-quality",
          requireVision: false,
          requireStreaming: false,
          maxContextTokens: 200_000,
          requestBudgetMicros: 1_000_000,
          totalBudgetMicros: 10_000_000,
        });
        await command("router.candidate.add", {
          routeId: route.data.routeId,
          modelProfileId: model.data.modelProfileId,
          priority: 1,
        });
      }

      const organizations = await OrganizationService.create(database);
      const repositories = await RepositoryStore.create(database, organizations);
      const indexes = await IndexStore.create(database, organizations);
      const scanner = new RepositoryScanner();
      const collector = new RepositoryRevisionCollector(scanner);
      const scanOptions = { include: ["**/*"], exclude: [], maxFileBytes: 128 * 1_024 } as const;
      const captured = await collector.capture(repositoryRoot, scanOptions);
      const registered = await repositories.register(initialized.context, {
        commandId: "software-product-repository-register-0001",
        name: "software-product-fixture",
        providerKind: captured.providerKind,
        rootRef: repositoryRoot,
        rootRealPathHash: captured.rootRealPathHash,
        defaultBranch: "main",
      });
      const revision = await repositories.captureRevision(initialized.context, {
        commandId: "software-product-repository-revision-0001",
        repositoryId: registered.repository.repositoryId,
        providerRevision: captured.providerRevision,
        dirty: captured.dirty,
        ...(captured.dirtyFingerprint ? { dirtyFingerprint: captured.dirtyFingerprint } : {}),
        manifestChecksum: captured.manifestChecksum,
        rootRealPathHash: captured.rootRealPathHash,
        collectorVersion: captured.collectorVersion,
      });
      const parser = new EvidenceParser();
      const indexConfiguration = await repositories.createConfiguration(initialized.context, {
        commandId: "software-product-index-configuration-0001",
        repositoryId: registered.repository.repositoryId,
        checksum: createHash("sha256").update(JSON.stringify(scanOptions)).digest("hex"),
        parserBundleVersion: parser.bundleVersion,
        schemaVersion: "evidence-v1",
        embeddingStatus: "unavailable",
        settings: scanOptions,
      });
      await new EvidenceIndexer(repositories, indexes, scanner, parser).index(initialized.context, {
        commandId: "software-product-index-0001",
        repositoryId: registered.repository.repositoryId,
        repositoryRevisionId: revision.revision.repositoryRevisionId,
        configurationId: indexConfiguration.configuration.configurationId,
        mode: "full",
        root: repositoryRoot,
        scanOptions,
      });

      await command("run.start", {
        request: {
          text: "value 모듈을 테스트 우선으로 2로 변경해주세요",
          softwareDelivery: {
            repositoryRoot,
            repositoryId: registered.repository.repositoryId,
            repositoryRevisionId: revision.revision.repositoryRevisionId,
            baseRevision: captured.providerRevision,
            profileVersion: SOFTWARE_ENGINEERING_TEAM_PROFILE.profileVersion,
            allowedPaths: ["src"],
            testPaths: ["src/value.test.mjs"],
          },
        },
      });
      let snapshot: {
        data?: {
          readonly works?: readonly { readonly status: string; readonly artifactIds: readonly string[] }[];
          readonly executions?: readonly { readonly agentHandle: string; readonly status: string }[];
        };
      } = {};
      for (let attempt = 0; attempt < 600; attempt += 1) {
        snapshot = (await client.snapshot()) as typeof snapshot;
        const completed = snapshot.data?.works?.some(
          (work) => work.status === "completed" && work.artifactIds.length > 0,
        );
        const specialistCompleted = snapshot.data?.executions?.some(
          (execution) =>
            execution.agentHandle === "software-engineering.backend-specialist" && execution.status === "succeeded",
        );
        const assuranceCompleted = snapshot.data?.executions?.some(
          (execution) => execution.agentHandle === "assurance" && execution.status === "succeeded",
        );
        if (completed && specialistCompleted && assuranceCompleted) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(snapshot.data?.works).toEqual([
        expect.objectContaining({ status: "completed", artifactIds: expect.arrayContaining([expect.any(String)]) }),
      ]);
      expect(snapshot.data?.executions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agentHandle: "representative", status: "succeeded" }),
          expect.objectContaining({ agentHandle: "context-strategy", status: "succeeded" }),
          expect.objectContaining({ agentHandle: "software-engineering.backend-specialist", status: "succeeded" }),
          expect.objectContaining({ agentHandle: "assurance", status: "succeeded" }),
        ]),
      );
      expect(await readFile(join(repositoryRoot, "src", "value.mjs"), "utf8")).toBe("export const value = 1;\n");
      await expect(runFile("git", ["status", "--porcelain=v1"], { cwd: repositoryRoot })).resolves.toMatchObject({
        stdout: "",
      });
    } finally {
      await daemon.close();
      await rm(workspaceRoot, { recursive: true, force: true });
      await new Promise<void>((resolve, reject) => modelServer.close((error) => (error ? reject(error) : resolve())));
    }
  }, 45_000);

  it("clean install에서 Z.AI Coding Plan connect-model 하나로 Core route·ready 상태·실제 run을 완성한다", async () => {
    const plan = {
      objective: "Z.AI 자동 Core 경로 검증",
      summary: "구독 연결 직후 Core 실행 경로를 검증한다",
      scopeIn: ["자동 모델 조립"],
      scopeOut: [],
      assumptions: [],
      unknowns: [],
      acceptanceCriteria: [
        {
          key: "zai-core-path",
          statement: "자동 조립된 모델로 전달 작업이 실행된다",
          method: "evidence",
          evidenceKinds: ["artifact-version"],
          planLevel: false,
        },
      ],
      risks: [],
      tasks: [
        {
          key: "deliver-zai-core",
          title: "Z.AI Core 전달",
          objective: "자동 조립된 route로 Delivery Agent를 실행한다",
          criterionKeys: ["zai-core-path"],
          dependencyKeys: [],
          requiredCapabilities: [],
          recommendedAgentHandles: ["delivery-coordination"],
          parallelizable: false,
        },
      ],
      evidenceRequests: [],
    };
    const realFetch = globalThis.fetch;
    const upstreamRequests: Array<{
      readonly url: string;
      readonly authorization: string;
      readonly responseFormatType?: string;
      readonly includesOutputSchema: boolean;
    }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://api.z.ai/api/coding/paas/v4/")) return await realFetch(input, init);
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      const bodyText =
        input instanceof Request ? await input.clone().text() : typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(bodyText) as {
        readonly model?: unknown;
        readonly response_format?: { readonly type?: unknown };
        readonly messages?: unknown;
      };
      upstreamRequests.push({
        url,
        authorization: headers.get("authorization") ?? "",
        ...(typeof body.response_format?.type === "string" ? { responseFormatType: body.response_format.type } : {}),
        includesOutputSchema: JSON.stringify(body.messages).includes("Massion JSON output schema"),
      });
      if (body.model !== "glm-5.2") return new Response("invalid model", { status: 400 });
      if (body.response_format?.type === "json_schema")
        return new Response("JSON Schema response format is unsupported", { status: 400 });
      const content =
        body.response_format?.type === "json_object"
          ? JSON.stringify(
              JSON.stringify(body.messages).includes("Massion JSON output schema") ? plan : { objective: "불완전한 계획" },
            )
          : "완료";
      return Response.json({
        id: crypto.randomUUID(),
        object: "chat.completion",
        created: 1,
        model: "glm-5.2",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      });
    });
    const workspaceRoot = await mkdtemp(join(tmpdir(), "massion-zai-core-"));
    const parsed = parseServerConfig({
      MASSION_TOKEN_KEY: Buffer.alloc(32, 51).toString("base64url"),
      MASSION_CREDENTIAL_KEY: Buffer.alloc(32, 52).toString("base64url"),
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
    const secret = "zai-product-secret-never-returned";
    const address = await daemon.start();
    try {
      const initialized = (await ApplicationHttpClient.bootstrap(address.url, {
        commandId: "zai-core-bootstrap-command-0001",
        email: "zai-core@example.com",
        displayName: "Z.AI Core",
      })) as { access: { token: string } };
      const client = new ApplicationHttpClient({ baseUrl: address.url, token: initialized.access.token });
      const connected = await client.command({
        schemaVersion: "massion.application.v1",
        commandId: "zai-core-connect-command-0001",
        correlationId: "zai-core-connect-correlation-0001",
        operation: "subscription.server.connect-model",
        payload: {
          providerId: "zai-coding-plan",
          alias: "Z.AI GLM Coding Plan",
          authKind: "api-key",
          billingKind: "coding-plan",
          secret,
        },
      });
      expect(connected).toMatchObject({
        outcome: "succeeded",
        data: {
          providerId: "zai-coding-plan",
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
        commandId: "zai-core-run-command-0001",
        correlationId: "zai-core-run-correlation-0001",
        operation: "run.start",
        payload: { request: { text: "자동 Z.AI Core 경로를 검증해주세요" } },
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
          (snapshot.data?.executions?.length ?? 0) >= 4 &&
          snapshot.data?.works?.some((work) => work.status === "completed")
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(snapshot.data?.works).toEqual([expect.objectContaining({ status: "completed" })]);
      expect(snapshot.data?.executions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agentHandle: "representative", status: "succeeded" }),
          expect.objectContaining({ agentHandle: "context-strategy", status: "succeeded" }),
          expect.objectContaining({ agentHandle: "delivery-coordination", status: "succeeded" }),
          expect.objectContaining({ agentHandle: "assurance", status: "succeeded" }),
        ]),
      );
      expect(
        upstreamRequests.filter((request) => request.url.endsWith("/chat/completions")).length,
      ).toBeGreaterThanOrEqual(4);
      expect(upstreamRequests.some((request) => request.responseFormatType === "json_schema")).toBe(false);
      expect(upstreamRequests.some((request) => request.responseFormatType === "json_object")).toBe(true);
      expect(upstreamRequests.some((request) => request.includesOutputSchema)).toBe(true);
      expect(upstreamRequests.every((request) => request.authorization === `Bearer ${secret}`)).toBe(true);
    } finally {
      await daemon.close();
      await rm(workspaceRoot, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  }, 20_000);
});
