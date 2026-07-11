export type DataRecord = Readonly<Record<string, unknown>>;

export function rows(value: unknown): DataRecord[] {
  return Array.isArray(value) ? (value.filter((item) => item && typeof item === "object") as DataRecord[]) : [];
}

export function object(value: unknown): DataRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as DataRecord) : {};
}

export function label(value: unknown, fallback = "—"): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

export function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function formatCost(value: unknown): string {
  const micros = typeof value === "number" ? value : 0;
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

export function shortId(value: unknown): string {
  const text = label(value);
  return text.length > 18 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
}
