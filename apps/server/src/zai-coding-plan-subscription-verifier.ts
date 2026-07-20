export interface ObservedZaiCodingPlanModel {
  readonly modelId: string;
  readonly observedAt: string;
  readonly source: "https://api.z.ai/api/coding/paas/v4/chat/completions";
}

export interface ZaiCodingPlanSubscriptionVerificationInput {
  readonly endpointUrl: string;
  readonly secret: string;
  readonly requiredModelId: string;
}

export interface ZaiCodingPlanSubscriptionVerifierOptions {
  readonly fetcher?: (input: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  readonly maximumResponseBytes?: number;
}

const OFFICIAL_ENDPOINT = "https://api.z.ai/api/coding/paas/v4";
const CHAT_COMPLETIONS_SOURCE = "https://api.z.ai/api/coding/paas/v4/chat/completions" as const;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function officialEndpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Z.AI 공식 endpoint가 유효하지 않습니다");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    `${parsed.origin}${parsed.pathname.replace(/\/$/u, "")}` !== OFFICIAL_ENDPOINT
  ) {
    throw new Error("Z.AI Coding Plan Credential은 공식 endpoint에만 전달할 수 있습니다");
  }
  return OFFICIAL_ENDPOINT;
}

async function boundedBody(response: Response, maximumBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maximumBytes) throw new Error("응답 크기 상한 초과");
  if (!response.body) throw new Error("응답 본문 부재");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let body = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumBytes) throw new Error("응답 크기 상한 초과");
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } finally {
    reader.releaseLock();
  }
}

function completedModelId(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("응답 schema 불일치");
  const response = value as Record<string, unknown>;
  if (
    typeof response.model !== "string" ||
    !MODEL_ID.test(response.model) ||
    !Array.isArray(response.choices) ||
    response.choices.length === 0
  ) {
    throw new Error("응답 schema 불일치");
  }
  return response.model;
}

export class ZaiCodingPlanSubscriptionVerifier {
  private readonly fetcher: (input: string, init: RequestInit) => Promise<Response>;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly maximumResponseBytes: number;

  public constructor(options: ZaiCodingPlanSubscriptionVerifierOptions = {}) {
    this.fetcher = options.fetcher ?? (async (input, init) => await fetch(input, init));
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maximumResponseBytes = options.maximumResponseBytes ?? 256 * 1_024;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 60_000) {
      throw new Error("Z.AI 인증 timeout 범위가 유효하지 않습니다");
    }
    if (
      !Number.isSafeInteger(this.maximumResponseBytes) ||
      this.maximumResponseBytes < 1_024 ||
      this.maximumResponseBytes > 1_048_576
    ) {
      throw new Error("Z.AI 인증 응답 크기 상한이 유효하지 않습니다");
    }
  }

  public async verify(input: ZaiCodingPlanSubscriptionVerificationInput): Promise<ObservedZaiCodingPlanModel> {
    officialEndpoint(input.endpointUrl);
    if (!input.secret || /[\0\r\n]/u.test(input.secret) || Buffer.byteLength(input.secret, "utf8") > 16 * 1024) {
      throw new Error("Z.AI Coding Plan Credential이 유효하지 않습니다");
    }
    if (!MODEL_ID.test(input.requiredModelId)) throw new Error("Z.AI 필수 model ID가 유효하지 않습니다");
    try {
      const response = await this.fetcher(CHAT_COMPLETIONS_SOURCE, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${input.secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: input.requiredModelId,
          messages: [{ role: "user", content: "Respond with: ok" }],
          max_tokens: 8,
          stream: false,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error("Provider 인증 거부");
      if (completedModelId(JSON.parse(await boundedBody(response, this.maximumResponseBytes)) as unknown) !== input.requiredModelId) {
        throw new Error("필수 model 불일치");
      }
      const observedAt = this.now();
      if (!Number.isFinite(observedAt.getTime())) throw new Error("관측 시각 오류");
      return {
        modelId: input.requiredModelId,
        observedAt: observedAt.toISOString(),
        source: CHAT_COMPLETIONS_SOURCE,
      };
    } catch {
      throw new Error("Z.AI Coding Plan Credential 인증 또는 model 실행 확인에 실패했습니다");
    }
  }
}
