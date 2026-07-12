export const CODEX_PLAN_TYPES = [
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_usage_based",
  "business",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "unknown",
] as const;

export type CodexPlanType = (typeof CODEX_PLAN_TYPES)[number];

const PAID_CODEX_PLAN_TYPES: ReadonlySet<CodexPlanType> = new Set(
  CODEX_PLAN_TYPES.filter((planType) => planType !== "free" && planType !== "unknown"),
);

export function isPaidCodexPlanType(value: unknown): value is Exclude<CodexPlanType, "free" | "unknown"> {
  return typeof value === "string" && PAID_CODEX_PLAN_TYPES.has(value as CodexPlanType);
}
