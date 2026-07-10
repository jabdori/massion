export type FailureClass =
  | "authentication"
  | "billing"
  | "quota"
  | "upstream"
  | "timeout"
  | "network"
  | "input"
  | "policy"
  | "cancelled"
  | "unknown";

export interface FailureSignal {
  readonly kind: "http" | "timeout" | "network" | "input" | "policy" | "cancelled" | "unknown";
  readonly statusCode?: number;
  readonly retryAfter?: string;
}

export interface ClassifiedFailure {
  readonly failureClass: FailureClass;
  readonly fallbackEligible: boolean;
  readonly retryAt?: string;
}

export function parseRetryAfter(value: string | undefined, now = Date.now()): string | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return new Date(now + seconds * 1_000).toISOString();
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= now ? new Date(timestamp).toISOString() : undefined;
}

export function classifyFailure(signal: FailureSignal, now = Date.now()): ClassifiedFailure {
  if (signal.kind === "cancelled") return { failureClass: "cancelled", fallbackEligible: false };
  if (signal.kind === "policy") return { failureClass: "policy", fallbackEligible: false };
  if (signal.kind === "input") return { failureClass: "input", fallbackEligible: false };
  if (signal.kind === "timeout") return { failureClass: "timeout", fallbackEligible: true };
  if (signal.kind === "network") return { failureClass: "network", fallbackEligible: true };
  if (signal.kind !== "http" || signal.statusCode === undefined) {
    return { failureClass: "unknown", fallbackEligible: false };
  }
  if (signal.statusCode === 401) return { failureClass: "authentication", fallbackEligible: true };
  if (signal.statusCode === 402) return { failureClass: "billing", fallbackEligible: false };
  if (signal.statusCode === 403) return { failureClass: "policy", fallbackEligible: false };
  if (signal.statusCode === 408) return { failureClass: "timeout", fallbackEligible: true };
  if (signal.statusCode === 409) return { failureClass: "upstream", fallbackEligible: true };
  if (signal.statusCode === 429) {
    const retryAt = parseRetryAfter(signal.retryAfter, now);
    return {
      failureClass: "quota",
      fallbackEligible: true,
      ...(retryAt ? { retryAt } : {}),
    };
  }
  if (signal.statusCode >= 500) {
    const retryAt = parseRetryAfter(signal.retryAfter, now);
    return {
      failureClass: "upstream",
      fallbackEligible: true,
      ...(retryAt ? { retryAt } : {}),
    };
  }
  return { failureClass: "input", fallbackEligible: false };
}
