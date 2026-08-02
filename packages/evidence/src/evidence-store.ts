import { createHash, randomUUID } from "node:crypto";

import { OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import type { IndexVersion } from "./contracts.js";
import type { IndexSnapshot, IndexStore } from "./index-store.js";
import type { CodeSearchResult } from "./search.js";
import type { RepositoryStore } from "./repository-store.js";
import {
  EVIDENCE_BRIEF_KNOWLEDGE_MIGRATION,
  EVIDENCE_BRIEF_MIGRATION,
  EVIDENCE_BRIEF_PROVENANCE_MIGRATION,
  EVIDENCE_CONTENT_MIGRATION,
  EVIDENCE_INDEX_MIGRATION,
  EVIDENCE_RESEARCH_MIGRATION,
} from "./schema.js";

export interface EvidenceReferenceSeed {
  readonly referenceId: string;
  readonly kind: "symbol" | "chunk";
  readonly symbolKey?: string;
}

export interface FrozenEvidenceRelation {
  readonly relationId: string;
  readonly relationKey: string;
  readonly kind: "contains" | "imports" | "calls" | "implements" | "documents";
  readonly sourceSymbolKey?: string;
  readonly targetSymbolKey?: string;
  readonly targetText: string;
  readonly resolved: boolean;
  readonly relativePath: string;
  readonly startLine: number;
}

export interface CodeEvidenceProvenance {
  readonly selection: "scope" | "direct-search" | "graph-neighbor";
  readonly snapshotChecksum: string;
  readonly paths: readonly {
    readonly seed: EvidenceReferenceSeed;
    readonly relation?: FrozenEvidenceRelation;
  }[];
}

export interface CodeEvidenceReferenceInput {
  readonly kind: "code";
  readonly result: CodeSearchResult;
  readonly provenance?: CodeEvidenceProvenance;
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
  readonly provenance: CodeEvidenceProvenance;
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
  readonly snapshotChecksum?: string;
  readonly query: string;
  readonly status: "ready" | "stale_warning" | "blocked" | "failed" | "no_match";
  readonly scopeChecksum?: string;
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

export interface CreateNoMatchEvidenceBriefInput {
  readonly commandId: string;
  readonly workId: string;
  readonly repositoryId: string;
  readonly indexVersionId: string;
  readonly query: string;
  readonly scopeChecksum: string;
  readonly replacesEvidenceBriefId?: string;
}

export interface CreateAutomaticEvidenceBriefInput {
  readonly commandId: string;
  readonly workId: string;
  readonly repositoryId: string;
  readonly indexVersionId: string;
  readonly query: string;
  readonly scopeChecksum: string;
  readonly references: readonly CodeEvidenceReferenceInput[];
  readonly replacesEvidenceBriefId?: string;
}

interface BriefRecord {
  readonly evidence_brief_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly repository_id: string;
  readonly repository_revision_id: string;
  readonly index_version_id: string;
  readonly configuration_checksum: string;
  readonly snapshot_checksum?: string;
  readonly query: string;
  readonly status: EvidenceBrief["status"];
  readonly scope_checksum?: string;
  readonly automatic_key?: string;
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

interface PersistAutomaticBriefInput {
  readonly commandId: string;
  readonly requestHash: string;
  readonly workId: string;
  readonly repositoryId: string;
  readonly repositoryRevisionId: string;
  readonly indexVersionId: string;
  readonly configurationChecksum: string;
  readonly snapshotChecksum: string;
  readonly query: string;
  readonly status: Extract<EvidenceBrief["status"], "ready" | "no_match">;
  readonly scopeChecksum: string;
  readonly references: readonly CodeEvidenceReference[];
  readonly claims: readonly EvidenceClaim[];
  readonly checksum: string;
  readonly replacesEvidenceBriefId?: string;
}

export function isLegacyAutomaticEvidenceBrief(brief: EvidenceBrief): boolean {
  return (
    brief.snapshotChecksum === undefined &&
    brief.scopeChecksum !== undefined &&
    (brief.status === "ready" || brief.status === "no_match") &&
    brief.references.every(
      (reference) => reference.kind === "code" && !("provenance" in (reference as unknown as object)),
    )
  );
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

function automaticBriefKeys(organizationId: string, workId: string): readonly [string, string] {
  const legacy = `${organizationId}:${workId}`;
  return [legacy, `${legacy}:provenance-v1`];
}

function frozenRelation(relation: IndexSnapshot["relations"][number]): FrozenEvidenceRelation {
  return {
    relationId: relation.relationId,
    relationKey: relation.relationKey,
    kind: relation.kind,
    ...(relation.sourceSymbolKey === undefined ? {} : { sourceSymbolKey: relation.sourceSymbolKey }),
    ...(relation.targetSymbolKey === undefined ? {} : { targetSymbolKey: relation.targetSymbolKey }),
    targetText: relation.targetText,
    resolved: relation.resolved,
    relativePath: relation.relativePath,
    startLine: relation.startLine,
  };
}

function referenceSeed(snapshot: IndexSnapshot, seed: EvidenceReferenceSeed): EvidenceReferenceSeed {
  const item =
    seed.kind === "symbol"
      ? snapshot.symbols.find((candidate) => candidate.symbolId === seed.referenceId)
      : snapshot.chunks.find((candidate) => candidate.chunkId === seed.referenceId);
  if (!item) throw new Error(`Evidence provenance seed를 snapshot에서 찾을 수 없습니다: ${seed.referenceId}`);
  const symbolKey = item.symbolKey;
  if (seed.symbolKey !== undefined && seed.symbolKey !== symbolKey)
    throw new Error(`Evidence provenance seed symbol 계보가 다릅니다: ${seed.referenceId}`);
  return {
    referenceId: seed.referenceId,
    kind: seed.kind,
    ...(symbolKey === undefined ? {} : { symbolKey }),
  };
}

function defaultProvenance(
  snapshot: IndexSnapshot,
  result: CodeSearchResult,
  selection: Extract<CodeEvidenceProvenance["selection"], "direct-search" | "scope"> = "direct-search",
): CodeEvidenceProvenance {
  return {
    selection,
    snapshotChecksum: snapshot.checksum,
    paths: [{ seed: referenceSeed(snapshot, { referenceId: result.referenceId, kind: result.kind }) }],
  };
}

function validatedProvenance(
  snapshot: IndexSnapshot,
  result: CodeSearchResult,
  provenance: CodeEvidenceProvenance | undefined,
): CodeEvidenceProvenance {
  const value = provenance ?? defaultProvenance(snapshot, result);
  if (value.snapshotChecksum !== snapshot.checksum)
    throw new Error("Evidence provenance snapshot checksum이 IndexVersion과 다릅니다");
  if (!(["scope", "direct-search", "graph-neighbor"] as const).includes(value.selection))
    throw new Error("Evidence provenance selection이 유효하지 않습니다");
  if (value.paths.length < 1 || value.paths.length > 64)
    throw new Error("Evidence provenance path 개수가 유효하지 않습니다");
  const selectedItem =
    result.kind === "symbol"
      ? snapshot.symbols.find((candidate) => candidate.symbolId === result.referenceId)
      : snapshot.chunks.find((candidate) => candidate.chunkId === result.referenceId);
  if (!selectedItem)
    throw new Error(`Evidence provenance reference를 snapshot에서 찾을 수 없습니다: ${result.referenceId}`);
  const selectedSymbolKey = selectedItem.symbolKey;
  const paths = value.paths.map((path) => {
    const seed = referenceSeed(snapshot, path.seed);
    if (value.selection === "scope" && seed.referenceId !== result.referenceId)
      throw new Error("Evidence scope provenance seed가 선택 reference와 다릅니다");
    if (value.selection !== "graph-neighbor") {
      if (path.relation !== undefined) throw new Error("직접 Evidence provenance에는 graph relation을 둘 수 없습니다");
      return { seed };
    }
    if (!path.relation || !selectedSymbolKey || !seed.symbolKey)
      throw new Error("Graph-neighbor Evidence provenance의 seed 또는 relation이 없습니다");
    const actual = snapshot.relations.find((relation) => relation.relationId === path.relation?.relationId);
    if (!actual || canonicalJson(frozenRelation(actual)) !== canonicalJson(path.relation))
      throw new Error("Evidence provenance relation이 frozen snapshot과 다릅니다");
    const connected =
      (actual.sourceSymbolKey === seed.symbolKey && actual.targetSymbolKey === selectedSymbolKey) ||
      (actual.targetSymbolKey === seed.symbolKey && actual.sourceSymbolKey === selectedSymbolKey);
    if (!actual.resolved || !connected)
      throw new Error("Evidence provenance relation이 seed와 선택 reference를 직접 연결하지 않습니다");
    return { seed, relation: frozenRelation(actual) };
  });
  const unique = new Map(paths.map((path) => [canonicalJson(path), path]));
  return {
    selection: value.selection,
    snapshotChecksum: snapshot.checksum,
    paths: [...unique.values()].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
  };
}

function briefChecksum(input: {
  readonly workId: string;
  readonly repositoryId: string;
  readonly repositoryRevisionId: string;
  readonly indexVersionId: string;
  readonly configurationChecksum: string;
  readonly snapshotChecksum?: string;
  readonly query: string;
  readonly status: EvidenceBrief["status"];
  readonly references: readonly EvidenceReference[];
  readonly claims: readonly EvidenceClaim[];
  readonly scopeChecksum?: string;
}): string {
  const { scopeChecksum, ...core } = input;
  return sha256(canonicalJson(scopeChecksum === undefined ? core : { ...core, scopeChecksum }));
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
      EVIDENCE_BRIEF_KNOWLEDGE_MIGRATION,
      EVIDENCE_BRIEF_PROVENANCE_MIGRATION,
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
    const snapshot = await this.verifiedSnapshot(context, index);
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
        return this.validateCodeReference(input.repositoryId, index, snapshot, reference.result, reference.provenance);
      }),
    );
    if (new Set(references.map((reference) => reference.referenceId)).size !== references.length)
      throw new Error("EvidenceBrief reference ID는 중복될 수 없습니다");
    const claims = await this.synthesizeClaims(query, references);
    const core = {
      workId: input.workId,
      repositoryId: input.repositoryId,
      repositoryRevisionId: index.repositoryRevisionId,
      indexVersionId: input.indexVersionId,
      configurationChecksum: index.configurationChecksum,
      snapshotChecksum: snapshot.checksum,
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
        "CREATE evidence_brief CONTENT { evidence_brief_id: $evidence_brief_id, organization_id: $organization_id, work_id: $work_id, repository_id: $repository_id, repository_revision_id: $repository_revision_id, index_version_id: $index_version_id, configuration_checksum: $configuration_checksum, snapshot_checksum: $snapshot_checksum, query: $query, status: 'ready', references_json: $references_json, claims_json: $claims_json, checksum: $checksum, created_by_user_id: $created_by_user_id, created_at: time::now() } RETURN AFTER;",
        {
          evidence_brief_id: evidenceBriefId,
          organization_id: context.organizationId,
          work_id: input.workId,
          repository_id: input.repositoryId,
          repository_revision_id: index.repositoryRevisionId,
          index_version_id: input.indexVersionId,
          configuration_checksum: index.configurationChecksum,
          snapshot_checksum: snapshot.checksum,
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

  public async createAutomaticBrief(
    context: TenantContext,
    input: CreateAutomaticEvidenceBriefInput,
  ): Promise<{ readonly brief: EvidenceBrief }> {
    await this.organizations.verifyTenantContext(context);
    if (!input.commandId.trim() || !input.workId.trim())
      throw new Error("EvidenceBrief command와 Work ID가 필요합니다");
    const query = input.query.trim();
    if (!query || query.length > 4_000) throw new Error("EvidenceBrief query는 1자 이상 4,000자 이하여야 합니다");
    if (!/^[a-f0-9]{64}$/u.test(input.scopeChecksum))
      throw new Error("EvidenceBrief scope checksum은 SHA-256 형식이어야 합니다");
    if (input.references.length < 1 || input.references.length > 12)
      throw new Error("Automatic EvidenceBrief reference는 1개 이상 12개 이하여야 합니다");
    await this.repositories.getRepository(context, input.repositoryId);
    const requestHash = sha256(canonicalJson(input));
    const replayed = await this.replay(context.organizationId, input.commandId, requestHash);
    if (replayed) return { brief: await this.getBrief(context, replayed.evidenceBriefId) };
    const existing = await this.findAutomaticByWork(context, input.workId);
    if (existing) {
      if (existing.scopeChecksum !== input.scopeChecksum)
        throw new Error("같은 Work의 automatic EvidenceBrief scope가 다릅니다");
      if (input.replacesEvidenceBriefId !== existing.evidenceBriefId) return { brief: existing };
      if (!isLegacyAutomaticEvidenceBrief(existing))
        throw new Error("완전한 automatic EvidenceBrief는 교체할 수 없습니다");
    }

    const index = await this.repositories.getIndex(context, input.indexVersionId);
    if (index.repositoryId !== input.repositoryId || !["complete", "superseded"].includes(index.status))
      throw new Error("EvidenceBrief IndexVersion은 같은 Repository의 완전한 snapshot이어야 합니다");
    const snapshot = await this.verifiedSnapshot(context, index);
    const references = input.references.map((reference) =>
      this.validateCodeReference(input.repositoryId, index, snapshot, reference.result, reference.provenance),
    );
    if (new Set(references.map((reference) => reference.referenceId)).size !== references.length)
      throw new Error("EvidenceBrief reference ID는 중복될 수 없습니다");
    const claims = await this.synthesizeClaims(query, references);
    const checksum = briefChecksum({
      workId: input.workId,
      repositoryId: input.repositoryId,
      repositoryRevisionId: index.repositoryRevisionId,
      indexVersionId: input.indexVersionId,
      configurationChecksum: index.configurationChecksum,
      snapshotChecksum: snapshot.checksum,
      query,
      status: "ready",
      references,
      claims,
      scopeChecksum: input.scopeChecksum,
    });
    return await this.persistAutomaticBrief(context, {
      commandId: input.commandId,
      requestHash,
      workId: input.workId,
      repositoryId: input.repositoryId,
      repositoryRevisionId: index.repositoryRevisionId,
      indexVersionId: input.indexVersionId,
      configurationChecksum: index.configurationChecksum,
      snapshotChecksum: snapshot.checksum,
      query,
      status: "ready",
      scopeChecksum: input.scopeChecksum,
      references,
      claims,
      checksum,
      ...(input.replacesEvidenceBriefId === undefined
        ? {}
        : { replacesEvidenceBriefId: input.replacesEvidenceBriefId }),
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

  public async findAutomaticByWork(context: TenantContext, workId: string): Promise<EvidenceBrief | undefined> {
    await this.organizations.verifyTenantContext(context);
    if (!workId.trim()) throw new Error("Work ID가 필요합니다");
    const automaticKeys = automaticBriefKeys(context.organizationId, workId);
    const [records] = await this.database.query<[BriefRecord[]]>(
      "SELECT * OMIT id FROM evidence_brief WHERE organization_id = $organization_id AND automatic_key IN $automatic_keys ORDER BY automatic_key DESC LIMIT 1;",
      { organization_id: context.organizationId, automatic_keys: automaticKeys },
    );
    return records[0] ? this.view(records[0], true) : undefined;
  }

  public async createNoMatch(
    context: TenantContext,
    input: CreateNoMatchEvidenceBriefInput,
  ): Promise<{ readonly brief: EvidenceBrief }> {
    await this.organizations.verifyTenantContext(context);
    if (!input.commandId.trim() || !input.workId.trim())
      throw new Error("EvidenceBrief command와 Work ID가 필요합니다");
    const query = input.query.trim();
    if (!query || query.length > 4_000) throw new Error("EvidenceBrief query는 1자 이상 4,000자 이하여야 합니다");
    if (!/^[a-f0-9]{64}$/u.test(input.scopeChecksum))
      throw new Error("EvidenceBrief scope checksum은 SHA-256 형식이어야 합니다");
    await this.repositories.getRepository(context, input.repositoryId);
    const requestHash = sha256(canonicalJson(input));
    const replayed = await this.replay(context.organizationId, input.commandId, requestHash);
    if (replayed) return { brief: await this.getBrief(context, replayed.evidenceBriefId) };
    const existing = await this.findAutomaticByWork(context, input.workId);
    if (existing) {
      if (existing.scopeChecksum !== input.scopeChecksum)
        throw new Error("같은 Work의 automatic EvidenceBrief scope가 다릅니다");
      if (input.replacesEvidenceBriefId !== existing.evidenceBriefId) return { brief: existing };
      if (!isLegacyAutomaticEvidenceBrief(existing))
        throw new Error("완전한 automatic EvidenceBrief는 교체할 수 없습니다");
    }
    const index = await this.repositories.getIndex(context, input.indexVersionId);
    if (index.repositoryId !== input.repositoryId || !["complete", "superseded"].includes(index.status))
      throw new Error("EvidenceBrief IndexVersion은 같은 Repository의 완전한 snapshot이어야 합니다");
    const snapshot = await this.verifiedSnapshot(context, index);
    const checksum = briefChecksum({
      workId: input.workId,
      repositoryId: input.repositoryId,
      repositoryRevisionId: index.repositoryRevisionId,
      indexVersionId: input.indexVersionId,
      configurationChecksum: index.configurationChecksum,
      snapshotChecksum: snapshot.checksum,
      query,
      status: "no_match",
      references: [],
      claims: [],
      scopeChecksum: input.scopeChecksum,
    });
    return await this.persistAutomaticBrief(context, {
      commandId: input.commandId,
      requestHash,
      workId: input.workId,
      repositoryId: input.repositoryId,
      repositoryRevisionId: index.repositoryRevisionId,
      indexVersionId: input.indexVersionId,
      configurationChecksum: index.configurationChecksum,
      snapshotChecksum: snapshot.checksum,
      query,
      status: "no_match",
      scopeChecksum: input.scopeChecksum,
      references: [],
      claims: [],
      checksum,
      ...(input.replacesEvidenceBriefId === undefined
        ? {}
        : { replacesEvidenceBriefId: input.replacesEvidenceBriefId }),
    });
  }

  public async listByWork(context: TenantContext, workId: string): Promise<readonly EvidenceBrief[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[BriefRecord[]]>(
      "SELECT * OMIT id FROM evidence_brief WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY created_at ASC;",
      { organization_id: context.organizationId, work_id: workId },
    );
    return records.map((record) => this.view(record, true));
  }

  private async verifiedSnapshot(context: TenantContext, index: IndexVersion): Promise<IndexSnapshot> {
    const snapshot = await this.indexes.getSnapshot(context, index.indexVersionId);
    if (!index.snapshotChecksum || index.snapshotChecksum !== snapshot.checksum)
      throw new Error("EvidenceBrief IndexVersion snapshot checksum이 다릅니다");
    return snapshot;
  }

  private validateCodeReference(
    repositoryId: string,
    index: IndexVersion,
    snapshot: IndexSnapshot,
    result: CodeSearchResult,
    provenance?: CodeEvidenceProvenance,
  ): CodeEvidenceReference {
    if (
      result.repositoryId !== repositoryId ||
      result.repositoryRevisionId !== index.repositoryRevisionId ||
      result.indexVersionId !== index.indexVersionId
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
      kind: "code",
      repositoryId,
      repositoryRevisionId: index.repositoryRevisionId,
      indexVersionId: index.indexVersionId,
      relativePath: result.relativePath,
      sourceKind: result.kind,
      startLine: result.startLine,
      endLine: result.endLine,
      startByte: result.startByte,
      endByte: result.endByte,
      contentHash: result.contentHash,
      parserConfidence: file.status,
      provenance: validatedProvenance(snapshot, result, provenance),
    };
  }

  private async synthesizeClaims(query: string, references: readonly EvidenceReference[]): Promise<EvidenceClaim[]> {
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
    return claims;
  }

  private async persistAutomaticBrief(
    context: TenantContext,
    input: PersistAutomaticBriefInput,
  ): Promise<{ readonly brief: EvidenceBrief }> {
    const automaticKeys = automaticBriefKeys(context.organizationId, input.workId);
    const automaticKey = automaticKeys[1];
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.replay(context.organizationId, input.commandId, input.requestHash, tx);
      if (repeated) return { brief: await this.getBrief(context, repeated.evidenceBriefId) };
      const [existing] = await tx.query<[BriefRecord[]]>(
        "SELECT * OMIT id FROM evidence_brief WHERE organization_id = $organization_id AND automatic_key IN $automatic_keys ORDER BY automatic_key DESC LIMIT 1;",
        { organization_id: context.organizationId, automatic_keys: automaticKeys },
      );
      if (existing[0]) {
        if (existing[0].scope_checksum !== input.scopeChecksum)
          throw new Error("같은 Work의 automatic EvidenceBrief scope가 다릅니다");
        const current = this.view(existing[0], true);
        if (input.replacesEvidenceBriefId !== current.evidenceBriefId) return { brief: current };
        if (!isLegacyAutomaticEvidenceBrief(current))
          throw new Error("완전한 automatic EvidenceBrief는 교체할 수 없습니다");
      }
      const evidenceBriefId = randomUUID();
      const [created] = await tx.query<[BriefRecord[]]>(
        "CREATE evidence_brief CONTENT { evidence_brief_id: $evidence_brief_id, organization_id: $organization_id, work_id: $work_id, repository_id: $repository_id, repository_revision_id: $repository_revision_id, index_version_id: $index_version_id, configuration_checksum: $configuration_checksum, snapshot_checksum: $snapshot_checksum, query: $query, status: $status, scope_checksum: $scope_checksum, automatic_key: $automatic_key, references_json: $references_json, claims_json: $claims_json, checksum: $checksum, created_by_user_id: $created_by_user_id, created_at: time::now() } RETURN AFTER;",
        {
          evidence_brief_id: evidenceBriefId,
          organization_id: context.organizationId,
          work_id: input.workId,
          repository_id: input.repositoryId,
          repository_revision_id: input.repositoryRevisionId,
          index_version_id: input.indexVersionId,
          configuration_checksum: input.configurationChecksum,
          snapshot_checksum: input.snapshotChecksum,
          query: input.query,
          status: input.status,
          scope_checksum: input.scopeChecksum,
          automatic_key: automaticKey,
          references_json: canonicalJson(input.references),
          claims_json: canonicalJson(input.claims),
          checksum: input.checksum,
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
          request_hash: input.requestHash,
          payload_json: canonicalJson({
            indexVersionId: input.indexVersionId,
            referenceCount: input.references.length,
            claimCount: input.claims.length,
          }),
          result_json: JSON.stringify({ evidenceBriefId }),
          actor_user_id: context.userId,
        },
      );
      return { brief: this.view(created[0], true) };
    });
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
      briefChecksum(
        record.scope_checksum === undefined
          ? {
              workId: record.work_id,
              repositoryId: record.repository_id,
              repositoryRevisionId: record.repository_revision_id,
              indexVersionId: record.index_version_id,
              configurationChecksum: record.configuration_checksum,
              ...(record.snapshot_checksum === undefined ? {} : { snapshotChecksum: record.snapshot_checksum }),
              query: record.query,
              status: record.status,
              references,
              claims,
            }
          : {
              workId: record.work_id,
              repositoryId: record.repository_id,
              repositoryRevisionId: record.repository_revision_id,
              indexVersionId: record.index_version_id,
              configurationChecksum: record.configuration_checksum,
              ...(record.snapshot_checksum === undefined ? {} : { snapshotChecksum: record.snapshot_checksum }),
              query: record.query,
              status: record.status,
              references,
              claims,
              scopeChecksum: record.scope_checksum,
            },
      ) !== record.checksum
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
      ...(record.snapshot_checksum === undefined ? {} : { snapshotChecksum: record.snapshot_checksum }),
      query: record.query,
      status: record.status,
      ...(record.scope_checksum === undefined ? {} : { scopeChecksum: record.scope_checksum }),
      references,
      claims,
      checksum: record.checksum,
      createdByUserId: record.created_by_user_id,
      createdAt: record.created_at,
    };
  }
}
