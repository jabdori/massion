import { randomBytes } from "node:crypto";

import { ApplicationError } from "@massion/application";
import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { ModelOptimizationStore, OptimizationBatchService } from "@massion/model-optimization";
import { ModelRouter, ProviderService, CredentialVault } from "@massion/router";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BUILTIN_CORE_MODEL_ROUTES } from "./server-model-route-assembler.js";
import {
  DEEPSEEK_COMMUNITY_MODEL_ID,
  DEEPSEEK_COMMUNITY_PROVIDER_ID,
  DeepSeekCommunityProviderService,
} from "./deepseek-community-provider.js";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function endpointFetch(
  input: number | { readonly status?: number; readonly toolModel?: string; readonly streamBody?: string } = {},
): typeof fetch {
  const options = typeof input === "number" ? { status: input } : input;
  const status = options.status ?? 200;
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (status !== 200) return json({ error: { message: "temporarily unavailable" } }, status);
    if (url.endsWith("/models")) {
      return json({
        object: "list",
        data: [{ id: DEEPSEEK_COMMUNITY_MODEL_ID, max_model_len: 393_216 }],
      });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (body.stream === true) {
      return new Response(
        options.streamBody ?? 'data: {"choices":[{"delta":{"content":"READY"}}]}\n\ndata: [DONE]\n\n',
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    }
    return json({
      model: options.toolModel ?? DEEPSEEK_COMMUNITY_MODEL_ID,
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            tool_calls: [{ type: "function", function: { name: "echo", arguments: '{"value":"READY"}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }) as typeof fetch;
}

describe("DeepSeek 무료 커뮤니티 Provider 제품 연결", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let organizations: OrganizationService;
  let providers: ProviderService;
  let router: ModelRouter;
  let stableModelProfileId: string;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "deepseek@example.com", displayName: "DeepSeek" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    providers = await ProviderService.create(database, organizations, new CredentialVault(randomBytes(32)));
    router = await ModelRouter.create(database, organizations, providers);

    const provider = await providers.registerProvider(context, {
      commandId: "stable-provider",
      providerId: "zai-coding-plan",
      displayName: "Z.AI Coding Plan",
      adapterKind: "openai-compatible",
    });
    const endpoint = await providers.registerEndpoint(context, {
      commandId: "stable-endpoint",
      providerId: provider.provider.provider_id,
      name: "Stable API",
      baseUrl: "https://stable.example/v1",
      local: false,
    });
    await providers.addCredential(context, {
      commandId: "stable-credential",
      providerId: provider.provider.provider_id,
      endpointId: endpoint.endpoint.endpoint_id,
      label: "stable",
      credentialType: "api_key",
      secret: "stable-secret",
      priority: 0,
      weight: 1,
    });
    const model = await router.registerModel(context, {
      commandId: "stable-model",
      providerId: provider.provider.provider_id,
      endpointId: endpoint.endpoint.endpoint_id,
      modelId: "stable-model",
      routeKind: "chat",
      contextWindow: 393_216,
      supportsTools: true,
      supportsStructuredOutput: false,
      supportsVision: false,
      supportsStreaming: true,
      equivalenceGroup: "massion-core-general",
      evalScore: 1,
      inputCostMicrosPerMillion: 0,
      outputCostMicrosPerMillion: 0,
      verified: true,
    });
    stableModelProfileId = model.profile.model_profile_id;
    for (const [index, contract] of BUILTIN_CORE_MODEL_ROUTES.entries()) {
      const route = await router.createRoute(context, {
        commandId: `stable-route-${String(index)}`,
        ...contract,
      });
      await router.addCandidate(context, {
        commandId: `stable-candidate-${String(index)}`,
        routeId: route.route.route_id,
        modelProfileId: model.profile.model_profile_id,
        priority: 1,
      });
    }
  });

  afterEach(async () => await database.close());

  it("명시 동의 후 검증 근거와 안정 fallback을 보존한 채 모든 Core Route에 원자 연결한다", async () => {
    const service = new DeepSeekCommunityProviderService(database, organizations, providers, router, {
      fetcher: endpointFetch(),
    });
    const first = await service.connect(context, {
      commandId: "deepseek-connect-1",
      acceptCommunityDataTransfer: true,
    });
    await router.recordModelEvidence(context, {
      commandId: "deepseek-operational-evidence",
      modelProfileId: first.modelProfileId,
      verificationEvidence: [
        {
          kind: "runtime-availability",
          source: "massion:deepseek-periodic-health",
          sourceVersion: "1",
          observedAt: new Date(Date.parse(first.verification.observedAt) + 1_000).toISOString(),
          claim: { healthy: true },
        },
      ],
    });
    const repeated = await service.connect(context, {
      commandId: "deepseek-connect-2",
      acceptCommunityDataTransfer: true,
    });

    expect(repeated).toEqual(first);
    expect(first).toMatchObject({
      providerId: DEEPSEEK_COMMUNITY_PROVIDER_ID,
      modelId: DEEPSEEK_COMMUNITY_MODEL_ID,
      routeNames: BUILTIN_CORE_MODEL_ROUTES.map((route) => route.name),
      verification: { modelList: true, tools: true, streaming: true },
    });
    const models = await router.listModels(context);
    const deepseek = models.filter((model) => model.provider_id === DEEPSEEK_COMMUNITY_PROVIDER_ID);
    expect(deepseek).toHaveLength(1);
    expect(deepseek[0]).toMatchObject({
      context_window: 393_216,
      supports_tools: true,
      supports_structured_output: false,
      supports_vision: false,
      supports_streaming: true,
      input_cost_micros_per_million: 0,
      output_cost_micros_per_million: 0,
      verified: true,
    });
    expect(await router.listModelEvidence(context, first.modelProfileId)).toHaveLength(4);
    for (const route of await router.listRoutes(context)) {
      const candidates = await router.listCandidates(context, route.route_id);
      expect(candidates.some((candidate) => candidate.model_profile_id === first.modelProfileId)).toBe(true);
      expect(candidates.some((candidate) => candidate.model_profile_id !== first.modelProfileId)).toBe(true);
    }
  });

  it.each([429, 503])("HTTP %s probe 실패는 아무 Provider도 남기지 않는다", async (status) => {
    const service = new DeepSeekCommunityProviderService(database, organizations, providers, router, {
      fetcher: endpointFetch(status),
    });
    const failure = await service
      .connect(context, { commandId: `deepseek-fail-${String(status)}`, acceptCommunityDataTransfer: true })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApplicationError);
    expect(
      (await providers.listProviders(context)).some((item) => item.provider_id === DEEPSEEK_COMMUNITY_PROVIDER_ID),
    ).toBe(false);
  });

  it("503은 bounded delay 뒤 정확히 한 번 재시도해 성공한다", async () => {
    const available = endpointFetch();
    const fetcher = vi.fn(async (...args: Parameters<typeof fetch>) => {
      if (fetcher.mock.calls.length === 1) {
        return new Response('{"error":{"message":"starting"}}', {
          status: 503,
          headers: { "content-type": "application/json", "retry-after": "0" },
        });
      }
      return await available(...args);
    });
    const sleep = vi.fn(async () => undefined);
    const service = new DeepSeekCommunityProviderService(database, organizations, providers, router, {
      fetcher,
      sleep,
    });

    await expect(
      service.connect(context, { commandId: "deepseek-503-retry", acceptCommunityDataTransfer: true }),
    ).resolves.toMatchObject({ modelId: DEEPSEEK_COMMUNITY_MODEL_ID });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(0);
  });

  it("503 재시도도 실패하면 두 번만 호출하고 공개 retryable 오류를 반환한다", async () => {
    const fetcher = vi.fn(async () => json({ error: { message: "starting" } }, 503));
    const service = new DeepSeekCommunityProviderService(database, organizations, providers, router, {
      fetcher,
      sleep: async () => undefined,
    });

    const failure = await service
      .connect(context, { commandId: "deepseek-503-twice", acceptCommunityDataTransfer: true })
      .catch((error: unknown) => error);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(failure).toBeInstanceOf(ApplicationError);
    expect((failure as ApplicationError).publicView()).toMatchObject({
      category: "unavailable",
      retryable: true,
      operatorCode: "DEEPSEEK_COMMUNITY_UNAVAILABLE",
    });
  });

  it("timeout은 정확히 한 번 재시도해 성공한다", async () => {
    const available = endpointFetch();
    const fetcher = vi.fn(async (...args: Parameters<typeof fetch>) => {
      if (fetcher.mock.calls.length === 1) throw new DOMException("timed out", "TimeoutError");
      return await available(...args);
    });
    const service = new DeepSeekCommunityProviderService(database, organizations, providers, router, {
      fetcher,
      sleep: async () => undefined,
    });

    await expect(
      service.connect(context, { commandId: "deepseek-timeout-retry", acceptCommunityDataTransfer: true }),
    ).resolves.toMatchObject({ modelId: DEEPSEEK_COMMUNITY_MODEL_ID });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("429는 재시도하지 않고 공개 retryable rate-limit 오류로 보존한다", async () => {
    const fetcher = vi.fn(async () => json({ error: { message: "limited" } }, 429));
    const service = new DeepSeekCommunityProviderService(database, organizations, providers, router, {
      fetcher,
      sleep: async () => undefined,
    });

    const failure = await service
      .connect(context, { commandId: "deepseek-429-public", acceptCommunityDataTransfer: true })
      .catch((error: unknown) => error);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(failure).toBeInstanceOf(ApplicationError);
    expect((failure as ApplicationError).publicView()).toMatchObject({
      category: "rate-limit",
      retryable: true,
      operatorCode: "DEEPSEEK_COMMUNITY_RATE_LIMIT",
    });
    expect(JSON.stringify((failure as ApplicationError).publicView())).not.toContain("q5dh1rfszfym23hj");
    expect(JSON.stringify((failure as ApplicationError).publicView())).not.toContain("limited");
  });

  it.each([
    ["다른 tool model", { toolModel: "other/model" }],
    ["garbage DONE", { streamBody: "garbage [DONE]" }],
    ["내용 없는 SSE", { streamBody: 'data: {"choices":[{"delta":{}}]}\n\ndata: [DONE]\n\n' }],
  ] as const)("%s probe 응답은 거부한다", async (_label, options) => {
    const service = new DeepSeekCommunityProviderService(database, organizations, providers, router, {
      fetcher: endpointFetch(options),
    });
    await expect(
      service.connect(context, {
        commandId: `deepseek-invalid-${crypto.randomUUID()}`,
        acceptCommunityDataTransfer: true,
      }),
    ).rejects.toThrow();
    expect(
      (await providers.listProviders(context)).some((item) => item.provider_id === DEEPSEEK_COMMUNITY_PROVIDER_ID),
    ).toBe(false);
  });

  it.each([
    [
      "추가 endpoint",
      async (connected: { modelProfileId: string }) => {
        void connected;
        await providers.registerEndpoint(context, {
          commandId: "deepseek-conflict-extra-endpoint",
          providerId: DEEPSEEK_COMMUNITY_PROVIDER_ID,
          name: "Other",
          baseUrl: "https://other.example/v1",
          local: false,
        });
      },
    ],
    [
      "endpoint 이름",
      async () =>
        await database.query("UPDATE provider_endpoint SET name = 'Wrong' WHERE provider_id = $provider_id;", {
          provider_id: DEEPSEEK_COMMUNITY_PROVIDER_ID,
        }),
    ],
    [
      "credential 우선순위",
      async () =>
        await database.query("UPDATE provider_credential SET priority = 99 WHERE provider_id = $provider_id;", {
          provider_id: DEEPSEEK_COMMUNITY_PROVIDER_ID,
        }),
    ],
    [
      "추가 credential",
      async () => {
        const endpoint = (await providers.listEndpoints(context, DEEPSEEK_COMMUNITY_PROVIDER_ID))[0];
        if (!endpoint) throw new Error("DeepSeek endpoint fixture가 없습니다");
        await providers.addCredential(context, {
          commandId: "deepseek-conflict-extra-credential",
          providerId: DEEPSEEK_COMMUNITY_PROVIDER_ID,
          endpointId: endpoint.endpoint_id,
          label: "Other",
          credentialType: "api_key",
          secret: "other",
          priority: 100,
          weight: 1,
        });
      },
    ],
    [
      "model 평가 점수",
      async () =>
        await database.query("UPDATE model_profile SET eval_score = 0.9 WHERE provider_id = $provider_id;", {
          provider_id: DEEPSEEK_COMMUNITY_PROVIDER_ID,
        }),
    ],
    [
      "추가 model",
      async () => {
        const endpoint = (await providers.listEndpoints(context, DEEPSEEK_COMMUNITY_PROVIDER_ID))[0];
        if (!endpoint) throw new Error("DeepSeek endpoint fixture가 없습니다");
        await router.registerModel(context, {
          commandId: "deepseek-conflict-extra-model",
          providerId: DEEPSEEK_COMMUNITY_PROVIDER_ID,
          endpointId: endpoint.endpoint_id,
          modelId: "other-model",
          routeKind: "chat",
          contextWindow: 393_216,
          supportsTools: true,
          supportsStructuredOutput: false,
          supportsVision: false,
          supportsStreaming: true,
          equivalenceGroup: "massion-core-general",
          evalScore: 1,
          inputCostMicrosPerMillion: 0,
          outputCostMicrosPerMillion: 0,
          verified: true,
        });
      },
    ],
    [
      "route candidate priority",
      async (connected: { modelProfileId: string }) =>
        await database.query("UPDATE model_route_candidate SET priority = 99 WHERE model_profile_id = $profile_id;", {
          profile_id: connected.modelProfileId,
        }),
    ],
  ] as const)("기존 %s 충돌은 재연결에서 fail-closed한다", async (_label, mutate) => {
    const service = new DeepSeekCommunityProviderService(database, organizations, providers, router, {
      fetcher: endpointFetch(),
    });
    const connected = await service.connect(context, {
      commandId: `deepseek-conflict-initial-${crypto.randomUUID()}`,
      acceptCommunityDataTransfer: true,
    });
    await mutate(connected);
    await expect(
      service.connect(context, {
        commandId: `deepseek-conflict-reconnect-${crypto.randomUUID()}`,
        acceptCommunityDataTransfer: true,
      }),
    ).rejects.toThrow();
  });

  it("기존 Model Profile의 필수 evidence source 계약이 다르면 fail-closed한다", async () => {
    await providers.registerProvider(context, {
      commandId: "deepseek-invalid-evidence-provider",
      providerId: DEEPSEEK_COMMUNITY_PROVIDER_ID,
      displayName: "DeepSeek V4 Flash 0731 (Hugging Face Community)",
      adapterKind: "openai-compatible",
    });
    const endpoint = await providers.registerEndpoint(context, {
      commandId: "deepseek-invalid-evidence-endpoint",
      providerId: DEEPSEEK_COMMUNITY_PROVIDER_ID,
      name: "Public API",
      baseUrl: "https://q5dh1rfszfym23hj.us-east-2.aws.endpoints.huggingface.cloud/v1",
      local: false,
    });
    await providers.addCredential(context, {
      commandId: "deepseek-invalid-evidence-credential",
      providerId: DEEPSEEK_COMMUNITY_PROVIDER_ID,
      endpointId: endpoint.endpoint.endpoint_id,
      label: "Public endpoint",
      credentialType: "api_key",
      secret: "not-needed",
      priority: 100,
      weight: 1,
    });
    await router.registerModel(context, {
      commandId: "deepseek-invalid-evidence-model",
      providerId: DEEPSEEK_COMMUNITY_PROVIDER_ID,
      endpointId: endpoint.endpoint.endpoint_id,
      modelId: DEEPSEEK_COMMUNITY_MODEL_ID,
      routeKind: "chat",
      contextWindow: 393_216,
      supportsTools: true,
      supportsStructuredOutput: false,
      supportsVision: false,
      supportsStreaming: true,
      equivalenceGroup: "massion-core-general",
      evalScore: 1,
      inputCostMicrosPerMillion: 0,
      outputCostMicrosPerMillion: 0,
      verified: true,
      verificationEvidence: [
        {
          kind: "provider-capability-contract",
          source: "wrong",
          sourceVersion: "wrong",
          observedAt: "2026-08-02T00:00:00.000Z",
          claim: { modelId: DEEPSEEK_COMMUNITY_MODEL_ID },
        },
      ],
    });
    const service = new DeepSeekCommunityProviderService(database, organizations, providers, router, {
      fetcher: endpointFetch(),
    });
    await expect(
      service.connect(context, {
        commandId: "deepseek-invalid-evidence-reconcile",
        acceptCommunityDataTransfer: true,
      }),
    ).rejects.toThrow("verification evidence");
  });

  it.each([
    [
      "candidate disabled",
      () =>
        database.query("UPDATE model_route_candidate SET enabled = false WHERE model_profile_id = $profile_id;", {
          profile_id: stableModelProfileId,
        }),
    ],
    [
      "profile disabled",
      () =>
        database.query("UPDATE model_profile SET enabled = false WHERE model_profile_id = $profile_id;", {
          profile_id: stableModelProfileId,
        }),
    ],
    [
      "endpoint disabled",
      () => database.query("UPDATE provider_endpoint SET enabled = false WHERE provider_id = 'zai-coding-plan';"),
    ],
    [
      "credential disabled",
      () => database.query("UPDATE provider_credential SET status = 'disabled' WHERE provider_id = 'zai-coding-plan';"),
    ],
  ] as const)("안정 fallback의 %s 상태는 사용할 수 없는 fallback으로 거부한다", async (_label, mutate) => {
    const service = new DeepSeekCommunityProviderService(database, organizations, providers, router, {
      fetcher: endpointFetch(),
    });
    await service.connect(context, {
      commandId: `deepseek-fallback-initial-${crypto.randomUUID()}`,
      acceptCommunityDataTransfer: true,
    });
    await mutate();
    await expect(
      service.connect(context, {
        commandId: `deepseek-fallback-reconnect-${crypto.randomUUID()}`,
        acceptCommunityDataTransfer: true,
      }),
    ).rejects.toThrow("안정 Provider fallback");
  });

  it("커뮤니티 데이터 전송 동의가 없으면 probe 전에 거부한다", async () => {
    const fetcher = endpointFetch();
    const service = new DeepSeekCommunityProviderService(database, organizations, providers, router, { fetcher });
    await expect(
      service.connect(context, { commandId: "deepseek-no-consent", acceptCommunityDataTransfer: false }),
    ).rejects.toThrow("동의");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("평가부터 승인·활성 batch·Route Attempt까지 DeepSeek 동적 할당 계보를 보존하고 503은 안정 모델로 fallback한다", async () => {
    const connected = await new DeepSeekCommunityProviderService(database, organizations, providers, router, {
      fetcher: endpointFetch(),
    }).connect(context, { commandId: "deepseek-dynamic-connect", acceptCommunityDataTransfer: true });
    const evaluations = await ModelOptimizationStore.create(database, organizations);
    const batches = await OptimizationBatchService.create(database, organizations);
    const bundle = await evaluations.createBundle(context, {
      commandId: "deepseek-dynamic-bundle",
      roleKey: "representative",
      runtimeVersion: "openai-compatible-1",
      cases: [
        {
          promptChecksum: "a".repeat(64),
          toolsChecksum: "b".repeat(64),
          environmentChecksum: "c".repeat(64),
          expectedOutcome: "correct tool-backed answer",
        },
      ],
    });
    const evaluate = async (modelProfileId: string, qualityScore: number, suffix: string) => {
      const run = await evaluations.startEvaluation(context, {
        commandId: `deepseek-dynamic-run-${suffix}`,
        roleKey: "representative",
        bundleId: bundle.bundleId,
        modelProfileId,
        runtimeVersion: "openai-compatible-1",
        inputChecksum: suffix.repeat(64).slice(0, 64),
      });
      return await evaluations.completeEvaluation(context, {
        commandId: `deepseek-dynamic-receipt-${suffix}`,
        runId: run.runId,
        sampleCount: 3,
        qualityScore,
        latencyMs: suffix === "d" ? 100 : 200,
        costMicros: 0,
        privacyAllowed: true,
        completed: true,
      });
    };
    const deepseekReceipt = await evaluate(connected.modelProfileId, 0.95, "d");
    const stableReceipt = await evaluate(stableModelProfileId, 0.9, "e");
    const candidate = (modelProfileId: string, modelId: string, providerId: string) => ({
      modelProfileId,
      modelId,
      routeId: "orchestration-balanced",
      providerId,
      verified: true,
      supportsStructuredOutput: false,
      supportsTools: true,
      supportsStreaming: true,
      dataPolicy: "external-allowed" as const,
    });
    const receipt = (value: typeof deepseekReceipt) => ({
      roleKey: "representative" as const,
      modelProfileId: value.modelProfileId,
      bundleVersion: value.bundleVersion,
      sampleCount: value.sampleCount,
      qualityScore: value.qualityScore,
      latencyMs: value.latencyMs,
      costMicros: value.costMicros,
      privacyAllowed: value.privacyAllowed,
      completed: value.completed,
      inputChecksum: value.inputChecksum,
      receiptChecksum: value.receiptChecksum,
    });
    const recommendation = await evaluations.recommend(context, {
      commandId: "deepseek-dynamic-recommendation",
      roleKey: "representative",
      candidates: [
        candidate(connected.modelProfileId, DEEPSEEK_COMMUNITY_MODEL_ID, DEEPSEEK_COMMUNITY_PROVIDER_ID),
        candidate(stableModelProfileId, "stable-model", "zai-coding-plan"),
      ],
      receipts: [receipt(deepseekReceipt), receipt(stableReceipt)],
      requirements: {
        requiresTools: true,
        requiresStructuredOutput: false,
        requiresStreaming: true,
        dataPolicy: "external-allowed",
      },
    });
    const approved = await batches.approveRecommendation(context, {
      commandId: "deepseek-dynamic-approve",
      recommendationId: recommendation.recommendationId,
      governanceDecisionId: "deepseek-dynamic-decision",
    });
    const limited = await batches.createBatch(context, {
      commandId: "deepseek-dynamic-batch",
      recommendationId: approved.recommendationId,
      status: "limited",
    });
    const active = await batches.activateBatch(context, {
      commandId: "deepseek-dynamic-activate",
      batchId: limited.batchId,
    });
    expect(active).toMatchObject({
      status: "active",
      primaryModelProfileId: connected.modelProfileId,
      fallbackModelProfileIds: [stableModelProfileId],
    });

    const selected = await router.reserve(context, {
      commandId: "deepseek-dynamic-route-attempt",
      routeName: "orchestration-balanced",
      estimatedTokens: 4_096,
      estimatedCostMicros: 0,
      preferredModelProfileIds: [connected.modelProfileId, stableModelProfileId],
      optimizationBatchId: active.batchId,
    });
    expect(selected.profile?.model_profile_id).toBe(connected.modelProfileId);
    expect(selected.attempt.optimization_batch_id).toBe(active.batchId);
    const failed = await router.reportFailure(context, {
      commandId: "deepseek-dynamic-503",
      attemptId: selected.attempt.attempt_id,
      signal: { kind: "http", statusCode: 503 },
      emittedTokens: 0,
      sideEffectsStarted: false,
      actualInputTokens: 0,
      actualOutputTokens: 0,
      actualCostMicros: 0,
    });
    expect(failed.next?.profile?.model_profile_id).toBe(stableModelProfileId);
    const fallback = await router.reserve(context, {
      commandId: "deepseek-dynamic-fallback-attempt",
      routeName: "orchestration-balanced",
      estimatedTokens: 4_096,
      estimatedCostMicros: 0,
      preferredModelProfileIds: [connected.modelProfileId, stableModelProfileId],
      optimizationBatchId: active.batchId,
      fallbackFromAttemptId: selected.attempt.attempt_id,
    });
    const stored = await router.readAttempt(context, fallback.attempt.attempt_id);
    expect(fallback.profile).toMatchObject({
      model_profile_id: stableModelProfileId,
      provider_id: "zai-coding-plan",
    });
    expect(stored).toMatchObject({
      attempt_id: fallback.attempt.attempt_id,
      model_profile_id: stableModelProfileId,
      fallback_from_attempt_id: selected.attempt.attempt_id,
      optimization_batch_id: active.batchId,
      status: "reserved",
    });
  });
});
