export const ASSURANCE_VERIFIER_REJECTED = "assurance-verifier-rejected";

const MAX_BLOCKED_DETAIL_BYTES = 2_048;

function hasForbiddenControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

export function normalizeBlockedDetail(value: unknown): string | undefined {
  if (typeof value !== "string" || hasForbiddenControl(value)) return undefined;
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
