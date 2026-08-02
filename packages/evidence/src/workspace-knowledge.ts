import { createHash } from "node:crypto";

import type { TenantContext } from "@massion/identity";

import type { EvidenceRepository, IndexVersion } from "./contracts.js";
import type {
  CodeEvidenceProvenance,
  EvidenceBrief,
  EvidenceBriefStore,
  EvidenceReferenceSeed,
  FrozenEvidenceRelation,
} from "./evidence-store.js";
import { isLegacyAutomaticEvidenceBrief } from "./evidence-store.js";
import type { CodeGraphService } from "./graph.js";
import type { EvidenceIndexer } from "./indexer.js";
import type { IndexedChunk, IndexedRelation, IndexedSymbol, IndexSnapshot, IndexStore } from "./index-store.js";
import { normalizeRepositoryPath } from "./path.js";
import type { RepositoryStore } from "./repository-store.js";
import type { RepositoryRevisionCollector } from "./revision.js";
import type { ScanOptions } from "./scanner.js";
import type { CodeSearchResult, CodeSearchService } from "./search.js";

const SCHEMA_VERSION = "evidence-v1";
const MAX_REFERENCES = 12;
const MAX_GRAPH_NEIGHBORS = 8;
const GRAPH_RELATION_KINDS = new Set(["imports", "calls", "implements"]);
const KOREAN_PATH_POSTPOSITIONS = [
  "에서",
  "으로",
  "부터",
  "까지",
  "의",
  "을",
  "를",
  "은",
  "는",
  "이",
  "가",
  "과",
  "와",
  "에",
  "로",
  "만",
  "도",
] as const;
const QUERY_PATH_PREFIX_PUNCTUATION = new Set(["(", "[", "{", "'", '"', "`", ",", ";", ":", "!", "?"]);
const QUERY_PATH_SUFFIX_PUNCTUATION = new Set([")", "]", "}", "'", '"', "`", ",", ";", ":", "!", "?", "."]);

export interface WorkspaceKnowledgeOptions {
  readonly scanOptions: ScanOptions;
  readonly parserBundleVersion: string;
}

export interface PrepareWorkspaceKnowledgeInput {
  readonly commandId: string;
  readonly workId: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly root: string;
  readonly query: string;
  readonly relativePaths?: readonly string[];
}

export interface PrepareWorkspaceKnowledgeResult {
  readonly brief: EvidenceBrief;
}

interface NormalizedPrepareInput {
  readonly commandId: string;
  readonly workId: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly root: string;
  readonly query: string;
  readonly relativePaths?: readonly string[];
  readonly scopeChecksum: string;
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

function normalizedInput(input: PrepareWorkspaceKnowledgeInput): NormalizedPrepareInput {
  const commandId = input.commandId.trim();
  const workId = input.workId.trim();
  const workspaceId = input.workspaceId.trim();
  const workspaceName = input.workspaceName.trim();
  const root = input.root.trim();
  const query = input.query.trim().slice(0, 2_000);
  if (!commandId || !workId || !workspaceId || !workspaceName || !root)
    throw new Error("Command, Work, Workspace, Workspace name과 root가 필요합니다");
  if (!query) throw new Error("Workspace knowledge query가 필요합니다");
  if ((input.relativePaths?.length ?? 0) > 20)
    throw new Error("Workspace knowledge scope는 최대 20개 경로만 허용합니다");
  const paths = new Set<string>();
  for (const relativePath of input.relativePaths ?? []) {
    const normalized = normalizeRepositoryPath(relativePath);
    if (normalized !== relativePath)
      throw new Error("Workspace knowledge scope에는 정규화된 POSIX 상대 경로가 필요합니다");
    if (paths.has(relativePath)) throw new Error("Workspace knowledge scope 경로는 중복될 수 없습니다");
    paths.add(relativePath);
  }
  const relativePaths = paths.size > 0 ? [...paths].sort() : undefined;
  const scopeChecksum = sha256(canonicalJson({ workspaceId, query, relativePaths: relativePaths ?? [] }));
  return {
    commandId,
    workId,
    workspaceId,
    workspaceName,
    root,
    query,
    ...(relativePaths ? { relativePaths } : {}),
    scopeChecksum,
  };
}

function chunksForSymbol(snapshot: IndexSnapshot, symbolKey: string): readonly IndexedChunk[] {
  return snapshot.chunks.filter((chunk) => chunk.symbolKey === symbolKey);
}

function trimQueryPathPunctuation(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && QUERY_PATH_PREFIX_PUNCTUATION.has(token[start])) start += 1;
  while (start < end && QUERY_PATH_SUFFIX_PUNCTUATION.has(token[end - 1])) end -= 1;
  return token.slice(start, end);
}

function withoutKoreanPathPostposition(token: string): string {
  const postposition = KOREAN_PATH_POSTPOSITIONS.find((candidate) => token.endsWith(candidate));
  return postposition ? token.slice(0, -postposition.length) : token;
}

function exactRepositoryPathsInQuery(query: string): ReadonlySet<string> {
  const paths = new Set<string>();
  // 질의를 한 번만 토큰화해 snapshot 청크마다 정규식을 다시 만들지 않습니다.
  for (const rawToken of query.split(/\s+/u)) {
    const token = trimQueryPathPunctuation(withoutKoreanPathPostposition(trimQueryPathPunctuation(rawToken)));
    try {
      const normalized = normalizeRepositoryPath(token);
      if (normalized === token) paths.add(normalized);
    } catch {
      // 절대·상위·NUL·비정규화 경로는 후보에 넣지 않습니다.
    }
  }
  return paths;
}

function frozenRelation(relation: IndexedRelation): FrozenEvidenceRelation {
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

function provenance(
  selection: CodeEvidenceProvenance["selection"],
  snapshotChecksum: string,
  seed: EvidenceReferenceSeed,
  relations: readonly IndexedRelation[] = [],
): CodeEvidenceProvenance {
  return {
    selection,
    snapshotChecksum,
    paths:
      relations.length === 0
        ? [{ seed }]
        : relations
            .map((relation) => ({ seed, relation: frozenRelation(relation) }))
            .sort((left, right) => left.relation.relationKey.localeCompare(right.relation.relationKey)),
  };
}

export class WorkspaceKnowledgeService {
  public constructor(
    private readonly repositories: RepositoryStore,
    private readonly indexes: IndexStore,
    private readonly revisions: RepositoryRevisionCollector,
    private readonly indexer: EvidenceIndexer,
    private readonly search: CodeSearchService,
    private readonly graph: CodeGraphService,
    private readonly briefs: EvidenceBriefStore,
    private readonly options: WorkspaceKnowledgeOptions,
  ) {
    if (!options.parserBundleVersion.trim()) throw new Error("Parser bundle version이 필요합니다");
  }

  public async prepare(
    context: TenantContext,
    rawInput: PrepareWorkspaceKnowledgeInput,
  ): Promise<PrepareWorkspaceKnowledgeResult> {
    const input = normalizedInput(rawInput);
    const scanOptions = input.relativePaths
      ? {
          ...this.options.scanOptions,
          // 첨부 범위가 있으면 선택 파일만 인덱싱해 대규모 workspace 전체 스캔을 피합니다.
          include: input.relativePaths,
          includeIgnoredPaths: input.relativePaths,
        }
      : this.options.scanOptions;
    const existing = await this.briefs.findAutomaticByWork(context, input.workId);
    if (existing) {
      if (existing.scopeChecksum !== input.scopeChecksum)
        throw new Error("같은 Work의 automatic EvidenceBrief scope가 다릅니다");
      const repository = await this.repositories.findByWorkspace(context, input.workspaceId);
      if (!repository) throw new Error("Automatic EvidenceBrief의 Workspace Repository binding을 찾을 수 없습니다");
      const legacy = isLegacyAutomaticEvidenceBrief(existing);
      await this.verifyExistingBrief(context, repository, existing, legacy);
      if (!legacy) return { brief: existing };
      return await this.upgradeLegacyBrief(context, input.commandId, existing);
    }

    const captured = await this.revisions.capture(input.root, scanOptions);
    let repository = await this.repositories.findByWorkspace(context, input.workspaceId);
    if (!repository) {
      repository = (
        await this.repositories.register(context, {
          commandId: `${input.commandId}:repository`,
          workspaceId: input.workspaceId,
          name: input.workspaceName,
          providerKind: captured.providerKind,
          rootRef: captured.rootRealPath,
          rootRealPathHash: captured.rootRealPathHash,
        })
      ).repository;
    }
    if (repository.rootRealPathHash !== captured.rootRealPathHash)
      throw new Error("Workspace Repository root와 현재 canonical root가 다릅니다");

    const configurationValues = {
      parserBundleVersion: this.options.parserBundleVersion,
      schemaVersion: SCHEMA_VERSION,
      embeddingStatus: "unavailable" as const,
      settings: scanOptions,
    };
    const configuration = (
      await this.repositories.createConfiguration(context, {
        commandId: `${input.commandId}:configuration`,
        repositoryId: repository.repositoryId,
        checksum: sha256(canonicalJson(configurationValues)),
        ...configurationValues,
      })
    ).configuration;

    const revision = (
      await this.repositories.captureRevision(context, {
        commandId: `${input.commandId}:revision`,
        repositoryId: repository.repositoryId,
        providerRevision: captured.providerRevision,
        dirty: captured.dirty,
        ...(captured.dirtyFingerprint ? { dirtyFingerprint: captured.dirtyFingerprint } : {}),
        manifestChecksum: captured.manifestChecksum,
        rootRealPathHash: captured.rootRealPathHash,
        collectorVersion: captured.collectorVersion,
      })
    ).revision;
    const current = await this.repositories.getCurrentIndex(context, repository.repositoryId);
    if (current && (current.status !== "complete" || !current.current))
      throw new Error("Repository current IndexVersion이 complete 상태가 아닙니다");
    let index: IndexVersion;
    const reusable = (await this.repositories.listIndexes(context, repository.repositoryId)).find(
      (candidate) =>
        candidate.repositoryRevisionId === revision.repositoryRevisionId &&
        candidate.configurationId === configuration.configurationId &&
        (candidate.status === "complete" || candidate.status === "superseded"),
    );
    if (reusable) {
      // 동일 revision·configuration의 immutable index는 Work 재시도에서 재사용합니다.
      index = reusable;
    } else {
      const incremental = current?.configurationId === configuration.configurationId;
      index = (
        await this.indexer.index(context, {
          commandId: `${input.commandId}:index`,
          repositoryId: repository.repositoryId,
          repositoryRevisionId: revision.repositoryRevisionId,
          configurationId: configuration.configurationId,
          mode: incremental ? "incremental" : "full",
          // incremental이 참이면 TS가 current를 정의된 값으로 좁히므로 중복 검사(&& current)를 뺍니다.
          ...(incremental ? { parentIndexVersionId: current.indexVersionId } : {}),
          root: captured.rootRealPath,
          scanOptions,
        })
      ).index;
    }

    const snapshot = await this.indexes.getSnapshot(context, index.indexVersionId);
    if (index.snapshotChecksum !== snapshot.checksum)
      throw new Error("IndexVersion snapshot checksum이 저장된 snapshot과 다릅니다");
    const scopedPaths = input.relativePaths ? new Set(input.relativePaths) : undefined;
    const seeds = scopedPaths
      ? snapshot.chunks
          .filter((chunk) => scopedPaths.has(chunk.relativePath))
          .sort(
            (left, right) =>
              left.relativePath.localeCompare(right.relativePath) ||
              left.startByte - right.startByte ||
              left.chunkId.localeCompare(right.chunkId),
          )
      : [];
    if (scopedPaths && seeds.length === 0)
      throw new Error("명시된 Workspace knowledge scope에서 usable chunk를 찾을 수 없습니다");
    const snapshotChunkPaths = new Set(snapshot.chunks.map((chunk) => chunk.relativePath));
    const exactPaths = new Set(
      [...exactRepositoryPathsInQuery(input.query)].filter(
        (relativePath) => snapshotChunkPaths.has(relativePath) && (!scopedPaths || scopedPaths.has(relativePath)),
      ),
    );
    const searched = await this.search.search(context, {
      repositoryId: repository.repositoryId,
      indexVersionId: index.indexVersionId,
      query: input.query,
      limit: MAX_REFERENCES,
      ...(input.relativePaths ? { relativePaths: input.relativePaths } : {}),
    });
    if (searched.indexVersionId !== index.indexVersionId)
      throw new Error("검색 중 Repository current IndexVersion이 변경되었습니다");
    if (
      searched.repositoryId !== repository.repositoryId ||
      searched.repositoryRevisionId !== index.repositoryRevisionId
    ) {
      throw new Error("검색 결과의 RepositoryRevision이 선택한 IndexVersion과 다릅니다");
    }

    const chunkById = new Map(snapshot.chunks.map((chunk) => [chunk.chunkId, chunk]));
    const symbolById = new Map(snapshot.symbols.map((symbol) => [symbol.symbolId, symbol]));
    const symbolByKey = new Map(snapshot.symbols.map((symbol) => [symbol.symbolKey, symbol]));
    const scopedCandidates = seeds.map((chunk) => ({
      chunk,
      provenance: provenance("scope", snapshot.checksum, {
        referenceId: chunk.chunkId,
        kind: "chunk" as const,
        ...(chunk.symbolKey === undefined ? {} : { symbolKey: chunk.symbolKey }),
      }),
    }));
    const exactPathCandidates = snapshot.chunks
      .filter((chunk) => exactPaths.has(chunk.relativePath))
      .map((chunk) => ({
        chunk,
        provenance: provenance("scope", snapshot.checksum, {
          referenceId: chunk.chunkId,
          kind: "chunk" as const,
          ...(chunk.symbolKey === undefined ? {} : { symbolKey: chunk.symbolKey }),
        }),
      }));
    const searchCandidates: Array<{ readonly chunk: IndexedChunk; readonly provenance: CodeEvidenceProvenance }> = [];
    const roots: IndexedSymbol[] = [];
    const rootKeys = new Set<string>();
    for (const result of searched.results) {
      if (result.kind === "chunk") {
        const chunk = chunkById.get(result.referenceId);
        if (!chunk) continue;
        searchCandidates.push({
          chunk,
          provenance: provenance("direct-search", snapshot.checksum, {
            referenceId: chunk.chunkId,
            kind: "chunk",
            ...(chunk.symbolKey === undefined ? {} : { symbolKey: chunk.symbolKey }),
          }),
        });
        if (chunk.symbolKey) {
          const symbol = symbolByKey.get(chunk.symbolKey);
          if (symbol && !rootKeys.has(symbol.symbolKey)) {
            roots.push(symbol);
            rootKeys.add(symbol.symbolKey);
          }
        }
      } else {
        const symbol = symbolById.get(result.referenceId);
        if (!symbol) continue;
        searchCandidates.push(
          ...chunksForSymbol(snapshot, symbol.symbolKey).map((chunk) => ({
            chunk,
            provenance: provenance("direct-search", snapshot.checksum, {
              referenceId: symbol.symbolId,
              kind: "symbol" as const,
              symbolKey: symbol.symbolKey,
            }),
          })),
        );
        if (!rootKeys.has(symbol.symbolKey)) {
          roots.push(symbol);
          rootKeys.add(symbol.symbolKey);
        }
      }
    }

    const graphCandidates: Array<{ readonly chunk: IndexedChunk; readonly provenance: CodeEvidenceProvenance }> = [];
    const graphSymbolKeys = new Set<string>();
    for (const root of roots) {
      if (scopedPaths && !scopedPaths.has(root.relativePath)) continue;
      const neighbors = await this.graph.neighbors(context, {
        repositoryId: repository.repositoryId,
        indexVersionId: index.indexVersionId,
        symbolKey: root.symbolKey,
        direction: "both",
        depth: 1,
      });
      if (neighbors.indexVersionId !== index.indexVersionId)
        throw new Error("Graph 결과의 IndexVersion이 선택한 snapshot과 다릅니다");
      for (const neighbor of neighbors.nodes) {
        const relations = neighbors.edges
          .filter(
            (edge) =>
              GRAPH_RELATION_KINDS.has(edge.kind) &&
              ((edge.sourceSymbolKey === root.symbolKey && edge.targetSymbolKey === neighbor.symbolKey) ||
                (edge.targetSymbolKey === root.symbolKey && edge.sourceSymbolKey === neighbor.symbolKey)),
          )
          .sort((left, right) => left.relationKey.localeCompare(right.relationKey));
        if (relations.length === 0) continue;
        if (scopedPaths && (!scopedPaths.has(root.relativePath) || !scopedPaths.has(neighbor.relativePath))) continue;
        if (!graphSymbolKeys.has(neighbor.symbolKey)) {
          if (graphSymbolKeys.size >= MAX_GRAPH_NEIGHBORS) continue;
          graphSymbolKeys.add(neighbor.symbolKey);
        }
        const neighborProvenance = provenance(
          "graph-neighbor",
          snapshot.checksum,
          { referenceId: root.symbolId, kind: "symbol", symbolKey: root.symbolKey },
          relations,
        );
        graphCandidates.push(
          ...chunksForSymbol(snapshot, neighbor.symbolKey).map((chunk) => ({
            chunk,
            provenance: neighborProvenance,
          })),
        );
      }
    }
    const selected = new Map<string, { readonly chunk: IndexedChunk; readonly provenance: CodeEvidenceProvenance }>();
    for (const candidate of [...scopedCandidates, ...exactPathCandidates, ...searchCandidates, ...graphCandidates]) {
      const existing = selected.get(candidate.chunk.chunkId);
      if (existing) {
        if (existing.provenance.selection !== candidate.provenance.selection) continue;
        const paths = new Map(
          [...existing.provenance.paths, ...candidate.provenance.paths].map((path) => [canonicalJson(path), path]),
        );
        selected.set(candidate.chunk.chunkId, {
          chunk: candidate.chunk,
          provenance: {
            ...existing.provenance,
            paths: [...paths.values()].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
          },
        });
        continue;
      }
      if (selected.size >= MAX_REFERENCES) continue;
      selected.set(candidate.chunk.chunkId, candidate);
    }

    const baseBrief = {
      commandId: `${input.commandId}:brief`,
      workId: input.workId,
      repositoryId: repository.repositoryId,
      indexVersionId: index.indexVersionId,
      query: input.query,
      scopeChecksum: input.scopeChecksum,
    };
    if (selected.size === 0) return await this.briefs.createNoMatch(context, baseBrief);
    const references = [...selected.values()].map(({ chunk, provenance: referenceProvenance }, position) => ({
      kind: "code" as const,
      result: this.chunkResult(repository, index, chunk, position + 1),
      provenance: referenceProvenance,
    }));
    return await this.briefs.createAutomaticBrief(context, { ...baseBrief, references });
  }

  private async upgradeLegacyBrief(
    context: TenantContext,
    commandId: string,
    brief: EvidenceBrief,
  ): Promise<PrepareWorkspaceKnowledgeResult> {
    if (!brief.scopeChecksum || !isLegacyAutomaticEvidenceBrief(brief)) {
      throw new Error("Legacy automatic EvidenceBrief 계보가 유효하지 않습니다");
    }
    const base = {
      commandId: `${commandId}:brief-upgrade`,
      workId: brief.workId,
      repositoryId: brief.repositoryId,
      indexVersionId: brief.indexVersionId,
      query: brief.query,
      scopeChecksum: brief.scopeChecksum,
      replacesEvidenceBriefId: brief.evidenceBriefId,
    };
    if (brief.status === "no_match") return await this.briefs.createNoMatch(context, base);
    const references = brief.references.map((reference, index) => {
      if (reference.kind !== "code") throw new Error("Automatic EvidenceBrief에는 code reference만 허용됩니다");
      return {
        kind: "code" as const,
        result: {
          referenceId: reference.referenceId,
          kind: reference.sourceKind,
          repositoryId: reference.repositoryId,
          repositoryRevisionId: reference.repositoryRevisionId,
          indexVersionId: reference.indexVersionId,
          relativePath: reference.relativePath,
          startLine: reference.startLine,
          endLine: reference.endLine,
          startByte: reference.startByte,
          endByte: reference.endByte,
          contentHash: reference.contentHash,
          exact: true,
          matchModes: ["exact" as const],
          rank: index + 1,
        },
      };
    });
    return await this.briefs.createAutomaticBrief(context, { ...base, references });
  }

  private async verifyExistingBrief(
    context: TenantContext,
    repository: EvidenceRepository,
    brief: EvidenceBrief,
    allowLegacy = false,
  ): Promise<void> {
    if (!brief.scopeChecksum || !["ready", "no_match"].includes(brief.status))
      throw new Error("Automatic EvidenceBrief 상태 또는 scope가 올바르지 않습니다");
    const [revision, index] = await Promise.all([
      this.repositories.getRevision(context, brief.repositoryRevisionId),
      this.repositories.getIndex(context, brief.indexVersionId),
    ]);
    if (
      brief.repositoryId !== repository.repositoryId ||
      revision.repositoryId !== repository.repositoryId ||
      revision.rootRealPathHash !== repository.rootRealPathHash ||
      index.repositoryId !== repository.repositoryId ||
      index.repositoryRevisionId !== revision.repositoryRevisionId ||
      !["complete", "superseded"].includes(index.status)
    ) {
      throw new Error("Automatic EvidenceBrief의 Repository 또는 IndexVersion 소유 관계가 다릅니다");
    }
    const configuration = await this.repositories.getConfiguration(context, index.configurationId);
    if (
      configuration.repositoryId !== repository.repositoryId ||
      configuration.checksum !== index.configurationChecksum ||
      brief.configurationChecksum !== index.configurationChecksum
    ) {
      throw new Error("Automatic EvidenceBrief의 IndexConfiguration checksum이 다릅니다");
    }
    const snapshot = await this.indexes.getSnapshot(context, index.indexVersionId);
    if (
      !index.snapshotChecksum ||
      index.snapshotChecksum !== snapshot.checksum ||
      (brief.snapshotChecksum === undefined ? !allowLegacy : brief.snapshotChecksum !== snapshot.checksum)
    )
      throw new Error("Automatic EvidenceBrief의 snapshot checksum이 다릅니다");
  }

  private chunkResult(
    repository: EvidenceRepository,
    index: IndexVersion,
    chunk: IndexedChunk,
    rank: number,
  ): CodeSearchResult {
    return {
      referenceId: chunk.chunkId,
      kind: "chunk",
      repositoryId: repository.repositoryId,
      repositoryRevisionId: index.repositoryRevisionId,
      indexVersionId: index.indexVersionId,
      relativePath: chunk.relativePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      startByte: chunk.startByte,
      endByte: chunk.endByte,
      contentHash: chunk.contentHash,
      content: chunk.content,
      exact: false,
      matchModes: ["lexical"],
      rank,
    };
  }
}
