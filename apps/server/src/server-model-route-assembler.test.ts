import { describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@massion/identity";

import { BUILTIN_CORE_MODEL_ROUTES, BuiltinModelRouteAssembler } from "./server-model-route-assembler.js";

const context: TenantContext = {
  userId: "user-12345678",
  organizationId: "organization-12345678",
  membershipId: "membership-12345678",
  role: "owner",
};

function profile() {
  return {
    model_profile_id: "profile-minimax-m27",
    provider_id: "minimax-token-plan",
    endpoint_id: "endpoint-minimax-openai",
    model_id: "MiniMax-M2.7",
    route_kind: "chat",
    context_window: 204_800,
    supports_tools: true,
    supports_structured_output: false,
    supports_vision: false,
    supports_streaming: true,
    equivalence_group: "massion-core-general",
    eval_score: 1,
    input_cost_micros_per_million: 0,
    output_cost_micros_per_million: 0,
    verified: true,
    enabled: true,
  };
}

const observedMiniMax = {
  modelId: "MiniMax-M2.7",
  availableModelIds: ["MiniMax-M2.7", "MiniMax-M3"],
  observedAt: "2026-07-12T00:00:00.000Z",
  source: "https://api.minimax.io/v1/models" as const,
};

function miniMaxEvidence() {
  return [
    {
      evidence_kind: "runtime-availability",
      source: observedMiniMax.source,
      subscription_account_id: "account-minimax-12345678",
      claim_json: JSON.stringify({
        modelId: observedMiniMax.modelId,
        actualAvailable: true,
        bearerAuthenticated: true,
      }),
    },
    {
      evidence_kind: "provider-capability-contract",
      source: "https://platform.minimax.io/docs/api-reference/api-overview",
      claim_json: JSON.stringify({
        modelId: observedMiniMax.modelId,
        contextWindow: 204_800,
        tools: true,
        streaming: true,
      }),
    },
    {
      evidence_kind: "runtime-capability-contract",
      source: "massion:openai-compatible-runtime-contract",
      subscription_account_id: "account-minimax-12345678",
      claim_json: JSON.stringify({ modelId: observedMiniMax.modelId, protocol: "openai" }),
    },
  ];
}

describe("서버 내장 모델 Core route 조립", () => {
  it("clean install에 공식 MiniMax-M2.7 profile과 모든 Core route candidate를 만든다", async () => {
    const router = {
      listModels: vi.fn().mockResolvedValue([]),
      registerModel: vi.fn().mockResolvedValue({ profile: profile() }),
      listRoutes: vi.fn().mockResolvedValue([]),
      createRoute: vi.fn().mockImplementation((_context, input) =>
        Promise.resolve({
          route: {
            route_id: `route-${input.name}`,
            name: input.name,
            route_kind: input.routeKind,
            credential_policy: input.credentialPolicy,
            data_policy: input.dataPolicy,
            equivalence_group: input.equivalenceGroup,
            min_eval_score: input.minEvalScore,
            require_tools: input.requireTools,
            require_structured_output: input.requireStructuredOutput,
            require_vision: input.requireVision,
            require_streaming: input.requireStreaming,
            max_context_tokens: input.maxContextTokens,
            request_budget_micros: input.requestBudgetMicros,
            total_budget_micros: input.totalBudgetMicros,
            enabled: true,
          },
        }),
      ),
      listCandidates: vi.fn().mockResolvedValue([]),
      addCandidate: vi
        .fn()
        .mockImplementation((_context, input) =>
          Promise.resolve({ candidate: { candidate_id: `candidate-${input.routeId}` } }),
        ),
    };
    const assembler = new BuiltinModelRouteAssembler(router as never);

    const result = await assembler.assemble(context, {
      commandId: "connect-model-12345678",
      providerId: "minimax-token-plan",
      endpointId: "endpoint-minimax-openai",
      accountId: "account-minimax-12345678",
      observed: observedMiniMax,
    });

    expect(router.registerModel).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        providerId: "minimax-token-plan",
        endpointId: "endpoint-minimax-openai",
        modelId: "MiniMax-M2.7",
        contextWindow: 204_800,
        supportsTools: true,
        supportsStructuredOutput: false,
        verified: true,
        verificationEvidence: expect.arrayContaining([
          expect.objectContaining({
            kind: "runtime-availability",
            source: "https://api.minimax.io/v1/models",
            subscriptionAccountId: "account-minimax-12345678",
          }),
        ]),
      }),
    );
    expect(router.createRoute).toHaveBeenCalledTimes(BUILTIN_CORE_MODEL_ROUTES.length);
    expect(router.addCandidate).toHaveBeenCalledTimes(BUILTIN_CORE_MODEL_ROUTES.length);
    expect(result).toEqual({
      modelId: "MiniMax-M2.7",
      modelProfileId: "profile-minimax-m27",
      routeNames: BUILTIN_CORE_MODEL_ROUTES.map((route) => route.name),
    });
  });

  it("이미 같은 profile·route·candidate가 있으면 쓰기 없이 같은 조립 결과를 반환한다", async () => {
    const existingProfile = profile();
    const routes = BUILTIN_CORE_MODEL_ROUTES.map((contract) => ({
      route_id: `route-${contract.name}`,
      name: contract.name,
      route_kind: contract.routeKind,
      credential_policy: contract.credentialPolicy,
      data_policy: contract.dataPolicy,
      equivalence_group: contract.equivalenceGroup,
      min_eval_score: contract.minEvalScore,
      require_tools: contract.requireTools,
      require_structured_output: contract.requireStructuredOutput,
      require_vision: contract.requireVision,
      require_streaming: contract.requireStreaming,
      max_context_tokens: contract.maxContextTokens,
      request_budget_micros: contract.requestBudgetMicros,
      total_budget_micros: contract.totalBudgetMicros,
      enabled: true,
    }));
    const router = {
      listModels: vi.fn().mockResolvedValue([existingProfile]),
      registerModel: vi.fn(),
      listModelEvidence: vi.fn().mockResolvedValue(miniMaxEvidence()),
      recordModelEvidence: vi.fn(),
      listRoutes: vi.fn().mockResolvedValue(routes),
      createRoute: vi.fn(),
      listCandidates: vi.fn().mockImplementation((_context, routeId) =>
        Promise.resolve([
          {
            candidate_id: `candidate-${routeId}`,
            route_id: routeId,
            model_profile_id: existingProfile.model_profile_id,
            enabled: true,
          },
        ]),
      ),
      addCandidate: vi.fn(),
    };

    await expect(
      new BuiltinModelRouteAssembler(router as never).assemble(context, {
        commandId: "connect-model-replay",
        providerId: "minimax-token-plan",
        endpointId: "endpoint-minimax-openai",
        accountId: "account-minimax-12345678",
        observed: observedMiniMax,
      }),
    ).resolves.toMatchObject({ modelProfileId: existingProfile.model_profile_id });
    expect(router.registerModel).not.toHaveBeenCalled();
    expect(router.recordModelEvidence).not.toHaveBeenCalled();
    expect(router.createRoute).not.toHaveBeenCalled();
    expect(router.addCandidate).not.toHaveBeenCalled();
  });

  it("같은 이름의 Core route 계약이 다르면 사용자 구성을 덮어쓰지 않고 fail-closed한다", async () => {
    const conflicting = {
      route_id: "route-conflict",
      name: BUILTIN_CORE_MODEL_ROUTES[0]?.name,
      route_kind: "chat",
      credential_policy: "round-robin",
      data_policy: "local-private",
      equivalence_group: "다른-group",
      min_eval_score: 0,
      require_tools: false,
      require_structured_output: false,
      require_vision: false,
      require_streaming: false,
      max_context_tokens: 1,
      request_budget_micros: 0,
      total_budget_micros: 0,
      enabled: true,
    };
    const router = {
      listModels: vi.fn().mockResolvedValue([profile()]),
      registerModel: vi.fn(),
      listModelEvidence: vi.fn().mockResolvedValue(miniMaxEvidence()),
      recordModelEvidence: vi.fn(),
      listRoutes: vi.fn().mockResolvedValue([conflicting]),
      createRoute: vi.fn(),
      listCandidates: vi.fn(),
      addCandidate: vi.fn(),
    };

    await expect(
      new BuiltinModelRouteAssembler(router as never).assemble(context, {
        commandId: "connect-model-conflict",
        providerId: "minimax-token-plan",
        endpointId: "endpoint-minimax-openai",
        accountId: "account-minimax-12345678",
        observed: observedMiniMax,
      }),
    ).rejects.toThrow(/계약|충돌/u);
    expect(router.createRoute).not.toHaveBeenCalled();
  });

  it("Codex model/list로 실제 사용 가능한 GPT-5.6을 선택한 뒤 독립 근거와 계정별 Core route를 조립한다", async () => {
    const codexProfile = {
      ...profile(),
      model_profile_id: "profile-gpt-56-sol",
      provider_id: "openai-codex",
      endpoint_id: "endpoint-codex-app-server",
      model_id: "gpt-5.6-sol",
      context_window: 1_050_000,
      supports_structured_output: true,
      supports_vision: false,
      supports_streaming: false,
    };
    const router = {
      listModels: vi.fn().mockResolvedValue([]),
      resolveSubscriptionModelEndpoint: vi.fn().mockResolvedValue("endpoint-codex-app-server"),
      registerModel: vi.fn().mockResolvedValue({ profile: codexProfile, evidence: [] }),
      recordModelEvidence: vi.fn(),
      listModelEvidence: vi.fn().mockResolvedValue([]),
      listRoutes: vi.fn().mockResolvedValue([]),
      createRoute: vi.fn().mockImplementation((_context, input) =>
        Promise.resolve({
          route: {
            route_id: `route-${input.name}`,
            name: input.name,
            route_kind: input.routeKind,
            credential_policy: input.credentialPolicy,
            data_policy: input.dataPolicy,
            equivalence_group: input.equivalenceGroup,
            min_eval_score: input.minEvalScore,
            require_tools: input.requireTools,
            require_structured_output: input.requireStructuredOutput,
            require_vision: input.requireVision,
            require_streaming: input.requireStreaming,
            max_context_tokens: input.maxContextTokens,
            request_budget_micros: input.requestBudgetMicros,
            total_budget_micros: input.totalBudgetMicros,
            enabled: true,
          },
        }),
      ),
      listCandidates: vi.fn().mockResolvedValue([]),
      addCandidate: vi.fn().mockResolvedValue({ candidate: { candidate_id: "candidate-codex" } }),
    };
    const observed = {
      modelId: "gpt-5.6-sol" as const,
      catalogId: "gpt-5.6-sol",
      hidden: false as const,
      isDefault: true,
      inputModalities: ["text", "image"],
      observedAt: "2026-07-12T00:00:00.000Z",
      runtimeVersion: "0.144.1",
      runtimeArtifactDigest: "a".repeat(64),
    };

    const result = await new BuiltinModelRouteAssembler(router as never).assembleCodex(context, {
      commandId: "connect-codex-12345678",
      accountId: "account-codex-12345678",
      observed,
    });

    expect(router.registerModel).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
        contextWindow: 1_050_000,
        supportsTools: true,
        supportsStructuredOutput: true,
        supportsVision: false,
        supportsStreaming: false,
        verified: true,
        verificationEvidence: expect.arrayContaining([
          expect.objectContaining({
            kind: "runtime-availability",
            source: "codex-app-server:model/list",
            subscriptionAccountId: "account-codex-12345678",
          }),
          expect.objectContaining({
            kind: "provider-capability-contract",
            source: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
            claim: expect.objectContaining({ vision: true, streaming: true }),
          }),
          expect.objectContaining({
            kind: "runtime-capability-contract",
            subscriptionAccountId: "account-codex-12345678",
            claim: expect.objectContaining({ vision: false, streaming: false }),
          }),
        ]),
      }),
    );
    expect(router.createRoute).toHaveBeenCalledTimes(BUILTIN_CORE_MODEL_ROUTES.length);
    expect(router.addCandidate).toHaveBeenCalledTimes(BUILTIN_CORE_MODEL_ROUTES.length);
    expect(result).toEqual({
      modelId: "gpt-5.6-sol",
      modelProfileId: "profile-gpt-56-sol",
      routeNames: BUILTIN_CORE_MODEL_ROUTES.map((route) => route.name),
    });
  });

  it("과거 runtime 근거 뒤에 현재 artifact 근거가 있으면 append-only evidence를 중복 추가하지 않는다", async () => {
    const codexProfile = {
      ...profile(),
      model_profile_id: "profile-gpt-56-current",
      provider_id: "openai-codex",
      endpoint_id: "endpoint-codex-app-server",
      model_id: "gpt-5.6-sol",
      context_window: 1_050_000,
      supports_structured_output: true,
      supports_vision: false,
      supports_streaming: false,
    };
    const evidence = (kind: string, claim: Record<string, unknown>, account = true) => ({
      evidence_kind: kind,
      source:
        kind === "runtime-availability"
          ? "codex-app-server:model/list"
          : kind === "provider-capability-contract"
            ? "https://developers.openai.com/api/docs/models/gpt-5.6-sol"
            : "massion:bundled-codex-runtime-attestation",
      claim_json: JSON.stringify(claim),
      ...(account ? { subscription_account_id: "account-codex-12345678" } : {}),
    });
    const currentDigest = "b".repeat(64);
    const router = {
      listModels: vi.fn().mockResolvedValue([codexProfile]),
      resolveSubscriptionModelEndpoint: vi.fn().mockResolvedValue("endpoint-codex-app-server"),
      listModelEvidence: vi.fn().mockResolvedValue([
        evidence("runtime-availability", { modelId: "gpt-5.6-sol", actualAvailable: true }),
        evidence("runtime-capability-contract", {
          runtimeArtifactDigest: "a".repeat(64),
          agentRuntime: true,
          vision: false,
          streaming: false,
        }),
        evidence("runtime-capability-contract", {
          runtimeArtifactDigest: currentDigest,
          agentRuntime: true,
          vision: false,
          streaming: false,
        }),
        evidence(
          "provider-capability-contract",
          { contextWindow: 1_050_000, tools: true, structuredOutput: true, vision: true, streaming: true },
          false,
        ),
      ]),
      recordModelEvidence: vi.fn(),
      listRoutes: vi.fn().mockResolvedValue([]),
      createRoute: vi.fn().mockImplementation((_context, input) =>
        Promise.resolve({
          route: {
            route_id: `route-${input.name}`,
            name: input.name,
            route_kind: input.routeKind,
            credential_policy: input.credentialPolicy,
            data_policy: input.dataPolicy,
            equivalence_group: input.equivalenceGroup,
            min_eval_score: input.minEvalScore,
            require_tools: input.requireTools,
            require_structured_output: input.requireStructuredOutput,
            require_vision: input.requireVision,
            require_streaming: input.requireStreaming,
            max_context_tokens: input.maxContextTokens,
            request_budget_micros: input.requestBudgetMicros,
            total_budget_micros: input.totalBudgetMicros,
            enabled: true,
          },
        }),
      ),
      listCandidates: vi.fn().mockResolvedValue([]),
      addCandidate: vi.fn().mockResolvedValue({ candidate: { candidate_id: "candidate-current" } }),
    };

    await new BuiltinModelRouteAssembler(router as never).assembleCodex(context, {
      commandId: "connect-codex-current",
      accountId: "account-codex-12345678",
      observed: {
        modelId: "gpt-5.6-sol",
        catalogId: "gpt-5.6-sol",
        hidden: false,
        isDefault: true,
        inputModalities: ["text", "image"],
        observedAt: "2026-07-12T00:00:00.000Z",
        runtimeVersion: "0.144.1",
        runtimeArtifactDigest: currentDigest,
      },
    });

    expect(router.recordModelEvidence).not.toHaveBeenCalled();
  });
});
