export type ContextClassification = "public" | "internal" | "local-private" | "secret-ref";

export type ContextSourceKind =
  "request" | "follow_up" | "declaration" | "decision" | "collaboration" | "artifact" | "manual" | "evidence";

export interface ContextSource {
  readonly kind: ContextSourceKind;
  readonly sourceId: string;
  readonly revision: string;
  readonly contentHash: string;
  readonly observedAt: string;
  readonly classification: ContextClassification;
  readonly priority: number;
  readonly estimatedTokens: number;
  readonly mandatory: boolean;
  readonly content?: unknown;
  readonly evidenceRef?: {
    readonly evidenceBriefId: string;
    readonly repositoryId: string;
    readonly repositoryRevisionId: string;
    readonly indexVersionId: string;
    readonly briefChecksum: string;
    readonly freshnessStatus: "fresh" | "stale_warning";
  };
}

export interface ExcludedContextSource {
  readonly sourceId: string;
  readonly requiredTokens: number;
  readonly reason: "token_budget";
}

export interface ContextVersion {
  readonly contextVersionId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly projectId?: string;
  readonly version: number;
  readonly parentContextVersionId?: string;
  readonly objective: string;
  readonly scopeIn: readonly string[];
  readonly scopeOut: readonly string[];
  readonly constraints: readonly string[];
  readonly assumptions: readonly string[];
  readonly unknowns: readonly string[];
  readonly decisions: readonly string[];
  readonly sources: readonly ContextSource[];
  readonly selectedSources: readonly ContextSource[];
  readonly excludedSources: readonly ExcludedContextSource[];
  readonly tokenBudget: number;
  readonly tokenTotal: number;
  readonly checksum: string;
  readonly createdByUserId: string;
  readonly createdAt: unknown;
}

export interface CreateContextInput {
  readonly commandId: string;
  readonly workId: string;
  readonly projectId?: string;
  readonly expectedParentContextVersionId?: string;
  readonly tokenBudget: number;
  readonly objective: string;
  readonly scopeIn: readonly string[];
  readonly scopeOut: readonly string[];
  readonly constraints: readonly string[];
  readonly assumptions: readonly string[];
  readonly unknowns: readonly string[];
  readonly decisions: readonly string[];
  readonly sources: readonly ContextSource[];
}

export interface ContextEvent {
  readonly eventId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly contextVersionId?: string;
  readonly commandId: string;
  readonly eventType: "context_version_created" | "context_budget_blocked";
  readonly requestHash: string;
  readonly payload: unknown;
  readonly createdAt: unknown;
}
