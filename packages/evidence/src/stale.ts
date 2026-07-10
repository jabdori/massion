import { createHash } from "node:crypto";

import type { TenantContext } from "@massion/identity";

import type { EvidenceBrief } from "./evidence-store.js";
import type { RepositoryStore } from "./repository-store.js";
import type { RepositoryIndexCommand, RepositoryIndexCommandQueue } from "./watcher.js";

export type EvidenceFreshnessPolicy = "warn" | "reindex" | "block";
export type EvidenceFreshnessStatus = "fresh" | "stale_warning" | "reindex_required" | "blocked";
export type EvidenceFreshnessReason =
  "current_index_missing" | "current_index_incomplete" | "repository_revision_changed" | "configuration_mismatch";

export interface EvidenceFreshnessAssessment {
  readonly evidenceBriefId: string;
  readonly status: EvidenceFreshnessStatus;
  readonly policy: EvidenceFreshnessPolicy;
  readonly reasons: readonly EvidenceFreshnessReason[];
  readonly reindexCommand?: RepositoryIndexCommand;
  readonly reindexAccepted?: boolean;
}

const EMPTY_CHANGES = { created: [], modified: [], deleted: [], renamed: [], directories: [] } as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class EvidenceFreshnessService {
  public constructor(
    private readonly repositories: RepositoryStore,
    private readonly queue: RepositoryIndexCommandQueue,
  ) {}

  public async assess(
    context: TenantContext,
    brief: EvidenceBrief,
    policy: EvidenceFreshnessPolicy = "reindex",
  ): Promise<EvidenceFreshnessAssessment> {
    if (brief.organizationId !== context.organizationId)
      throw new Error("다른 organization의 EvidenceBrief를 평가할 수 없습니다");
    const repository = await this.repositories.getRepository(context, brief.repositoryId);
    if (repository.organizationId !== brief.organizationId)
      throw new Error("EvidenceBrief와 Repository organization이 다릅니다");
    const revisions = await this.repositories.listRevisions(context, brief.repositoryId);
    const latest = revisions.at(-1);
    const current = await this.repositories.getCurrentIndex(context, brief.repositoryId);
    const reasons: EvidenceFreshnessReason[] = [];
    if (!current) reasons.push("current_index_missing");
    else if (current.status !== "complete" || !current.current) reasons.push("current_index_incomplete");
    if (!latest || latest.repositoryRevisionId !== brief.repositoryRevisionId)
      reasons.push("repository_revision_changed");
    if (current && current.configurationChecksum !== brief.configurationChecksum)
      reasons.push("configuration_mismatch");
    if (reasons.length === 0) {
      return { evidenceBriefId: brief.evidenceBriefId, status: "fresh", policy, reasons };
    }

    const requiresIndex = reasons.some((reason) =>
      ["current_index_missing", "current_index_incomplete", "configuration_mismatch"].includes(reason),
    );
    if (policy === "block") {
      return { evidenceBriefId: brief.evidenceBriefId, status: "blocked", policy, reasons };
    }
    if (policy === "warn" && !requiresIndex) {
      return { evidenceBriefId: brief.evidenceBriefId, status: "stale_warning", policy, reasons };
    }
    const command: RepositoryIndexCommand = {
      commandId: sha256(
        `stale-evidence\0${brief.evidenceBriefId}\0${latest?.repositoryRevisionId ?? "none"}\0${current?.indexVersionId ?? "none"}`,
      ),
      repositoryId: brief.repositoryId,
      mode: current ? "reconcile" : "full",
      ...(current ? { parentIndexVersionId: current.indexVersionId } : {}),
      reason: "stale_evidence",
      changes: EMPTY_CHANGES,
    };
    const accepted = await this.queue.enqueue(context, command);
    return {
      evidenceBriefId: brief.evidenceBriefId,
      status: "reindex_required",
      policy,
      reasons,
      reindexCommand: command,
      reindexAccepted: accepted,
    };
  }
}
