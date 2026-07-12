export interface ObservedMiniMaxSubscriptionModel {
  readonly modelId: string;
  readonly availableModelIds: readonly string[];
  readonly observedAt: string;
  readonly source: "https://api.minimax.io/v1/models";
}

export interface MiniMaxSubscriptionVerificationInput {
  readonly endpointUrl: string;
  readonly secret: string;
  readonly requiredModelId: string;
}

export interface MiniMaxSubscriptionVerifierOptions {
  readonly fetcher?: (input: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  readonly maximumResponseBytes?: number;
}

const OFFICIAL_ENDPOINT = "https://api.minimax.io/v1";
const MODEL_SOURCE = "https://api.minimax.io/v1/models" as const;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function officialEndpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("MiniMax 공식 endpoint가 유효하지 않습니다");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    `${parsed.origin}${parsed.pathname.replace(/\/$/u, "")}` !== OFFICIAL_ENDPOINT
  ) {
    throw new Error("MiniMax Credential은 공식 endpoint에만 전달할 수 있습니다");
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

function modelIds(value: unknown): readonly string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("응답 schema 불일치");
  const record = value as Record<string, unknown>;
  if (record.object !== "list" || !Array.isArray(record.data) || record.data.length > 1_024) {
    throw new Error("응답 schema 불일치");
  }
  const ids = record.data.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("응답 schema 불일치");
    const model = entry as Record<string, unknown>;
    if (model.object !== "model" || typeof model.id !== "string" || !MODEL_ID.test(model.id)) {
      throw new Error("응답 schema 불일치");
    }
    return model.id;
  });
  if (ids.length === 0 || new Set(ids).size !== ids.length) throw new Error("응답 model 목록 불일치");
  return ids.sort((left, right) => left.localeCompare(right));
}

export class MiniMaxSubscriptionVerifier {
  private readonly fetcher: (input: string, init: RequestInit) => Promise<Response>;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly maximumResponseBytes: number;

  public constructor(options: MiniMaxSubscriptionVerifierOptions = {}) {
    this.fetcher = options.fetcher ?? (async (input, init) => await fetch(input, init));
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maximumResponseBytes = options.maximumResponseBytes ?? 256 * 1_024;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 60_000) {
      throw new Error("MiniMax 인증 timeout 범위가 유효하지 않습니다");
    }
    if (
      !Number.isSafeInteger(this.maximumResponseBytes) ||
      this.maximumResponseBytes < 1_024 ||
      this.maximumResponseBytes > 1_048_576
    ) {
      throw new Error("MiniMax 인증 응답 크기 상한이 유효하지 않습니다");
    }
  }

  public async verify(input: MiniMaxSubscriptionVerificationInput): Promise<ObservedMiniMaxSubscriptionModel> {
    officialEndpoint(input.endpointUrl);
    if (!input.secret || /[\0\r\n]/u.test(input.secret) || Buffer.byteLength(input.secret, "utf8") > 16 * 1_024) {
      throw new Error("MiniMax 구독 Credential이 유효하지 않습니다");
    }
    if (!MODEL_ID.test(input.requiredModelId)) throw new Error("MiniMax 필수 model ID가 유효하지 않습니다");
    try {
      const response = await this.fetcher(MODEL_SOURCE, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${input.secret}` },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error("Provider 인증 거부");
      const availableModelIds = modelIds(JSON.parse(await boundedBody(response, this.maximumResponseBytes)) as unknown);
      if (!availableModelIds.includes(input.requiredModelId)) throw new Error("필수 model 부재");
      const observedAt = this.now();
      if (!Number.isFinite(observedAt.getTime())) throw new Error("관측 시각 오류");
      return {
        modelId: input.requiredModelId,
        availableModelIds,
        observedAt: observedAt.toISOString(),
        source: MODEL_SOURCE,
      };
    } catch {
      throw new Error("MiniMax 구독 Credential 인증 또는 model 관측에 실패했습니다");
    }
  }
}
