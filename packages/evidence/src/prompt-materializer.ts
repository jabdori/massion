import { createHash } from "node:crypto";
import { join } from "node:path";

import type { TenantContext } from "@massion/identity";

import type { EvidenceBrief, EvidenceBriefStore } from "./evidence-store.js";
import type { IndexSnapshot, IndexStore } from "./index-store.js";
import type { RepositoryStore } from "./repository-store.js";
import { redactSecrets } from "./scanner.js";

const MAX_ESTIMATED_TOKENS = 24_000;

export interface MaterializeEvidencePromptInput {
  readonly workId: string;
  readonly evidenceBriefId: string;
  readonly maxEstimatedTokens?: number;
}

export interface EvidencePromptSnippet {
  readonly referenceId: string;
  readonly citation: string;
  readonly relativePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
  readonly estimatedTokens: number;
}

export interface MaterializedEvidencePrompt {
  readonly evidenceBriefId: string;
  readonly indexVersionId: string;
  readonly briefChecksum: string;
  readonly snippets: readonly EvidencePromptSnippet[];
  readonly estimatedTokens: number;
  readonly truncated: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class EvidencePromptMaterializer {
  public constructor(
    private readonly repositories: RepositoryStore,
    private readonly indexes: IndexStore,
    private readonly briefs: EvidenceBriefStore,
  ) {}

  public async materialize(
    context: TenantContext,
    input: MaterializeEvidencePromptInput,
  ): Promise<MaterializedEvidencePrompt> {
    const workId = input.workId.trim();
    const evidenceBriefId = input.evidenceBriefId.trim();
    if (!workId || !evidenceBriefId) throw new Error("Work ID와 EvidenceBrief ID가 필요합니다");
    const budget = input.maxEstimatedTokens ?? MAX_ESTIMATED_TOKENS;
    if (!Number.isInteger(budget) || budget < 1 || budget > MAX_ESTIMATED_TOKENS)
      throw new Error("Prompt token budget은 1 이상 24,000 이하의 정수여야 합니다");

    const { brief, repository, snapshot } = await this.verifyBriefSnapshot(context, workId, evidenceBriefId);
    if (brief.status !== "ready" || !brief.scopeChecksum)
      throw new Error("준비 완료되고 scope가 검증된 EvidenceBrief만 materialize할 수 있습니다");
    if (brief.references.length < 1 || brief.references.length > 12)
      throw new Error("Materialize할 EvidenceBrief reference는 1개 이상 12개 이하여야 합니다");

    const chunkById = new Map(snapshot.chunks.map((chunk) => [chunk.chunkId, chunk]));
    const snippets: EvidencePromptSnippet[] = [];
    let estimatedTokens = 0;
    let truncated = false;
    for (const reference of brief.references) {
      if (reference.kind !== "code" || reference.sourceKind !== "chunk")
        throw new Error("Prompt materialization은 code chunk reference만 허용합니다");
      if (
        reference.repositoryId !== brief.repositoryId ||
        reference.repositoryRevisionId !== brief.repositoryRevisionId ||
        reference.indexVersionId !== brief.indexVersionId
      ) {
        throw new Error("Prompt reference의 Repository, revision 또는 IndexVersion이 다릅니다");
      }
      const chunk = chunkById.get(reference.referenceId);
      if (!chunk) throw new Error(`Prompt chunk를 snapshot에서 찾을 수 없습니다: ${reference.referenceId}`);
      if (
        chunk.relativePath !== reference.relativePath ||
        chunk.startLine !== reference.startLine ||
        chunk.endLine !== reference.endLine ||
        chunk.startByte !== reference.startByte ||
        chunk.endByte !== reference.endByte ||
        chunk.contentHash !== reference.contentHash ||
        sha256(chunk.content) !== chunk.contentHash
      ) {
        throw new Error(`Prompt chunk checksum 또는 range가 다릅니다: ${reference.referenceId}`);
      }
      if (redactSecrets(chunk.content).content !== chunk.content)
        throw new Error(`Prompt chunk에 redaction되지 않은 secret이 있습니다: ${reference.referenceId}`);
      const snippetEstimatedTokens = Math.max(1, Math.ceil(chunk.content.length / 4));
      if (estimatedTokens + snippetEstimatedTokens > budget) {
        truncated = true;
        break;
      }
      snippets.push({
        referenceId: reference.referenceId,
        citation: `${join(repository.rootRef, reference.relativePath)}:${String(reference.startLine)}-${String(reference.endLine)}`,
        relativePath: reference.relativePath,
        startLine: reference.startLine,
        endLine: reference.endLine,
        content: chunk.content,
        estimatedTokens: snippetEstimatedTokens,
      });
      estimatedTokens += snippetEstimatedTokens;
    }
    if (snippets.length === 0) throw new Error("Prompt budget에 포함할 Evidence snippet이 없습니다");
    return {
      evidenceBriefId: brief.evidenceBriefId,
      indexVersionId: brief.indexVersionId,
      briefChecksum: brief.checksum,
      snippets,
      estimatedTokens,
      truncated,
    };
  }

  public async verifyNoMatch(context: TenantContext, input: MaterializeEvidencePromptInput): Promise<EvidenceBrief> {
    const workId = input.workId.trim();
    const evidenceBriefId = input.evidenceBriefId.trim();
    if (!workId || !evidenceBriefId) throw new Error("Work ID와 EvidenceBrief ID가 필요합니다");
    const { brief } = await this.verifyBriefSnapshot(context, workId, evidenceBriefId);
    if (
      brief.status !== "no_match" ||
      !brief.query.trim() ||
      !brief.scopeChecksum ||
      !/^[a-f0-9]{64}$/u.test(brief.scopeChecksum) ||
      brief.references.length !== 0 ||
      brief.claims.length !== 0
    ) {
      throw new Error("no-match EvidenceBrief 불변량이 다릅니다");
    }
    return brief;
  }

  private async verifyBriefSnapshot(
    context: TenantContext,
    workId: string,
    evidenceBriefId: string,
  ): Promise<{
    readonly brief: EvidenceBrief;
    readonly repository: Awaited<ReturnType<RepositoryStore["getRepository"]>>;
    readonly snapshot: IndexSnapshot;
  }> {
    const brief = await this.briefs.getBrief(context, evidenceBriefId);
    if (brief.organizationId !== context.organizationId || brief.workId !== workId)
      throw new Error("EvidenceBrief가 요청한 organization 또는 Work에 속하지 않습니다");
    const [repository, revision, index] = await Promise.all([
      this.repositories.getRepository(context, brief.repositoryId),
      this.repositories.getRevision(context, brief.repositoryRevisionId),
      this.repositories.getIndex(context, brief.indexVersionId),
    ]);
    if (
      repository.organizationId !== context.organizationId ||
      revision.repositoryId !== repository.repositoryId ||
      index.repositoryId !== repository.repositoryId ||
      index.repositoryRevisionId !== revision.repositoryRevisionId ||
      !["complete", "superseded"].includes(index.status)
    ) {
      throw new Error("EvidenceBrief의 Repository, revision 또는 IndexVersion 소유 관계가 다릅니다");
    }
    const configuration = await this.repositories.getConfiguration(context, index.configurationId);
    if (
      configuration.repositoryId !== repository.repositoryId ||
      configuration.checksum !== index.configurationChecksum ||
      brief.configurationChecksum !== index.configurationChecksum
    ) {
      throw new Error("EvidenceBrief의 IndexConfiguration checksum이 다릅니다");
    }
    const snapshot = await this.indexes.getSnapshot(context, index.indexVersionId);
    if (
      snapshot.indexVersionId !== index.indexVersionId ||
      !index.snapshotChecksum ||
      index.snapshotChecksum !== snapshot.checksum
    ) {
      throw new Error("EvidenceBrief의 snapshot checksum이 다릅니다");
    }
    return { brief, repository, snapshot };
  }
}
