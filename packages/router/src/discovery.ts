export interface DiscoveryRequest {
  readonly adapterKind: "ollama" | "openai-compatible";
  readonly baseUrl: string;
  readonly secret?: string;
}

export interface DiscoveredModel {
  readonly id: string;
  readonly ownedBy: string;
}

export interface DiscoveryResult {
  readonly status: "available" | "degraded";
  readonly models: readonly DiscoveredModel[];
  readonly diagnostic?: { readonly reason: string; readonly recovery: string };
}

export type SupportedGateway = "litellm" | "portkey" | "omniroute";

export function validateGatewayModelId(_gateway: SupportedGateway, modelId: string): string {
  const normalized = modelId.trim();
  let hasControlCharacter = false;
  for (const character of normalized) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) {
      hasControlCharacter = true;
      break;
    }
  }
  if (normalized.length === 0 || normalized.length > 256 || normalized !== modelId || hasControlCharacter) {
    throw new Error("Gateway model ID 형식이 유효하지 않습니다");
  }
  return normalized;
}

export async function discoverModels(
  request: DiscoveryRequest,
  fetcher: typeof fetch = fetch,
): Promise<DiscoveryResult> {
  const baseUrl = request.baseUrl.replace(/\/$/, "");
  const url = request.adapterKind === "ollama" ? `${baseUrl}/api/tags` : `${baseUrl}/models`;
  try {
    const response = await fetcher(url, {
      headers: request.secret ? { authorization: `Bearer ${request.secret}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return degraded(`HTTP ${String(response.status)}`);
    }
    const body = (await response.json()) as Record<string, unknown>;
    const models = request.adapterKind === "ollama" ? parseOllama(body) : parseOpenAi(body);
    return { status: "available", models };
  } catch (error) {
    return degraded(error instanceof Error ? error.message : "알 수 없는 연결 오류");
  }
}

function parseOllama(body: Record<string, unknown>): DiscoveredModel[] {
  if (!Array.isArray(body.models)) throw new Error("Ollama models 응답 형식이 유효하지 않습니다");
  return body.models.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    const id = typeof item.model === "string" ? item.model : typeof item.name === "string" ? item.name : undefined;
    return id ? [{ id, ownedBy: "local" }] : [];
  });
}

function parseOpenAi(body: Record<string, unknown>): DiscoveredModel[] {
  if (!Array.isArray(body.data)) throw new Error("OpenAI models 응답 형식이 유효하지 않습니다");
  return body.data.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    return typeof item.id === "string"
      ? [{ id: item.id, ownedBy: typeof item.owned_by === "string" ? item.owned_by : "unknown" }]
      : [];
  });
}

function degraded(reason: string): DiscoveryResult {
  return {
    status: "degraded",
    models: [],
    diagnostic: {
      reason,
      recovery: "Endpoint 주소, 실행 상태와 Credential을 확인한 뒤 discovery를 다시 실행해주세요.",
    },
  };
}
