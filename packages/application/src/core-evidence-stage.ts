import type { ContextStore } from "@massion/context-strategy";
import type { EvidenceBriefStore, EvidencePromptMaterializer, MaterializedEvidencePrompt } from "@massion/evidence";
import type { TenantContext } from "@massion/identity";
import type { WorkService } from "@massion/work";

import type { CoreWorkStageExecutor, CoreWorkStageInput, CoreWorkStageResult } from "./core-work-coordinator.js";

const MAX_KNOWLEDGE_TOKENS = 24_000;

export class CoreEvidenceStage implements CoreWorkStageExecutor {
  public constructor(
    private readonly dependencies: {
      readonly works: Pick<WorkService, "getActivePlan" | "getWork">;
      readonly contexts?: Pick<ContextStore, "get">;
      readonly briefs: Pick<EvidenceBriefStore, "getBrief" | "findAutomaticByWork">;
      readonly materializer?: Pick<EvidencePromptMaterializer, "materialize" | "verifyNoMatch">;
    },
  ) {}

  public async execute(context: TenantContext, input: CoreWorkStageInput): Promise<CoreWorkStageResult> {
    if (!input.workId) throw new Error("Evidence stage에 Work ID가 없습니다");
    const plan = await this.dependencies.works.getActivePlan(context, input.workId);
    if (!plan) return { outcome: "blocked", reason: "strategy-plan-missing" };
    try {
      const materials = await this.materializeActive(context, input.workId, MAX_KNOWLEDGE_TOKENS);
      return {
        outcome: "advanced",
        data: { evidenceBriefIds: materials.map((material) => material.evidenceBriefId) },
      };
    } catch {
      return { outcome: "blocked", reason: "evidence-invalid" };
    }
  }

  public async materializeActive(
    context: TenantContext,
    workId: string,
    maxEstimatedTokens = MAX_KNOWLEDGE_TOKENS,
  ): Promise<readonly MaterializedEvidencePrompt[]> {
    if (
      !Number.isSafeInteger(maxEstimatedTokens) ||
      maxEstimatedTokens < 1 ||
      maxEstimatedTokens > MAX_KNOWLEDGE_TOKENS
    ) {
      throw new Error("Evidence materialize token 예산이 유효하지 않습니다");
    }
    const work = await this.dependencies.works.getWork(context, workId);
    if (work.workspace_id === undefined) return [];
    if (!work.context_version_id || !this.dependencies.contexts) throw new Error("active ContextVersion이 없습니다");
    const contextVersion = await this.dependencies.contexts.get(context, work.context_version_id);
    if (contextVersion.workId !== workId) throw new Error("ContextVersion과 Work가 일치하지 않습니다");
    const sources = contextVersion.selectedSources.filter((source) => source.kind === "evidence");
    if (sources.length === 0) {
      const receipt = await this.dependencies.briefs.findAutomaticByWork(context, workId);
      if (receipt?.workId === workId && receipt.status === "no_match" && this.dependencies.materializer) {
        const verified = await this.dependencies.materializer.verifyNoMatch(context, {
          workId,
          evidenceBriefId: receipt.evidenceBriefId,
        });
        if (verified.evidenceBriefId === receipt.evidenceBriefId && verified.checksum === receipt.checksum) return [];
      }
      throw new Error("Workspace Work의 ready 또는 no-match evidence가 없습니다");
    }
    if (sources.length !== 1) throw new Error("active ready EvidenceBrief는 하나여야 합니다");
    if (!this.dependencies.materializer) throw new Error("Evidence materializer가 없습니다");
    const materials: MaterializedEvidencePrompt[] = [];
    for (const source of sources) {
      const reference = source.evidenceRef;
      if (
        source.content !== undefined ||
        source.estimatedTokens !== 0 ||
        !reference ||
        source.sourceId !== reference.evidenceBriefId ||
        source.revision !== reference.indexVersionId ||
        source.contentHash !== reference.briefChecksum
      ) {
        throw new Error("Evidence Context source 계약이 일치하지 않습니다");
      }
      const automatic = await this.dependencies.briefs.findAutomaticByWork(context, workId);
      if (
        !automatic ||
        automatic.workId !== workId ||
        automatic.status !== "ready" ||
        automatic.evidenceBriefId !== reference.evidenceBriefId ||
        automatic.repositoryId !== reference.repositoryId ||
        automatic.repositoryRevisionId !== reference.repositoryRevisionId ||
        automatic.indexVersionId !== reference.indexVersionId ||
        automatic.checksum !== reference.briefChecksum
      ) {
        throw new Error("automatic EvidenceBrief와 Context source가 일치하지 않습니다");
      }
      const brief = await this.dependencies.briefs.getBrief(context, reference.evidenceBriefId);
      if (
        brief.workId !== workId ||
        brief.status !== "ready" ||
        brief.repositoryId !== reference.repositoryId ||
        brief.repositoryRevisionId !== reference.repositoryRevisionId ||
        brief.indexVersionId !== reference.indexVersionId ||
        brief.checksum !== reference.briefChecksum ||
        brief.evidenceBriefId !== automatic.evidenceBriefId
      ) {
        throw new Error("EvidenceBrief와 Context source가 일치하지 않습니다");
      }
      const materialized = await this.dependencies.materializer.materialize(context, {
        workId,
        evidenceBriefId: brief.evidenceBriefId,
        maxEstimatedTokens,
      });
      if (
        materialized.evidenceBriefId !== source.sourceId ||
        materialized.indexVersionId !== source.revision ||
        materialized.briefChecksum !== source.contentHash ||
        !Number.isSafeInteger(materialized.estimatedTokens) ||
        materialized.estimatedTokens < 1 ||
        materialized.estimatedTokens > maxEstimatedTokens
      ) {
        throw new Error("Materialized evidence와 Context source가 일치하지 않습니다");
      }
      materials.push(materialized);
    }
    return materials;
  }
}
