import type { PublicationPolicy } from "./contracts.js";

export type PublicationDecision = "blocked" | "approval-required" | "publish";

export function decidePublication(input: {
  readonly policy: PublicationPolicy;
  readonly assessmentPassed: boolean;
  readonly risk: "low" | "medium" | "high" | "critical";
  readonly trustChanged: boolean;
  readonly permissionsIncreased: boolean;
}): PublicationDecision {
  if (!input.assessmentPassed) return "blocked";
  if (input.policy === "manual") return "approval-required";
  if (input.policy === "automatic") return "publish";
  return input.trustChanged || input.permissionsIncreased || input.risk === "high" || input.risk === "critical"
    ? "approval-required"
    : "publish";
}
