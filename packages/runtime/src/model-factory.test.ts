import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateText, type LanguageModel } from "ai";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import {
  CredentialVault,
  ModelRouter,
  ProviderService,
  type ModelProvider,
  type ProviderEndpoint,
} from "@massion/router";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { MassionModelFactory, OpenAICompatibleModelBuilder, type ProviderModelSelection } from "./model-factory.js";

describe("Massion routed model factory", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let providers: ProviderService;
  let router: ModelRouter;
  let routeName: string;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    providers = await ProviderService.create(database, organizations, new CredentialVault(randomBytes(32)));
    router = await ModelRouter.create(database, organizations, providers);
    await providers.registerProvider(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai-compatible",
      displayName: "OpenAI Compatible",
      adapterKind: "openai-compatible",
    });
    const endpoint = await providers.registerEndpoint(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai-compatible",
      name: "API",
      baseUrl: "https://models.example/v1",
      local: false,
    });
    for (const label of ["account-a", "account-b"]) {
      await providers.addCredential(context, {
        commandId: crypto.randomUUID(),
        providerId: "openai-compatible",
        endpointId: endpoint.endpoint.endpoint_id,
        label,
        credentialType: "api_key",
        secret: `secret-${label}`,
        priority: 1,
        weight: 1,
      });
    }
    const profile = await router.registerModel(context, {
      commandId: crypto.randomUUID(),
      providerId: "openai-compatible",
      endpointId: endpoint.endpoint.endpoint_id,
      modelId: "coding-model",
      routeKind: "chat",
      contextWindow: 32_000,
      supportsTools: true,
      supportsStructuredOutput: true,
      supportsVision: false,
      supportsStreaming: true,
      equivalenceGroup: "coding",
      evalScore: 0.9,
      inputCostMicrosPerMillion: 1_000_000,
      outputCostMicrosPerMillion: 1_000_000,
      verified: true,
    });
    const route = await router.createRoute(context, {
      commandId: crypto.randomUUID(),
      name: `coding-${crypto.randomUUID()}`,
      routeKind: "chat",
      credentialPolicy: "round-robin",
      dataPolicy: "external-allowed",
      equivalenceGroup: "coding",
      minEvalScore: 0.8,
      requireTools: true,
      requireStructuredOutput: true,
      requireVision: false,
      requireStreaming: true,
      maxContextTokens: 16_000,
      requestBudgetMicros: 10_000,
      totalBudgetMicros: 100_000,
    });
    routeName = route.route.name;
    await router.addCandidate(context, {
      commandId: crypto.randomUUID(),
      routeId: route.route.route_id,
      modelProfileId: profile.profile.model_profile_id,
      priority: 1,
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await database.close();
  });

  it("구성되지 않은 경로는 실행 실패가 아니라 명시적인 모델 제한 상태로 분류한다", async () => {
    const factory = new MassionModelFactory(router, providers, {
      build: () => ({ modelId: "사용되지-않음" }) as LanguageModel,
    });

    await expect(
      factory.acquire(context, {
        commandId: crypto.randomUUID(),
        routeName: "구성되지-않은-경로",
        estimatedTokens: 100,
        estimatedCostMicros: 100,
      }),
    ).rejects.toThrow("blocked_model_unavailable: 구성되지-않은-경로 Route가 구성되지 않았습니다");
  });

  it("reservation secret을 lease에 노출하지 않고 model 생성과 실제 usage를 정산한다", async () => {
    const build = vi.fn((selection: ProviderModelSelection) => ({ modelId: selection.modelId }) as LanguageModel);
    const factory = new MassionModelFactory(router, providers, { build });
    const lease = await factory.acquire(context, {
      commandId: crypto.randomUUID(),
      routeName,
      estimatedTokens: 100,
      estimatedCostMicros: 1_000,
    });

    expect(build.mock.calls[0]?.[0].secret).toMatch(/^secret-account-/u);
    expect(JSON.stringify(lease)).not.toContain("secret-account");
    expect(lease.model.modelId).toBe("coding-model");
    const completed = await lease.complete({
      commandId: crypto.randomUUID(),
      inputTokens: 40,
      outputTokens: 20,
    });
    expect(completed.status).toBe("succeeded");
    expect(completed.actual_cost_micros).toBe(60);
  });

  it("first-token 전 401 실패 후 다른 credential lease로 fallback한다", async () => {
    const factory = new MassionModelFactory(router, providers, {
      build: (selection) => ({ modelId: `${selection.modelId}:${selection.credentialId}` }) as LanguageModel,
    });
    const first = await factory.acquire(context, {
      commandId: crypto.randomUUID(),
      routeName,
      estimatedTokens: 100,
      estimatedCostMicros: 100,
    });
    const failed = await first.fail({
      commandId: crypto.randomUUID(),
      signal: { kind: "http", statusCode: 401 },
      emittedTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    const fallback = await factory.acquire(context, {
      commandId: crypto.randomUUID(),
      routeName,
      estimatedTokens: 100,
      estimatedCostMicros: 100,
      fallbackFromAttemptId: first.attemptId,
    });

    expect(failed.fallbackAllowed).toBe(true);
    expect(fallback.credentialId).not.toBe(first.credentialId);
  });

  it.each(["https://api.openai.com/v1?", "https://api.openai.com/v1#"])(
    "빈 query/hash가 포함된 OpenAI API URL %s는 chat provider를 사용한다",
    (baseUrl) => {
      const builder = new OpenAICompatibleModelBuilder();
      const provider: ModelProvider = {
        provider_id: "openai",
        organization_id: "organization-a",
        display_name: "OpenAI",
        adapter_kind: "ai-sdk",
        enabled: true,
        created_at: new Date(),
        updated_at: new Date(),
      };
      const endpoint: ProviderEndpoint = {
        endpoint_id: "endpoint-openai",
        organization_id: "organization-a",
        provider_id: "openai",
        name: "OpenAI API",
        base_url: baseUrl,
        local: false,
        enabled: true,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const model = builder.build({
        provider,
        endpoint,
        modelId: "gpt-5.6-sol",
        credentialId: "openai-api-key",
        secret: "openai-secret",
      });

      expect(model.provider).toBe("openai.chat");
    },
  );

  it("공식 OpenAI의 gpt-5.6-sol은 Responses API endpoint로 호출한다", async () => {
    let requestUrl = "";
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      requestUrl = input instanceof Request ? input.url : String(input);
      return new Response(
        JSON.stringify({
          id: "response-1",
          created_at: 1,
          model: "gpt-5.6-sol",
          output: [
            {
              type: "message",
              role: "assistant",
              id: "message-1",
              content: [{ type: "output_text", text: "ok", annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const builder = new OpenAICompatibleModelBuilder();
    const provider: ModelProvider = {
      provider_id: "openai",
      organization_id: "organization-a",
      display_name: "OpenAI",
      adapter_kind: "ai-sdk",
      enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const endpoint: ProviderEndpoint = {
      endpoint_id: "endpoint-openai",
      organization_id: "organization-a",
      provider_id: "openai",
      name: "OpenAI API",
      base_url: "https://api.openai.com/v1",
      local: false,
      enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const model = builder.build({
      provider,
      endpoint,
      modelId: "gpt-5.6-sol",
      credentialId: "openai-api-key",
      secret: "openai-secret",
    });

    const result = await generateText({ model, prompt: "hello", maxRetries: 0 });

    expect(result.text).toBe("ok");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(requestUrl).toBe("https://api.openai.com/v1/responses");
  });

  it("실제 OpenAI-compatible builder가 Ollama /v1 endpoint와 Bearer secret으로 호출한다", async () => {
    let requestUrl = "";
    let authorization = "";
    const server = createServer((request, response) => {
      requestUrl = request.url ?? "";
      authorization = request.headers.authorization ?? "";
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "completion-1",
          object: "chat.completion",
          created: 1,
          model: "qwen3:8b",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("테스트 HTTP 주소를 찾을 수 없습니다");
    const builder = new OpenAICompatibleModelBuilder();
    const provider: ModelProvider = {
      provider_id: "ollama",
      organization_id: "organization-a",
      display_name: "Ollama",
      adapter_kind: "ollama",
      enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const endpoint: ProviderEndpoint = {
      endpoint_id: "endpoint-1",
      organization_id: "organization-a",
      provider_id: "ollama",
      name: "Local",
      base_url: `http://127.0.0.1:${String(address.port)}`,
      local: true,
      enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const model = builder.build({
      provider,
      endpoint,
      modelId: "qwen3:8b",
      credentialId: "local",
      secret: "ollama-secret",
    });
    try {
      const result = await generateText({ model, prompt: "hello" });
      expect(result.text).toBe("ok");
      expect(requestUrl).toBe("/v1/chat/completions");
      expect(authorization).toBe("Bearer ollama-secret");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  });
});
