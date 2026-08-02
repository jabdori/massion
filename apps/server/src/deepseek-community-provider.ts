import { ApplicationError } from "@massion/application";
import type { OrganizationService, TenantContext } from "@massion/identity";
import type { ModelProfile, ModelRouter, ModelVerificationEvidence, ProviderService } from "@massion/router";
import type { MassionDatabase } from "@massion/storage";

import { BUILTIN_CORE_MODEL_ROUTES } from "./server-model-route-assembler.js";

export const DEEPSEEK_COMMUNITY_PROVIDER_ID = "huggingface-deepseek-community";
export const DEEPSEEK_COMMUNITY_MODEL_ID = "deepseek-ai/DeepSeek-V4-Flash-0731";
export const DEEPSEEK_COMMUNITY_ENDPOINT = "https://q5dh1rfszfym23hj.us-east-2.aws.endpoints.huggingface.cloud/v1";

const PROVIDER_NAME = "DeepSeek V4 Flash 0731 (Hugging Face Community)";
const CREDENTIAL_LABEL = "Public endpoint";
const PLACEHOLDER_SECRET = "not-needed";
const MAXIMUM_PROBE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 35_000;
const PROVIDER_CONTRACT =
  "https://huggingface.co/spaces/victor/DeepSeek-V4-Flash-0731-free-endpoint/blob/17806432f88d034d62a910713e2826afa5e1ced3/index.html";
const STABLE_PROVIDER_IDS = new Set(["openai-codex", "zai-coding-plan", "minimax-token-plan"]);

export interface DeepSeekCommunityConnection {
  readonly providerId: typeof DEEPSEEK_COMMUNITY_PROVIDER_ID;
  readonly modelId: typeof DEEPSEEK_COMMUNITY_MODEL_ID;
  readonly modelProfileId: string;
  readonly routeNames: readonly string[];
  readonly verification: {
    readonly modelList: true;
    readonly tools: true;
    readonly streaming: true;
    readonly observedAt: string;
    readonly providerContract: string;
  };
}

interface DeepSeekCommunityProviderOptions {
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maximumProbeBytes?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

async function boundedText(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) throw new Error("DeepSeek 커뮤니티 endpoint 응답 본문이 없습니다");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new Error("DeepSeek 커뮤니티 endpoint 응답 크기 상한을 초과했습니다");
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 형식이 유효하지 않습니다`);
  return value as Record<string, unknown>;
}

function validStreamingResponse(text: string): boolean {
  const data = text
    .replaceAll("\r\n", "\n")
    .split(/\n\n+/u)
    .map((frame) =>
      frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n"),
    )
    .filter(Boolean);
  if (data.length < 2 || data.at(-1) !== "[DONE]") return false;
  let meaningful = false;
  for (const value of data.slice(0, -1)) {
    let frame: Record<string, unknown>;
    try {
      frame = object(JSON.parse(value) as unknown, "DeepSeek streaming frame");
    } catch {
      return false;
    }
    if (!Array.isArray(frame.choices)) return false;
    meaningful ||= frame.choices.some((choice) => {
      const delta = object(object(choice, "DeepSeek streaming choice").delta, "DeepSeek streaming delta");
      return (
        (typeof delta.content === "string" && delta.content.length > 0) ||
        (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)
      );
    });
  }
  return meaningful;
}

export class DeepSeekCommunityProviderService {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maximumProbeBytes: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  public constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly providers: ProviderService,
    private readonly router: ModelRouter,
    options: DeepSeekCommunityProviderOptions = {},
  ) {
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maximumProbeBytes = options.maximumProbeBytes ?? MAXIMUM_PROBE_BYTES;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    if (this.timeoutMs < 1 || this.timeoutMs > 60_000)
      throw new Error("DeepSeek probe timeout 범위가 유효하지 않습니다");
    if (this.maximumProbeBytes < 1 || this.maximumProbeBytes > 1024 * 1024)
      throw new Error("DeepSeek probe 응답 상한이 유효하지 않습니다");
  }

  public async connect(
    context: TenantContext,
    input: { readonly commandId: string; readonly acceptCommunityDataTransfer: boolean },
  ): Promise<DeepSeekCommunityConnection> {
    if (!input.commandId.trim()) throw new Error("DeepSeek 연결 command ID가 필요합니다");
    if (!input.acceptCommunityDataTransfer) throw new Error("커뮤니티 endpoint 데이터 전송 동의가 필요합니다");
    await this.organizations.verifyTenantContext(context, ["owner", "admin"]);
    const verification = await this.probe();
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, ["owner", "admin"], tx);
      const existingProviders = (await this.providers.listProviders(context, tx)).filter(
        (provider) => provider.provider_id === DEEPSEEK_COMMUNITY_PROVIDER_ID,
      );
      if (existingProviders.length > 1) throw new Error("DeepSeek 커뮤니티 Provider 계보가 중복됐습니다");
      let provider = existingProviders[0];
      if (
        provider &&
        (provider.display_name !== PROVIDER_NAME || provider.adapter_kind !== "openai-compatible" || !provider.enabled)
      ) {
        throw new Error("기존 DeepSeek 커뮤니티 Provider 계약이 충돌합니다");
      }
      provider ??= (
        await this.providers.registerProvider(
          context,
          {
            commandId: `${input.commandId}:provider`,
            providerId: DEEPSEEK_COMMUNITY_PROVIDER_ID,
            displayName: PROVIDER_NAME,
            adapterKind: "openai-compatible",
          },
          tx,
        )
      ).provider;

      const endpoints = await this.providers.listEndpoints(context, DEEPSEEK_COMMUNITY_PROVIDER_ID, tx);
      if (endpoints.length > 1) throw new Error("DeepSeek 커뮤니티 endpoint 계보가 중복됐습니다");
      let endpoint = endpoints[0];
      if (
        endpoint &&
        (endpoint.name !== "Public API" ||
          endpoint.base_url !== DEEPSEEK_COMMUNITY_ENDPOINT ||
          endpoint.local ||
          !endpoint.enabled)
      )
        throw new Error("기존 DeepSeek 커뮤니티 endpoint 계약이 충돌합니다");
      endpoint ??= (
        await this.providers.registerEndpoint(
          context,
          {
            commandId: `${input.commandId}:endpoint`,
            providerId: provider.provider_id,
            name: "Public API",
            baseUrl: DEEPSEEK_COMMUNITY_ENDPOINT,
            local: false,
          },
          tx,
        )
      ).endpoint;

      const credentials = await this.providers.listCredentials(context, DEEPSEEK_COMMUNITY_PROVIDER_ID, tx);
      if (credentials.length > 1) throw new Error("DeepSeek 커뮤니티 Credential 계보가 중복됐습니다");
      if (
        credentials[0] &&
        (credentials[0].endpoint_id !== endpoint.endpoint_id ||
          credentials[0].label !== CREDENTIAL_LABEL ||
          credentials[0].credential_type !== "api_key" ||
          credentials[0].status !== "active" ||
          credentials[0].priority !== 100 ||
          credentials[0].weight !== 1)
      )
        throw new Error("기존 DeepSeek 커뮤니티 Credential 계약이 충돌합니다");
      if (!credentials[0]) {
        await this.providers.addCredential(
          context,
          {
            commandId: `${input.commandId}:credential`,
            providerId: provider.provider_id,
            endpointId: endpoint.endpoint_id,
            label: CREDENTIAL_LABEL,
            credentialType: "api_key",
            secret: PLACEHOLDER_SECRET,
            priority: 100,
            weight: 1,
          },
          tx,
        );
      }

      const models = (await this.router.listModels(context, tx)).filter(
        (model) => model.provider_id === provider.provider_id,
      );
      if (models.length > 1) throw new Error("DeepSeek 커뮤니티 Model Profile 계보가 중복됐습니다");
      let profile = models[0];
      if (profile && !this.compatibleProfile(profile, endpoint.endpoint_id))
        throw new Error("기존 DeepSeek 커뮤니티 Model Profile 계약이 충돌합니다");
      profile ??= (
        await this.router.registerModel(
          context,
          {
            commandId: `${input.commandId}:model`,
            providerId: provider.provider_id,
            endpointId: endpoint.endpoint_id,
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
            verificationEvidence: this.evidence(verification.observedAt),
          },
          tx,
        )
      ).profile;
      if (!this.compatibleProfile(profile, endpoint.endpoint_id))
        throw new Error("생성된 DeepSeek 커뮤니티 Model Profile 계약이 일치하지 않습니다");
      const evidence = await this.router.listModelEvidence(context, profile.model_profile_id, tx);
      if (!this.compatibleEvidence(evidence))
        throw new Error("DeepSeek 커뮤니티 Model verification evidence가 완전하지 않습니다");
      const availability = evidence.find((item) => item.evidence_kind === "runtime-availability");
      const recordedObservedAt = new Date(String(availability?.observed_at)).toISOString();

      const routes = await this.router.listRoutes(context, tx);
      for (const [index, contract] of BUILTIN_CORE_MODEL_ROUTES.entries()) {
        const matching = routes.filter((route) => route.name === contract.name);
        const route = matching[0];
        if (matching.length !== 1 || !route || route.data_policy !== "external-allowed")
          throw new Error(`외부 전송이 허용된 Core Route가 하나로 확정되지 않았습니다: ${contract.name}`);
        const candidates = await this.router.listCandidates(context, route.route_id, tx);
        const allModels = await this.router.listModels(context, tx);
        const allEndpoints = await this.providers.listEndpoints(context, undefined, tx);
        const allCredentials = await this.providers.listCredentials(context, undefined, tx);
        if (
          !candidates.some((candidate) => {
            const candidateProfile = allModels.find((model) => model.model_profile_id === candidate.model_profile_id);
            const candidateEndpoint = allEndpoints.find(
              (candidate) => candidate.endpoint_id === candidateProfile?.endpoint_id,
            );
            return (
              candidate.enabled &&
              candidateProfile?.enabled &&
              candidateProfile.verified &&
              STABLE_PROVIDER_IDS.has(candidateProfile.provider_id) &&
              candidateEndpoint?.enabled &&
              allCredentials.some(
                (credential) =>
                  credential.provider_id === candidateProfile.provider_id &&
                  credential.endpoint_id === candidateEndpoint.endpoint_id &&
                  credential.status === "active",
              )
            );
          })
        ) {
          throw new Error(`DeepSeek 커뮤니티 후보에는 안정 Provider fallback이 필요합니다: ${contract.name}`);
        }
        const deepseekCandidates = candidates.filter(
          (candidate) => candidate.model_profile_id === profile.model_profile_id,
        );
        if (deepseekCandidates.length > 1)
          throw new Error(`DeepSeek Core Route candidate가 중복됐습니다: ${contract.name}`);
        if (deepseekCandidates[0] && (!deepseekCandidates[0].enabled || deepseekCandidates[0].priority !== 100))
          throw new Error(`기존 DeepSeek Core Route candidate 계약이 충돌합니다: ${contract.name}`);
        if (deepseekCandidates.length === 0) {
          await this.router.addCandidate(
            context,
            {
              commandId: `${input.commandId}:candidate:${String(index)}`,
              routeId: route.route_id,
              modelProfileId: profile.model_profile_id,
              priority: 100,
            },
            tx,
          );
        }
      }

      return {
        providerId: DEEPSEEK_COMMUNITY_PROVIDER_ID,
        modelId: DEEPSEEK_COMMUNITY_MODEL_ID,
        modelProfileId: profile.model_profile_id,
        routeNames: BUILTIN_CORE_MODEL_ROUTES.map((route) => route.name),
        verification: {
          modelList: true,
          tools: true,
          streaming: true,
          observedAt: recordedObservedAt,
          providerContract: PROVIDER_CONTRACT,
        },
      };
    });
  }

  private compatibleProfile(profile: ModelProfile, endpointId: string): boolean {
    return (
      profile.endpoint_id === endpointId &&
      profile.model_id === DEEPSEEK_COMMUNITY_MODEL_ID &&
      profile.route_kind === "chat" &&
      profile.context_window === 393_216 &&
      profile.supports_tools &&
      !profile.supports_structured_output &&
      !profile.supports_vision &&
      profile.supports_streaming &&
      profile.equivalence_group === "massion-core-general" &&
      profile.eval_score === 1 &&
      profile.input_cost_micros_per_million === 0 &&
      profile.output_cost_micros_per_million === 0 &&
      profile.verified &&
      profile.enabled
    );
  }

  private compatibleEvidence(evidence: readonly ModelVerificationEvidence[]): boolean {
    const matches = (
      kind: ModelVerificationEvidence["evidence_kind"],
      source: string,
      sourceVersion: string,
      claim: (value: Record<string, unknown>) => boolean,
    ) =>
      evidence.some((item) => {
        if (item.evidence_kind !== kind || item.source !== source || item.source_version !== sourceVersion)
          return false;
        try {
          return claim(object(JSON.parse(item.claim_json) as unknown, "DeepSeek verification evidence"));
        } catch {
          return false;
        }
      });
    return (
      matches(
        "runtime-availability",
        `${DEEPSEEK_COMMUNITY_ENDPOINT}/models`,
        "openai-model-list-v1",
        (claim) =>
          claim.modelId === DEEPSEEK_COMMUNITY_MODEL_ID &&
          claim.actualAvailable === true &&
          claim.contextWindow === 393_216,
      ) &&
      matches(
        "provider-capability-contract",
        PROVIDER_CONTRACT,
        "17806432f88d034d62a910713e2826afa5e1ced3",
        (claim) =>
          claim.modelId === DEEPSEEK_COMMUNITY_MODEL_ID &&
          claim.contextWindow === 393_216 &&
          claim.tools === true &&
          claim.streaming === true,
      ) &&
      matches(
        "runtime-capability-contract",
        "massion:openai-compatible-runtime-contract",
        "massion-server-1.0.0",
        (claim) =>
          claim.modelId === DEEPSEEK_COMMUNITY_MODEL_ID &&
          claim.protocol === "openai" &&
          claim.tools === true &&
          claim.streaming === true,
      )
    );
  }

  private evidence(observedAt: string) {
    return [
      {
        kind: "runtime-availability" as const,
        source: `${DEEPSEEK_COMMUNITY_ENDPOINT}/models`,
        sourceVersion: "openai-model-list-v1",
        observedAt,
        claim: { modelId: DEEPSEEK_COMMUNITY_MODEL_ID, actualAvailable: true, contextWindow: 393_216 },
      },
      {
        kind: "provider-capability-contract" as const,
        source: PROVIDER_CONTRACT,
        sourceVersion: "17806432f88d034d62a910713e2826afa5e1ced3",
        observedAt,
        claim: { modelId: DEEPSEEK_COMMUNITY_MODEL_ID, contextWindow: 393_216, tools: true, streaming: true },
      },
      {
        kind: "runtime-capability-contract" as const,
        source: "massion:openai-compatible-runtime-contract",
        sourceVersion: "massion-server-1.0.0",
        observedAt,
        claim: { modelId: DEEPSEEK_COMMUNITY_MODEL_ID, protocol: "openai", tools: true, streaming: true },
      },
    ];
  }

  private retryAfter(response: Response, fallback: number): number {
    const value = response.headers.get("retry-after")?.trim();
    if (!value) return fallback;
    const seconds = Number(value);
    const milliseconds = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now();
    return Math.min(10_000, Math.max(0, Number.isFinite(milliseconds) ? milliseconds : fallback));
  }

  private transient(error: unknown): error is Error {
    return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
  }

  private publicFailure(status: 429 | 503 | "timeout", retryAfterMs?: number): ApplicationError {
    if (status === 429) {
      return new ApplicationError({
        category: "rate-limit",
        severity: "warning",
        retryable: true,
        userMessage: "무료 모델 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
        operatorCode: "DEEPSEEK_COMMUNITY_RATE_LIMIT",
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    }
    return new ApplicationError({
      category: "unavailable",
      severity: "warning",
      retryable: true,
      userMessage: "무료 모델이 잠시 응답하지 않습니다. 다시 시도해 주세요.",
      operatorCode: status === 503 ? "DEEPSEEK_COMMUNITY_UNAVAILABLE" : "DEEPSEEK_COMMUNITY_TIMEOUT",
    });
  }

  private async requestOnce(path: string, init?: RequestInit): Promise<{ response: Response; text: string }> {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${PLACEHOLDER_SECRET}`);
    headers.set("content-type", "application/json");
    const response = await this.fetcher(`${DEEPSEEK_COMMUNITY_ENDPOINT}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await boundedText(response, this.maximumProbeBytes);
    return { response, text };
  }

  private async request(path: string, init?: RequestInit): Promise<{ response: Response; text: string }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let result: { response: Response; text: string };
      try {
        result = await this.requestOnce(path, init);
      } catch (error) {
        if (!this.transient(error)) throw error;
        if (attempt === 0) continue;
        throw this.publicFailure("timeout");
      }
      if (result.response.status === 429) {
        throw this.publicFailure(429, this.retryAfter(result.response, 1_000));
      }
      if (result.response.status === 503) {
        if (attempt === 0) {
          await this.sleep(this.retryAfter(result.response, 1_000));
          continue;
        }
        throw this.publicFailure(503);
      }
      if (!result.response.ok)
        throw new Error(`DeepSeek 커뮤니티 endpoint probe 실패: HTTP ${String(result.response.status)}`);
      return result;
    }
    throw this.publicFailure("timeout");
  }

  private async probe(): Promise<{ readonly observedAt: string }> {
    const models = object(JSON.parse((await this.request("/models")).text) as unknown, "DeepSeek model list");
    if (
      !Array.isArray(models.data) ||
      !models.data.some((item) => {
        const model = object(item, "DeepSeek model");
        return model.id === DEEPSEEK_COMMUNITY_MODEL_ID && model.max_model_len === 393_216;
      })
    ) {
      throw new Error("DeepSeek 커뮤니티 endpoint model 계약이 일치하지 않습니다");
    }
    const tool = object(
      JSON.parse(
        (
          await this.request("/chat/completions", {
            method: "POST",
            body: JSON.stringify({
              model: DEEPSEEK_COMMUNITY_MODEL_ID,
              messages: [{ role: "user", content: "Use the echo tool with value READY." }],
              max_tokens: 64,
              tools: [
                {
                  type: "function",
                  function: {
                    name: "echo",
                    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
                  },
                },
              ],
              tool_choice: "auto",
            }),
          })
        ).text,
      ) as unknown,
      "DeepSeek tool probe",
    );
    if (tool.model !== DEEPSEEK_COMMUNITY_MODEL_ID)
      throw new Error("DeepSeek tool response model 계약이 일치하지 않습니다");
    const choices = tool.choices;
    if (!Array.isArray(choices) || choices.length === 0)
      throw new Error("DeepSeek tool capability를 확인하지 못했습니다");
    const message = object(object(choices[0], "DeepSeek tool choice").message, "DeepSeek tool message");
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0)
      throw new Error("DeepSeek tool capability를 확인하지 못했습니다");
    const functionCall = object(object(message.tool_calls[0], "DeepSeek tool call").function, "DeepSeek tool function");
    if (functionCall.name !== "echo") throw new Error("DeepSeek tool capability를 확인하지 못했습니다");
    const argumentsValue = object(JSON.parse(String(functionCall.arguments)) as unknown, "DeepSeek tool arguments");
    if (argumentsValue.value !== "READY") throw new Error("DeepSeek tool capability를 확인하지 못했습니다");
    const stream = await this.request("/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: DEEPSEEK_COMMUNITY_MODEL_ID,
        messages: [{ role: "user", content: "Reply with READY." }],
        max_tokens: 8,
        stream: true,
      }),
    });
    if (
      !stream.response.headers.get("content-type")?.includes("text/event-stream") ||
      !validStreamingResponse(stream.text)
    )
      throw new Error("DeepSeek streaming capability를 확인하지 못했습니다");
    return { observedAt: new Date().toISOString() };
  }
}
