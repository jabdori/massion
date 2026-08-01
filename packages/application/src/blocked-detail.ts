export const ASSURANCE_VERIFIER_REJECTED = "assurance-verifier-rejected";

const MAX_BLOCKED_DETAIL_BYTES = 2_048;
const FORBIDDEN_CONTROL = /[\u0000-\u001F\u007F]/u;

export function normalizeBlockedDetail(value: unknown): string | undefined {
  if (typeof value !== "string" || FORBIDDEN_CONTROL.test(value)) return undefined;
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized || Buffer.byteLength(normalized, "utf8") > MAX_BLOCKED_DETAIL_BYTES) return undefined;
  return normalized;
}

export function blockedDetailFromResult(value: unknown): string | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return undefined;
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, "blockedDetail")) return undefined;
  return normalizeBlockedDetail(record.blockedDetail);
}
