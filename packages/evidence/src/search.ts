import type { TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase } from "@massion/storage";

import type { IndexedChunk, IndexedSymbol, IndexStore } from "./index-store.js";
import type { EvidenceMetrics } from "./metrics.js";
import type { RepositoryStore } from "./repository-store.js";
import {
  EVIDENCE_CONTENT_MIGRATION,
  EVIDENCE_INDEX_MIGRATION,
  EVIDENCE_SEARCH_INDEX_MIGRATION,
  EVIDENCE_SEARCH_MIGRATION,
} from "./schema.js";

export interface EmbeddingSearchInput {
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly indexVersionId: string;
  readonly embeddingVersion: string;
  readonly query: string;
  readonly limit: number;
}

export interface EmbeddingSearchCandidate {
  readonly chunkId: string;
  readonly indexVersionId: string;
  readonly embeddingVersion: string;
  readonly score: number;
}

export interface EmbeddingSearchPort {
  search(input: EmbeddingSearchInput): Promise<readonly EmbeddingSearchCandidate[]>;
}

export interface CodeSearchInput {
  readonly repositoryId: string;
  readonly query: string;
  readonly limit: number;
}

export type CodeSearchMatchMode = "exact" | "lexical" | "embedding";

export interface CodeSearchResult {
  readonly referenceId: string;
  readonly kind: "symbol" | "chunk";
  readonly repositoryId: string;
  readonly repositoryRevisionId: string;
  readonly indexVersionId: string;
  readonly relativePath: string;
  readonly qualifiedName?: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly startByte: number;
  readonly endByte: number;
  readonly contentHash: string;
  readonly content?: string;
  readonly exact: boolean;
  readonly matchModes: readonly CodeSearchMatchMode[];
  readonly rank: number;
}

export interface CodeSearchResponse {
  readonly repositoryId: string;
  readonly repositoryRevisionId: string;
  readonly indexVersionId: string;
  readonly searchMode: "lexical" | "hybrid" | "lexical_fallback";
  readonly embeddingStatus: "unavailable" | "pending" | "failed" | "complete" | "provider_error" | "version_mismatch";
  readonly results: readonly CodeSearchResult[];
}

interface LexicalChunkRecord {
  readonly chunk_id: string;
  readonly chunk_key: string;
  readonly relative_path: string;
  readonly symbol_key?: string;
  readonly start_byte: number;
  readonly end_byte: number;
  readonly start_line: number;
  readonly end_line: number;
  readonly content: string;
  readonly content_hash: string;
  readonly score: number;
}

interface RankedCandidate {
  readonly result: Omit<CodeSearchResult, "matchModes" | "rank">;
  readonly modes: Set<CodeSearchMatchMode>;
  score: number;
}

function symbolResult(
  symbol: IndexedSymbol,
  repositoryId: string,
  repositoryRevisionId: string,
  indexVersionId: string,
): Omit<CodeSearchResult, "matchModes" | "rank"> {
  return {
    referenceId: symbol.symbolId,
    kind: "symbol",
    repositoryId,
    repositoryRevisionId,
    indexVersionId,
    relativePath: symbol.relativePath,
    qualifiedName: symbol.qualifiedName,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    startByte: symbol.startByte,
    endByte: symbol.endByte,
    contentHash: symbol.contentHash,
    exact: true,
  };
}

function chunkResult(
  chunk: IndexedChunk | LexicalChunkRecord,
  repositoryId: string,
  repositoryRevisionId: string,
  indexVersionId: string,
  exact: boolean,
): Omit<CodeSearchResult, "matchModes" | "rank"> {
  const indexed = "chunkId" in chunk;
  return {
    referenceId: indexed ? chunk.chunkId : chunk.chunk_id,
    kind: "chunk",
    repositoryId,
    repositoryRevisionId,
    indexVersionId,
    relativePath: indexed ? chunk.relativePath : chunk.relative_path,
    startLine: indexed ? chunk.startLine : chunk.start_line,
    endLine: indexed ? chunk.endLine : chunk.end_line,
    startByte: indexed ? chunk.startByte : chunk.start_byte,
    endByte: indexed ? chunk.endByte : chunk.end_byte,
    contentHash: indexed ? chunk.contentHash : chunk.content_hash,
    content: chunk.content,
    exact,
  };
}

export class CodeSearchService {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly repositories: RepositoryStore,
    private readonly indexes: IndexStore,
    private readonly embeddings?: EmbeddingSearchPort,
    private readonly metrics?: Pick<EvidenceMetrics, "recordSearch">,
  ) {}

  public static async create(
    database: MassionDatabase,
    repositories: RepositoryStore,
    indexes: IndexStore,
    embeddings?: EmbeddingSearchPort,
    metrics?: Pick<EvidenceMetrics, "recordSearch">,
  ): Promise<CodeSearchService> {
    await applyMigrations(database, [
      EVIDENCE_INDEX_MIGRATION,
      EVIDENCE_CONTENT_MIGRATION,
      EVIDENCE_SEARCH_MIGRATION,
      EVIDENCE_SEARCH_INDEX_MIGRATION,
    ]);
    return new CodeSearchService(database, repositories, indexes, embeddings, metrics);
  }

  public async search(context: TenantContext, input: CodeSearchInput): Promise<CodeSearchResponse> {
    const query = input.query.trim();
    if (!query || query.length > 2_000) throw new Error("Code search query는 1자 이상 2,000자 이하여야 합니다");
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      throw new Error("Code search limit은 1 이상 100 이하여야 합니다");
    const current = await this.repositories.getCurrentIndex(context, input.repositoryId);
    if (!current || current.status !== "complete" || !current.current)
      throw new Error("검색할 current complete IndexVersion이 없습니다");
    const snapshot = await this.indexes.getSnapshot(context, current.indexVersionId);
    const candidates = new Map<string, RankedCandidate>();
    const add = (
      result: Omit<CodeSearchResult, "matchModes" | "rank">,
      mode: CodeSearchMatchMode,
      score: number,
    ): void => {
      const existing = candidates.get(result.referenceId);
      if (existing) {
        existing.modes.add(mode);
        existing.score += score;
      } else {
        candidates.set(result.referenceId, { result, modes: new Set([mode]), score });
      }
    };

    for (const symbol of snapshot.symbols.filter(
      (item) =>
        item.name === query || item.qualifiedName === query || item.symbolKey === query || item.symbolId === query,
    )) {
      add(symbolResult(symbol, input.repositoryId, current.repositoryRevisionId, current.indexVersionId), "exact", 1);
    }
    for (const chunk of snapshot.chunks.filter(
      (item) => item.relativePath === query || item.chunkKey === query || item.chunkId === query,
    )) {
      add(
        chunkResult(chunk, input.repositoryId, current.repositoryRevisionId, current.indexVersionId, true),
        "exact",
        1,
      );
    }

    const [lexicalRecords] = await this.database.query<[LexicalChunkRecord[]]>(
      "SELECT chunk_id, chunk_key, relative_path, symbol_key, start_byte, end_byte, start_line, end_line, content, content_hash, search::score(0) AS score FROM evidence_chunk WHERE organization_id = $organization_id AND repository_id = $repository_id AND index_version_id = $index_version_id AND content @0@ $query ORDER BY score DESC LIMIT $limit;",
      {
        organization_id: context.organizationId,
        repository_id: input.repositoryId,
        index_version_id: current.indexVersionId,
        query,
        limit: input.limit,
      },
    );
    lexicalRecords.forEach((record, position) => {
      add(
        chunkResult(record, input.repositoryId, current.repositoryRevisionId, current.indexVersionId, false),
        "lexical",
        1 / (60 + position + 1),
      );
    });

    let searchMode: CodeSearchResponse["searchMode"] = "lexical";
    let embeddingStatus: CodeSearchResponse["embeddingStatus"] = current.embeddingStatus;
    if (current.embeddingStatus === "complete" && current.embeddingVersion && this.embeddings) {
      try {
        const embedded = await this.embeddings.search({
          organizationId: context.organizationId,
          repositoryId: input.repositoryId,
          indexVersionId: current.indexVersionId,
          embeddingVersion: current.embeddingVersion,
          query,
          limit: input.limit,
        });
        const chunkById = new Map(snapshot.chunks.map((chunk) => [chunk.chunkId, chunk]));
        if (
          embedded.some(
            (item) =>
              item.indexVersionId !== current.indexVersionId ||
              item.embeddingVersion !== current.embeddingVersion ||
              !chunkById.has(item.chunkId) ||
              !Number.isFinite(item.score),
          )
        ) {
          searchMode = "lexical_fallback";
          embeddingStatus = "version_mismatch";
        } else {
          [...embedded]
            .sort((left, right) => right.score - left.score || left.chunkId.localeCompare(right.chunkId))
            .forEach((item, position) => {
              const chunk = chunkById.get(item.chunkId);
              if (chunk)
                add(
                  chunkResult(chunk, input.repositoryId, current.repositoryRevisionId, current.indexVersionId, false),
                  "embedding",
                  1 / (60 + position + 1),
                );
            });
          searchMode = "hybrid";
          embeddingStatus = "complete";
        }
      } catch {
        searchMode = "lexical_fallback";
        embeddingStatus = "provider_error";
      }
    } else if (current.embeddingStatus !== "complete" || !this.embeddings) {
      searchMode = current.embeddingStatus === "unavailable" ? "lexical" : "lexical_fallback";
      if (current.embeddingStatus === "complete") embeddingStatus = "unavailable";
    }

    const results = [...candidates.values()]
      .sort(
        (left, right) =>
          Number(right.result.exact) - Number(left.result.exact) ||
          right.score - left.score ||
          left.result.relativePath.localeCompare(right.result.relativePath) ||
          left.result.startByte - right.result.startByte,
      )
      .slice(0, input.limit)
      .map((candidate, position): CodeSearchResult => ({
        ...candidate.result,
        matchModes: [...candidate.modes].sort(),
        rank: position + 1,
      }));
    const response: CodeSearchResponse = {
      repositoryId: input.repositoryId,
      repositoryRevisionId: current.repositoryRevisionId,
      indexVersionId: current.indexVersionId,
      searchMode,
      embeddingStatus,
      results,
    };
    await this.metrics?.recordSearch(context, searchMode).catch(() => undefined);
    return response;
  }
}
