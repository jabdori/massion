import { createHash } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import type { ParsedChunk, ParsedRelation, ParsedSymbol } from "./extractors.js";
import { normalizeRepositoryPath } from "./path.js";
import type { ParsedFileEvidence } from "./parser.js";
import { EVIDENCE_CONTENT_MIGRATION, EVIDENCE_INDEX_MIGRATION } from "./schema.js";

interface IndexRecord {
  readonly index_version_id: string;
  readonly organization_id: string;
  readonly repository_id: string;
  readonly status: string;
}

interface FileRecord {
  readonly source_file_id: string;
  readonly source_file_key: string;
  readonly organization_id: string;
  readonly repository_id: string;
  readonly index_version_id: string;
  readonly relative_path: string;
  readonly language: string;
  readonly size: number;
  readonly content_hash: string;
  readonly status: ParsedFileEvidence["status"];
  readonly parser_kind: ParsedFileEvidence["parserKind"];
  readonly grammar_version: string;
  readonly parse_error_count: number;
}

interface SymbolRecord {
  readonly symbol_id: string;
  readonly symbol_key: string;
  readonly source_file_id: string;
  readonly relative_path: string;
  readonly name: string;
  readonly qualified_name: string;
  readonly kind: ParsedSymbol["kind"];
  readonly start_byte: number;
  readonly end_byte: number;
  readonly start_line: number;
  readonly end_line: number;
  readonly content_hash: string;
}

interface ChunkRecord {
  readonly chunk_id: string;
  readonly chunk_key: string;
  readonly source_file_id: string;
  readonly relative_path: string;
  readonly symbol_key?: string;
  readonly start_byte: number;
  readonly end_byte: number;
  readonly start_line: number;
  readonly end_line: number;
  readonly content: string;
  readonly content_hash: string;
  readonly language: string;
}

interface RelationRecord {
  readonly relation_id: string;
  readonly relation_key: string;
  readonly source_file_id: string;
  readonly relative_path: string;
  readonly kind: ParsedRelation["kind"];
  readonly source_symbol_key?: string;
  readonly target_symbol_key?: string;
  readonly target_text: string;
  readonly resolved: boolean;
  readonly start_line: number;
}

export interface IndexedSourceFile {
  readonly sourceFileId: string;
  readonly sourceFileKey: string;
  readonly relativePath: string;
  readonly language: string;
  readonly size: number;
  readonly contentHash: string;
  readonly status: ParsedFileEvidence["status"];
  readonly parserKind: ParsedFileEvidence["parserKind"];
  readonly grammarVersion: string;
  readonly parseErrorCount: number;
}

export interface IndexedSymbol extends ParsedSymbol {
  readonly symbolId: string;
  readonly sourceFileId: string;
  readonly relativePath: string;
}

export interface IndexedChunk extends ParsedChunk {
  readonly chunkId: string;
  readonly sourceFileId: string;
  readonly relativePath: string;
  readonly language: string;
}

export interface IndexedRelation extends ParsedRelation {
  readonly relationId: string;
  readonly relationKey: string;
  readonly sourceFileId: string;
  readonly relativePath: string;
}

export interface IndexSnapshot {
  readonly indexVersionId: string;
  readonly files: readonly IndexedSourceFile[];
  readonly symbols: readonly IndexedSymbol[];
  readonly chunks: readonly IndexedChunk[];
  readonly relations: readonly IndexedRelation[];
  readonly checksum: string;
}

export interface StageFileInput {
  readonly indexVersionId: string;
  readonly relativePath: string;
  readonly language: string;
  readonly size: number;
  readonly contentHash: string;
  readonly evidence: ParsedFileEvidence;
  readonly sourceFileKey?: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

function omitKeys(value: object, keys: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.has(key)));
}

const FILE_SNAPSHOT_OMISSIONS = new Set(["sourceFileId"]);
const CHILD_SNAPSHOT_OMISSIONS = new Set(["symbolId", "chunkId", "relationId", "sourceFileId"]);

function sourceFileView(record: FileRecord): IndexedSourceFile {
  return {
    sourceFileId: record.source_file_id,
    sourceFileKey: record.source_file_key,
    relativePath: record.relative_path,
    language: record.language,
    size: record.size,
    contentHash: record.content_hash,
    status: record.status,
    parserKind: record.parser_kind,
    grammarVersion: record.grammar_version,
    parseErrorCount: record.parse_error_count,
  };
}

function symbolView(record: SymbolRecord): IndexedSymbol {
  return {
    symbolId: record.symbol_id,
    symbolKey: record.symbol_key,
    sourceFileId: record.source_file_id,
    relativePath: record.relative_path,
    name: record.name,
    qualifiedName: record.qualified_name,
    kind: record.kind,
    startByte: record.start_byte,
    endByte: record.end_byte,
    startLine: record.start_line,
    endLine: record.end_line,
    contentHash: record.content_hash,
  };
}

function chunkView(record: ChunkRecord): IndexedChunk {
  return {
    chunkId: record.chunk_id,
    chunkKey: record.chunk_key,
    sourceFileId: record.source_file_id,
    relativePath: record.relative_path,
    ...(record.symbol_key ? { symbolKey: record.symbol_key } : {}),
    startByte: record.start_byte,
    endByte: record.end_byte,
    startLine: record.start_line,
    endLine: record.end_line,
    content: record.content,
    contentHash: record.content_hash,
    language: record.language,
  };
}

function relationView(record: RelationRecord): IndexedRelation {
  return {
    relationId: record.relation_id,
    relationKey: record.relation_key,
    sourceFileId: record.source_file_id,
    relativePath: record.relative_path,
    kind: record.kind,
    ...(record.source_symbol_key ? { sourceSymbolKey: record.source_symbol_key } : {}),
    ...(record.target_symbol_key ? { targetSymbolKey: record.target_symbol_key } : {}),
    targetText: record.target_text,
    resolved: record.resolved,
    startLine: record.start_line,
  };
}

export class IndexStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(database: MassionDatabase, organizations: OrganizationService): Promise<IndexStore> {
    await applyMigrations(database, [EVIDENCE_INDEX_MIGRATION, EVIDENCE_CONTENT_MIGRATION]);
    return new IndexStore(database, organizations);
  }

  public async stageFile(context: TenantContext, input: StageFileInput): Promise<IndexedSourceFile> {
    await this.organizations.verifyTenantContext(context);
    if (normalizeRepositoryPath(input.relativePath) !== input.relativePath)
      throw new Error("Index file에는 정규화된 상대 경로가 필요합니다");
    if (!/^[a-f0-9]{64}$/u.test(input.contentHash)) throw new Error("Index content hash는 SHA-256이어야 합니다");
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const target = await this.findIndex(tx, context.organizationId, input.indexVersionId);
      if (target.status !== "building") throw new Error("building IndexVersion에만 evidence를 쓸 수 있습니다");
      const [existing] = await tx.query<[FileRecord[]]>(
        "SELECT * OMIT id FROM source_file WHERE organization_id = $organization_id AND index_version_id = $index_version_id AND relative_path = $relative_path LIMIT 1;",
        {
          organization_id: context.organizationId,
          index_version_id: input.indexVersionId,
          relative_path: input.relativePath,
        },
      );
      if (existing[0]) {
        if (existing[0].content_hash !== input.contentHash)
          throw new Error("같은 index path에 다른 content를 쓸 수 없습니다");
        return sourceFileView(existing[0]);
      }
      const sourceFileId = sha256(`${target.repository_id}\0${input.indexVersionId}\0${input.relativePath}`);
      const sourceFileKey = input.sourceFileKey ?? sha256(`${input.relativePath}\0${input.contentHash}`);
      const [created] = await tx.query<[FileRecord[]]>(
        "CREATE source_file CONTENT { source_file_id: $source_file_id, source_file_key: $source_file_key, organization_id: $organization_id, repository_id: $repository_id, index_version_id: $index_version_id, relative_path: $relative_path, language: $language, size: $size, content_hash: $content_hash, status: $status, parser_kind: $parser_kind, grammar_version: $grammar_version, parse_error_count: $parse_error_count, created_at: time::now() } RETURN AFTER;",
        {
          source_file_id: sourceFileId,
          source_file_key: sourceFileKey,
          organization_id: context.organizationId,
          repository_id: target.repository_id,
          index_version_id: input.indexVersionId,
          relative_path: input.relativePath,
          language: input.language,
          size: input.size,
          content_hash: input.contentHash,
          status: input.evidence.status,
          parser_kind: input.evidence.parserKind,
          grammar_version: input.evidence.grammarVersion,
          parse_error_count: input.evidence.parseErrorCount,
        },
      );
      if (!created[0]) throw new Error("SourceFile 생성 결과가 없습니다");
      for (const symbol of input.evidence.symbols) {
        await tx.query(
          "CREATE evidence_symbol CONTENT { symbol_id: $symbol_id, symbol_key: $symbol_key, organization_id: $organization_id, repository_id: $repository_id, index_version_id: $index_version_id, source_file_id: $source_file_id, relative_path: $relative_path, name: $name, qualified_name: $qualified_name, kind: $kind, start_byte: $start_byte, end_byte: $end_byte, start_line: $start_line, end_line: $end_line, content_hash: $content_hash, created_at: time::now() };",
          {
            symbol_id: sha256(`${target.repository_id}\0${input.indexVersionId}\0${symbol.symbolKey}`),
            symbol_key: symbol.symbolKey,
            organization_id: context.organizationId,
            repository_id: target.repository_id,
            index_version_id: input.indexVersionId,
            source_file_id: sourceFileId,
            relative_path: input.relativePath,
            name: symbol.name,
            qualified_name: symbol.qualifiedName,
            kind: symbol.kind,
            start_byte: symbol.startByte,
            end_byte: symbol.endByte,
            start_line: symbol.startLine,
            end_line: symbol.endLine,
            content_hash: symbol.contentHash,
          },
        );
      }
      for (const chunk of input.evidence.chunks) {
        await tx.query(
          "CREATE evidence_chunk CONTENT { chunk_id: $chunk_id, chunk_key: $chunk_key, organization_id: $organization_id, repository_id: $repository_id, index_version_id: $index_version_id, source_file_id: $source_file_id, relative_path: $relative_path, symbol_key: $symbol_key, start_byte: $start_byte, end_byte: $end_byte, start_line: $start_line, end_line: $end_line, content: $content, content_hash: $content_hash, language: $language, created_at: time::now() };",
          {
            chunk_id: sha256(`${target.repository_id}\0${input.indexVersionId}\0${chunk.chunkKey}`),
            chunk_key: chunk.chunkKey,
            organization_id: context.organizationId,
            repository_id: target.repository_id,
            index_version_id: input.indexVersionId,
            source_file_id: sourceFileId,
            relative_path: input.relativePath,
            symbol_key: chunk.symbolKey,
            start_byte: chunk.startByte,
            end_byte: chunk.endByte,
            start_line: chunk.startLine,
            end_line: chunk.endLine,
            content: chunk.content,
            content_hash: chunk.contentHash,
            language: input.language,
          },
        );
      }
      for (const relation of input.evidence.relations) {
        const relationKey = sha256(
          `${input.relativePath}\0${relation.kind}\0${relation.sourceSymbolKey ?? ""}\0${relation.targetText}\0${String(relation.startLine)}`,
        );
        await tx.query(
          "CREATE evidence_relation CONTENT { relation_id: $relation_id, relation_key: $relation_key, organization_id: $organization_id, repository_id: $repository_id, index_version_id: $index_version_id, source_file_id: $source_file_id, relative_path: $relative_path, kind: $kind, source_symbol_key: $source_symbol_key, target_symbol_key: $target_symbol_key, target_text: $target_text, resolved: $resolved, start_line: $start_line, created_at: time::now() };",
          {
            relation_id: sha256(`${target.repository_id}\0${input.indexVersionId}\0${relationKey}`),
            relation_key: relationKey,
            organization_id: context.organizationId,
            repository_id: target.repository_id,
            index_version_id: input.indexVersionId,
            source_file_id: sourceFileId,
            relative_path: input.relativePath,
            kind: relation.kind,
            source_symbol_key: relation.sourceSymbolKey,
            target_symbol_key: relation.targetSymbolKey,
            target_text: relation.targetText,
            resolved: relation.resolved,
            start_line: relation.startLine,
          },
        );
      }
      return sourceFileView(created[0]);
    });
  }

  public async cloneFile(
    context: TenantContext,
    sourceIndexVersionId: string,
    targetIndexVersionId: string,
    relativePath: string,
  ): Promise<IndexedSourceFile> {
    const source = await this.getSnapshot(context, sourceIndexVersionId);
    const file = source.files.find((item) => item.relativePath === relativePath);
    if (!file) throw new Error(`복제할 SourceFile을 찾을 수 없습니다: ${relativePath}`);
    return await this.stageFile(context, {
      indexVersionId: targetIndexVersionId,
      relativePath,
      language: file.language,
      size: file.size,
      contentHash: file.contentHash,
      sourceFileKey: file.sourceFileKey,
      evidence: {
        parserKind: file.parserKind,
        grammarVersion: file.grammarVersion,
        status: file.status,
        parseErrorCount: file.parseErrorCount,
        symbols: source.symbols.filter((item) => item.sourceFileId === file.sourceFileId),
        chunks: source.chunks.filter((item) => item.sourceFileId === file.sourceFileId),
        relations: source.relations.filter((item) => item.sourceFileId === file.sourceFileId),
      },
    });
  }

  public async getSnapshot(context: TenantContext, indexVersionId: string): Promise<IndexSnapshot> {
    await this.organizations.verifyTenantContext(context);
    await this.findIndex(this.database, context.organizationId, indexVersionId);
    const bindings = { organization_id: context.organizationId, index_version_id: indexVersionId };
    const [[files], [symbols], [chunks], [relations]] = await Promise.all([
      this.database.query<[FileRecord[]]>(
        "SELECT * OMIT id FROM source_file WHERE organization_id = $organization_id AND index_version_id = $index_version_id ORDER BY relative_path ASC;",
        bindings,
      ),
      this.database.query<[SymbolRecord[]]>(
        "SELECT * OMIT id FROM evidence_symbol WHERE organization_id = $organization_id AND index_version_id = $index_version_id ORDER BY relative_path ASC, start_byte ASC, symbol_key ASC;",
        bindings,
      ),
      this.database.query<[ChunkRecord[]]>(
        "SELECT * OMIT id FROM evidence_chunk WHERE organization_id = $organization_id AND index_version_id = $index_version_id ORDER BY relative_path ASC, start_byte ASC, chunk_key ASC;",
        bindings,
      ),
      this.database.query<[RelationRecord[]]>(
        "SELECT * OMIT id FROM evidence_relation WHERE organization_id = $organization_id AND index_version_id = $index_version_id ORDER BY relative_path ASC, start_line ASC, relation_key ASC;",
        bindings,
      ),
    ]);
    const snapshot = {
      files: files.map(sourceFileView),
      symbols: symbols.map(symbolView),
      chunks: chunks.map(chunkView),
      relations: relations.map(relationView),
    };
    const checksum = sha256(
      canonicalJson({
        files: snapshot.files.map((item) => omitKeys(item, FILE_SNAPSHOT_OMISSIONS)),
        symbols: snapshot.symbols.map((item) => omitKeys(item, CHILD_SNAPSHOT_OMISSIONS)),
        chunks: snapshot.chunks.map((item) => omitKeys(item, CHILD_SNAPSHOT_OMISSIONS)),
        relations: snapshot.relations.map((item) => omitKeys(item, CHILD_SNAPSHOT_OMISSIONS)),
      }),
    );
    return { indexVersionId, ...snapshot, checksum };
  }

  private async findIndex(
    executor: QueryExecutor,
    organizationId: string,
    indexVersionId: string,
  ): Promise<IndexRecord> {
    const [records] = await executor.query<[IndexRecord[]]>(
      "SELECT index_version_id, organization_id, repository_id, status FROM index_version WHERE organization_id = $organization_id AND index_version_id = $index_version_id LIMIT 1;",
      { organization_id: organizationId, index_version_id: indexVersionId },
    );
    if (!records[0]) throw new Error(`IndexVersion을 찾을 수 없습니다: ${indexVersionId}`);
    return records[0];
  }
}
