import type { QuotaWindow } from "./contracts.js";

const MINIMAX_QUOTA_ENDPOINT = "https://www.minimax.io/v1/token_plan/remains";
const MAXIMUM_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export type MiniMaxQuotaFetchFailure = "authentication" | "network" | "upstream" | "response-size" | "schema";

export class MiniMaxQuotaFetchError extends Error {
  public constructor(public readonly category: MiniMaxQuotaFetchFailure) {
    super(
      category === "authentication"
        ? "MiniMax Token Plan 인증을 갱신해야 합니다"
        : category === "response-size"
          ? "MiniMax 할당량 응답 크기 상한을 초과했습니다"
          : category === "schema"
            ? "MiniMax 할당량 응답 형식을 확인할 수 없습니다"
            : category === "network"
              ? "MiniMax 할당량 endpoint에 연결할 수 없습니다"
              : "MiniMax 할당량 endpoint가 요청을 처리하지 못했습니다",
    );
    this.name = "MiniMaxQuotaFetchError";
  }
}

export interface MiniMaxQuotaFetchOptions {
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function field(value: JsonRecord, snake: string, camel: string): unknown {
  return value[snake] ?? value[camel];
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function remainingPercent(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && parsed >= 0 && parsed <= 100 ? parsed : undefined;
}

function isTextQuotaModel(model: JsonRecord): boolean {
  const rawName = field(model, "model_name", "modelName");
  const name = (typeof rawName === "string" ? rawName : "").trim().toLowerCase();
  return name === "general" || name.startsWith("minimax-m") || name.startsWith("coding-plan");
}

async function boundedResponseText(response: Response): Promise<string> {
  const declared = nonNegativeSafeInteger(response.headers.get("content-length"));
  if (declared !== undefined && declared > MAXIMUM_RESPONSE_BYTES) {
    throw new MiniMaxQuotaFetchError("response-size");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAXIMUM_RESPONSE_BYTES) throw new MiniMaxQuotaFetchError("response-size");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function resetAt(model: JsonRecord, now: Date, weekly: boolean): string | undefined {
  const duration = finiteNumber(
    weekly ? field(model, "weekly_remains_time", "weeklyRemainsTime") : field(model, "remains_time", "remainsTime"),
  );
  if (duration === undefined || duration <= 0 || duration > 366 * 24 * 60 * 60 * 1_000) return undefined;
  const reset = new Date(now.getTime() + duration);
  return Number.isFinite(reset.getTime()) ? reset.toISOString() : undefined;
}

function candidateScore(model: JsonRecord, weekly: boolean): number {
  const total =
    nonNegativeSafeInteger(
      weekly
        ? field(model, "current_weekly_total_count", "currentWeeklyTotalCount")
        : field(model, "current_interval_total_count", "currentIntervalTotalCount"),
    ) ?? 0;
  const percent = remainingPercent(
    weekly
      ? field(model, "current_weekly_remaining_percent", "currentWeeklyRemainingPercent")
      : field(model, "current_interval_remaining_percent", "currentIntervalRemainingPercent"),
  );
  return total > 0 ? total + 100 : percent === undefined ? -1 : percent;
}

function quotaWindow(models: readonly JsonRecord[], weekly: boolean, observedAt: string): QuotaWindow | undefined {
  const model = models.reduce<JsonRecord | undefined>((selected, candidate) => {
    if (!selected) return candidate;
    return candidateScore(candidate, weekly) > candidateScore(selected, weekly) ? candidate : selected;
  }, undefined);
  if (!model) return undefined;
  const total = nonNegativeSafeInteger(
    weekly
      ? field(model, "current_weekly_total_count", "currentWeeklyTotalCount")
      : field(model, "current_interval_total_count", "currentIntervalTotalCount"),
  );
  const used = nonNegativeSafeInteger(
    weekly
      ? field(model, "current_weekly_usage_count", "currentWeeklyUsageCount")
      : field(model, "current_interval_usage_count", "currentIntervalUsageCount"),
  );
  const reset = resetAt(model, new Date(observedAt), weekly);
  const common = {
    kind: weekly ? "weekly-7d" : "session-5h",
    ...(reset === undefined ? {} : { resetsAt: reset }),
    observedAt,
    source: "minimax-token-plan-endpoint",
    confidence: "reported",
  } as const;
  if (total !== undefined && total > 0 && used !== undefined) {
    const remaining = Math.max(total - Math.min(used, total), 0);
    return { ...common, limit: total, remaining, remainingRatio: remaining / total };
  }
  const percent = remainingPercent(
    weekly
      ? field(model, "current_weekly_remaining_percent", "currentWeeklyRemainingPercent")
      : field(model, "current_interval_remaining_percent", "currentIntervalRemainingPercent"),
  );
  return percent === undefined ? undefined : { ...common, remainingRatio: percent / 100 };
}

function decodeWindows(value: unknown, observedAt: string): readonly QuotaWindow[] {
  const payload = record(value);
  const baseResponse = record(payload?.base_resp ?? payload?.baseResp);
  if (!payload || !baseResponse) throw new MiniMaxQuotaFetchError("schema");
  const apiStatus = finiteNumber(baseResponse.status_code ?? baseResponse.statusCode);
  if (apiStatus === 1004) throw new MiniMaxQuotaFetchError("authentication");
  if (apiStatus === undefined) throw new MiniMaxQuotaFetchError("schema");
  if (apiStatus !== 0) throw new MiniMaxQuotaFetchError("upstream");
  const rawModels = payload.model_remains ?? payload.modelRemains;
  const models = Array.isArray(rawModels)
    ? rawModels.flatMap((item) => {
        const model = record(item);
        return model && isTextQuotaModel(model) ? [model] : [];
      })
    : [];
  const windows = [quotaWindow(models, false, observedAt), quotaWindow(models, true, observedAt)].filter(
    (window): window is QuotaWindow => window !== undefined,
  );
  if (windows.length === 0) throw new MiniMaxQuotaFetchError("schema");
  return windows;
}

export async function fetchMiniMaxQuota(
  secret: string,
  options: MiniMaxQuotaFetchOptions = {},
): Promise<readonly QuotaWindow[]> {
  const credential = secret.trim();
  if (!credential || credential.length > 16_384) throw new MiniMaxQuotaFetchError("authentication");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new Error("MiniMax 할당량 조회 제한 시간이 유효하지 않습니다");
  }
  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("MiniMax 할당량 관측 시각이 유효하지 않습니다");
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(MINIMAX_QUOTA_ENDPOINT, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${credential}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new MiniMaxQuotaFetchError("network");
  }
  if (response.status === 401 || response.status === 403) throw new MiniMaxQuotaFetchError("authentication");
  if (!response.ok) throw new MiniMaxQuotaFetchError("upstream");
  let text: string;
  try {
    text = await boundedResponseText(response);
  } catch (error) {
    if (error instanceof MiniMaxQuotaFetchError) throw error;
    throw new MiniMaxQuotaFetchError("schema");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    throw new MiniMaxQuotaFetchError("schema");
  }
  return decodeWindows(decoded, now.toISOString());
}
