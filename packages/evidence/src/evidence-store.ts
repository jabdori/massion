import { createHash, randomUUID } from "node:crypto";

import { OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import type { CodeSearchResult } from "./search.js";
import type { IndexStore } from "./index-store.js";
import type { RepositoryStore } from "./repository-store.js";
import {
  EVIDENCE_BRIEF_MIGRATION,
  EVIDENCE_CONTENT_MIGRATION,
  EVIDENCE_INDEX_MIGRATION,
  EVIDENCE_RESEARCH_MIGRATION,
} from "./schema.js";

export interface CodeEvidenceReferenceInput {
  readonly kind: "code";
  readonly result: CodeSearchResult;
}

export interface ExternalEvidenceReferenceInput {
  readonly kind: "external";
  readonly externalSourceId: string;
  readonly contentHash: string;
}

export type EvidenceReferenceInput = CodeEvidenceReferenceInput | ExternalEvidenceReferenceInput;

export interface CodeEvidenceReference {
  readonly referenceId: string;
  readonly kind: "code";
  readonly repositoryId: string;
  readonly repositoryRevisionId: string;
  readonly indexVersionId: string;
  readonly relativePath: string;
  readonly sourceKind: "symbol" | "chunk";
  readonly startLine: number;
  readonly endLine: number;
  readonly startByte: number;
  readonly endByte: number;
  readonly contentHash: string;
  readonly parserConfidence: "complete" | "partial";
}

export interface ExternalEvidenceReference {
  readonly referenceId: string;
  readonly kind: "external";
  readonly externalSourceId: string;
  readonly canonicalUrl: string;
  readonly fetchedAt: string;
  readonly mediaType: string;
  readonly contentHash: string;
}

export type EvidenceReference = CodeEvidenceReference | ExternalEvidenceReference;

export interface EvidenceClaim {
  readonly claimId: string;
  readonly text: string;
  readonly referenceIds: readonly string[];
}

export interface EvidenceSynthesisPort {
  synthesize(input: {
    readonly query: string;
    readonly references: readonly EvidenceReference[];
  }): Promise<{ readonly claims: readonly { readonly text: string; readonly referenceIds: readonly string[] }[] }>;
}

export interface EvidenceBrief {
  readonly evidenceBriefId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly repositoryId: string;
  readonly repositoryRevisionId: string;
  readonly indexVersionId: string;
  readonly configurationChecksum: string;
  readonly query: string;
  readonly status: "ready" | "stale_warning" | "blocked" | "failed";
  readonly references: readonly EvidenceReference[];
  readonly claims: readonly EvidenceClaim[];
  readonly checksum: string;
  readonly createdByUserId: string;
  readonly createdAt: unknown;
}

export interface CreateEvidenceBriefInput {
  readonly commandId: string;
  readonly workId: string;
  readonly repositoryId: string;
  readonly indexVersionId: string;
  readonly query: string;
  readonly references: readonly EvidenceReferenceInput[];
}

interface BriefRecord {
  readonly evidence_brief_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly repository_id: string;
  readonly repository_revision_id: string;
  readonly index_version_id: string;
  readonly configuration_checksum: string;
  readonly query: string;
  readonly status: EvidenceBrief["status"];
  readonly references_json: string;
  readonly claims_json: string;
  readonly checksum: string;
  readonly created_by_user_id: string;
  readonly created_at: unknown;
}

interface EventRecord {
  readonly request_hash: string;
  readonly result_json: string;
}

interface ExternalSourceRecord {
  readonly external_source_id: string;
  readonly canonical_url: string;
  readonly fetched_at: unknown;
  readonly media_type: string;
  readonly content_hash: string;
  readonly content: string;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function briefChecksum(input: {
  readonly workId: string;
  readonly repositoryId: string;
  readonly repositoryRevisionId: string;
  readonly indexVersionId: string;
  readonly configurationChecksum: string;
  readonly query: string;
  readonly status: EvidenceBrief["status"];
  readonly references: readonly EvidenceReference[];
  readonly claims: readonly EvidenceClaim[];
}): string {
  return sha256(canonicalJson(input));
}

export class EvidenceBriefStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly repositories: RepositoryStore,
    private readonly indexes: IndexStore,
    private readonly synthesis?: EvidenceSynthesisPort,
  ) {}

  public static async create(
    database: MassionDatabase,
    repositories: RepositoryStore,
    indexes: IndexStore,
    synthesis?: EvidenceSynthesisPort,
  ): Promise<EvidenceBriefStore> {
    const organizations = await OrganizationService.create(database);
    await applyMigrations(database, [
      EVIDENCE_INDEX_MIGRATION,
      EVIDENCE_CONTENT_MIGRATION,
      EVIDENCE_BRIEF_MIGRATION,
      EVIDENCE_RESEARCH_MIGRATION,
    ]);
    return new EvidenceBriefStore(database, organizations, repositories, indexes, synthesis);
  }

  public async createBrief(
    context: TenantContext,
    input: CreateEvidenceBriefInput,
  ): Promise<{ readonly brief: EvidenceBrief }> {
    await this.organizations.verifyTenantContext(context);
    if (!input.commandId.trim() || !input.workId.trim())
      throw new Error("EvidenceBrief command와 Work ID가 필요합니다");
    const query = input.query.trim();
    if (!query || query.length > 4_000) throw new Error("EvidenceBrief query는 1자 이상 4,000자 이하여야 합니다");
    if (input.references.length === 0) throw new Error("EvidenceBrief에는 reference가 필요합니다");
    await this.repositories.getRepository(context, input.repositoryId);
    const requestHash = sha256(canonicalJson(input));
    const replayed = await this.replay(context.organizationId, input.commandId, requestHash);
    if (replayed) return { brief: await this.getBrief(context, replayed.evidenceBriefId) };

    const index = await this.repositories.getIndex(context, input.indexVersionId);
    if (index.repositoryId !== input.repositoryId || !["complete", "superseded"].includes(index.status))
      throw new Error("EvidenceBrief IndexVersion은 같은 Repository의 완전한 snapshot이어야 합니다");
    const snapshot = await this.indexes.getSnapshot(context, input.indexVersionId);
    const references = await Promise.all(
      input.references.map(async (reference): Promise<EvidenceReference> => {
        if (reference.kind === "external") {
          const [records] = await this.database.query<[ExternalSourceRecord[]]>(
            "SELECT external_source_id, canonical_url, fetched_at, media_type, content_hash, content FROM external_research_source WHERE organization_id = $organization_id AND external_source_id = $external_source_id LIMIT 1;",
            { organization_id: context.organizationId, external_source_id: reference.externalSourceId },
          );
          const source = records[0];
          if (!source) throw new Error(`External evidence reference를 찾을 수 없습니다: ${reference.externalSourceId}`);
          if (!source.content.trim()) throw new Error("External research URL-only source는 evidence가 아닙니다");
          if (source.content_hash !== reference.contentHash || sha256(source.content) !== source.content_hash)
            throw new Error(`External evidence reference checksum이 다릅니다: ${reference.externalSourceId}`);
          return {
            referenceId: source.external_source_id,
            kind: "external",
            externalSourceId: source.external_source_id,
            canonicalUrl: source.canonical_url,
            fetchedAt: String(source.fetched_at),
            mediaType: source.media_type,
            contentHash: source.content_hash,
          };
        }
        const result = reference.result;
        if (
          result.repositoryId !== input.repositoryId ||
          result.repositoryRevisionId !== index.repositoryRevisionId ||
          result.indexVersionId !== input.indexVersionId
        ) {
          throw new Error("Reference의 RepositoryRevision 또는 IndexVersion이 EvidenceBrief와 다릅니다");
        }
        const item =
          result.kind === "symbol"
            ? snapshot.symbols.find((symbol) => symbol.symbolId === result.referenceId)
            : snapshot.chunks.find((chunk) => chunk.chunkId === result.referenceId);
        if (!item) throw new Error(`Evidence reference를 IndexVersion에서 찾을 수 없습니다: ${result.referenceId}`);
        if (
          item.relativePath !== result.relativePath ||
          item.startLine !== result.startLine ||
          item.endLine !== result.endLine ||
          item.startByte !== result.startByte ||
          item.endByte !== result.endByte ||
          item.contentHash !== result.contentHash
        ) {
          throw new Error(`Evidence reference checksum 또는 range가 다릅니다: ${result.referenceId}`);
        }
        const file = snapshot.files.find((candidate) => candidate.sourceFileId === item.sourceFileId);
        if (!file) throw new Error(`Evidence reference의 SourceFile을 찾을 수 없습니다: ${result.referenceId}`);
        return {
          referenceId: result.referenceId,
          kind: "code" as const,
          repositoryId: input.repositoryId,
          repositoryRevisionId: index.repositoryRevisionId,
          indexVersionId: input.indexVersionId,
          relativePath: result.relativePath,
          sourceKind: result.kind,
          startLine: result.startLine,
          endLine: result.endLine,
          startByte: result.startByte,
          endByte: result.endByte,
          contentHash: result.contentHash,
          parserConfidence: file.status,
        };
      }),
    );
    if (new Set(references.map((reference) => reference.referenceId)).size !== references.length)
      throw new Error("EvidenceBrief reference ID는 중복될 수 없습니다");
    const synthesized = this.synthesis ? await this.synthesis.synthesize({ query, references }) : { claims: [] };
    const referenceIds = new Set(references.map((reference) => reference.referenceId));
    const claims: EvidenceClaim[] = synthesized.claims.map((claim) => {
      const text = claim.text.trim();
      if (!text || claim.referenceIds.length === 0) throw new Error("Evidence claim에는 text와 citation이 필요합니다");
      if (claim.referenceIds.some((referenceId) => !referenceIds.has(referenceId)))
        throw new Error("Evidence claim은 제공된 reference ID만 인용할 수 있습니다");
      const cited = [...new Set(claim.referenceIds)].sort();
      return { claimId: sha256(`${text}\0${cited.join("\0")}`), text, referenceIds: cited };
    });
    if (new Set(claims.map((claim) => claim.claimId)).size !== claims.length)
      throw new Error("Evidence claim은 중복될 수 없습니다");
    const core = {
      workId: input.workId,
      repositoryId: input.repositoryId,
      repositoryRevisionId: index.repositoryRevisionId,
      indexVersionId: input.indexVersionId,
      configurationChecksum: index.configurationChecksum,
      query,
      status: "ready" as const,
      references,
      claims,
    };
    const checksum = briefChecksum(core);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.replay(context.organizationId, input.commandId, requestHash, tx);
      if (repeated) return { brief: await this.getBrief(context, repeated.evidenceBriefId) };
      const evidenceBriefId = randomUUID();
      const [created] = await tx.query<[BriefRecord[]]>(
        "CREATE evidence_brief CONTENT { evidence_brief_id: $evidence_brief_id, organization_id: $organization_id, work_id: $work_id, repository_id: $repository_id, repository_revision_id: $repository_revision_id, index_version_id: $index_version_id, configuration_checksum: $configuration_checksum, query: $query, status: 'ready', references_json: $references_json, claims_json: $claims_json, checksum: $checksum, created_by_user_id: $created_by_user_id, created_at: time::now() } RETURN AFTER;",
        {
          evidence_brief_id: evidenceBriefId,
          organization_id: context.organizationId,
          work_id: input.workId,
          repository_id: input.repositoryId,
          repository_revision_id: index.repositoryRevisionId,
          index_version_id: input.indexVersionId,
          configuration_checksum: index.configurationChecksum,
          query,
          references_json: canonicalJson(references),
          claims_json: canonicalJson(claims),
          checksum,
          created_by_user_id: context.userId,
        },
      );
      if (!created[0]) throw new Error("EvidenceBrief 생성 결과가 없습니다");
      await tx.query(
        "CREATE evidence_brief_event CONTENT { event_id: $event_id, organization_id: $organization_id, evidence_brief_id: $evidence_brief_id, repository_id: $repository_id, command_id: $command_id, request_hash: $request_hash, event_type: 'evidence_brief_created', payload_json: $payload_json, result_json: $result_json, actor_user_id: $actor_user_id, created_at: time::now() };",
        {
          event_id: randomUUID(),
          organization_id: context.organizationId,
          evidence_brief_id: evidenceBriefId,
          repository_id: input.repositoryId,
          command_id: input.commandId,
          request_hash: requestHash,
          payload_json: canonicalJson({
            indexVersionId: input.indexVersionId,
            referenceCount: references.length,
            claimCount: claims.length,
          }),
          result_json: JSON.stringify({ evidenceBriefId }),
          actor_user_id: context.userId,
        },
      );
      return { brief: this.view(created[0], true) };
    });
  }

  public async getBrief(context: TenantContext, evidenceBriefId: string): Promise<EvidenceBrief> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[BriefRecord[]]>(
      "SELECT * OMIT id FROM evidence_brief WHERE organization_id = $organization_id AND evidence_brief_id = $evidence_brief_id LIMIT 1;",
      { organization_id: context.organizationId, evidence_brief_id: evidenceBriefId },
    );
    if (!records[0]) throw new Error(`EvidenceBrief를 찾을 수 없습니다: ${evidenceBriefId}`);
    await this.repositories.getRepository(context, records[0].repository_id);
    return this.view(records[0], true);
  }

  private async replay(
    organizationId: string,
    commandId: string,
    requestHash: string,
    executor: QueryExecutor = this.database,
  ): Promise<{ readonly evidenceBriefId: string } | undefined> {
    const [events] = await executor.query<[EventRecord[]]>(
      "SELECT request_hash, result_json FROM evidence_brief_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    if (!events[0]) return undefined;
    if (events[0].request_hash !== requestHash)
      throw new Error("같은 commandId에 다른 EvidenceBrief 요청을 사용할 수 없습니다");
    return JSON.parse(events[0].result_json) as { readonly evidenceBriefId: string };
  }

  private view(record: BriefRecord, verify: boolean): EvidenceBrief {
    const references = JSON.parse(record.references_json) as EvidenceReference[];
    const claims = JSON.parse(record.claims_json) as EvidenceClaim[];
    if (
      verify &&
      briefChecksum({
        workId: record.work_id,
        repositoryId: record.repository_id,
        repositoryRevisionId: record.repository_revision_id,
        indexVersionId: record.index_version_id,
        configurationChecksum: record.configuration_checksum,
        query: record.query,
        status: record.status,
        references,
        claims,
      }) !== record.checksum
    ) {
      throw new Error(`EvidenceBrief checksum이 일치하지 않습니다: ${record.evidence_brief_id}`);
    }
    return {
      evidenceBriefId: record.evidence_brief_id,
      organizationId: record.organization_id,
      workId: record.work_id,
      repositoryId: record.repository_id,
      repositoryRevisionId: record.repository_revision_id,
      indexVersionId: record.index_version_id,
      configurationChecksum: record.configuration_checksum,
      query: record.query,
      status: record.status,
      references,
      claims,
      checksum: record.checksum,
      createdByUserId: record.created_by_user_id,
      createdAt: record.created_at,
    };
  }
}
