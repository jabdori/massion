import type { ContextSource } from "@massion/context-strategy";
import type { TenantContext } from "@massion/identity";

import type { EvidenceBriefStore } from "./evidence-store.js";
import type { EvidenceFreshnessPolicy, EvidenceFreshnessService } from "./stale.js";

export class EvidenceReindexRequiredError extends Error {
  public constructor(
    public readonly evidenceBriefId: string,
    public readonly commandId?: string,
  ) {
    super(`EvidenceBrief를 다시 index해야 합니다: ${evidenceBriefId}`);
    this.name = "EvidenceReindexRequiredError";
  }
}

export class EvidenceBlockedError extends Error {
  public constructor(public readonly evidenceBriefId: string) {
    super(`stale EvidenceBrief 사용이 차단됐습니다: ${evidenceBriefId}`);
    this.name = "EvidenceBlockedError";
  }
}

function observedAt(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  if (value && typeof value === "object" && "toDate" in value) {
    const toDate: unknown = value.toDate;
    if (typeof toDate === "function") {
      const date = (toDate as () => unknown).call(value);
      if (date instanceof Date) return date.toISOString();
    }
  }
  throw new Error("EvidenceBrief createdAt을 ISO timestamp로 변환할 수 없습니다");
}

export class EvidenceContextBinder {
  public constructor(
    private readonly briefs: Pick<EvidenceBriefStore, "getBrief">,
    private readonly freshness: Pick<EvidenceFreshnessService, "assess">,
  ) {}

  public async bind(
    context: TenantContext,
    input: {
      readonly evidenceBriefId: string;
      readonly policy?: EvidenceFreshnessPolicy;
      readonly priority?: number;
      readonly mandatory?: boolean;
    },
  ): Promise<ContextSource> {
    const brief = await this.briefs.getBrief(context, input.evidenceBriefId);
    const assessment = await this.freshness.assess(context, brief, input.policy ?? "reindex");
    if (assessment.status === "blocked") throw new EvidenceBlockedError(brief.evidenceBriefId);
    if (assessment.status === "reindex_required")
      throw new EvidenceReindexRequiredError(brief.evidenceBriefId, assessment.reindexCommand?.commandId);
    return {
      kind: "evidence",
      sourceId: brief.evidenceBriefId,
      revision: brief.indexVersionId,
      contentHash: brief.checksum,
      observedAt: observedAt(brief.createdAt),
      classification: "internal",
      priority: input.priority ?? 80,
      estimatedTokens: 0,
      mandatory: input.mandatory ?? true,
      evidenceRef: {
        evidenceBriefId: brief.evidenceBriefId,
        repositoryId: brief.repositoryId,
        repositoryRevisionId: brief.repositoryRevisionId,
        indexVersionId: brief.indexVersionId,
        briefChecksum: brief.checksum,
        freshnessStatus: assessment.status,
      },
    };
  }
}
