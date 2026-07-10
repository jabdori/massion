import { createHash } from "node:crypto";

import type { TenantContext } from "@massion/identity";

import type { IndexMode, IndexVersion } from "./contracts.js";
import type { IndexStore } from "./index-store.js";
import type { ParseEvidenceInput, ParsedFileEvidence } from "./parser.js";
import type { RepositoryStore } from "./repository-store.js";
import type { RepositoryScanner, ScanOptions } from "./scanner.js";

export interface EvidenceParserPort {
  parse(input: ParseEvidenceInput): Promise<ParsedFileEvidence>;
}

export interface EvidenceIndexerHooks {
  readonly afterStagedFile?: (input: { readonly relativePath: string; readonly indexVersionId: string }) => void;
}

export interface IndexRepositoryInput {
  readonly commandId: string;
  readonly repositoryId: string;
  readonly repositoryRevisionId: string;
  readonly configurationId: string;
  readonly mode: IndexMode;
  readonly parentIndexVersionId?: string;
  readonly root: string;
  readonly scanOptions: ScanOptions;
}

export interface IndexRepositoryResult {
  readonly index: IndexVersion;
  readonly stagedFiles: number;
  readonly reusedFiles: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class EvidenceIndexer {
  public constructor(
    private readonly repositories: RepositoryStore,
    private readonly indexes: IndexStore,
    private readonly scanner: RepositoryScanner,
    private readonly parser: EvidenceParserPort,
    private readonly hooks: EvidenceIndexerHooks = {},
  ) {}

  public async index(context: TenantContext, input: IndexRepositoryInput): Promise<IndexRepositoryResult> {
    if (!input.commandId.trim()) throw new Error("Index command ID가 필요합니다");
    if (input.mode === "full" && input.parentIndexVersionId)
      throw new Error("full index에는 parent IndexVersion을 지정할 수 없습니다");
    if (input.mode !== "full" && !input.parentIndexVersionId)
      throw new Error(`${input.mode} index에는 parent IndexVersion이 필요합니다`);

    const [repository, revision, configuration] = await Promise.all([
      this.repositories.getRepository(context, input.repositoryId),
      this.repositories.getRevision(context, input.repositoryRevisionId),
      this.repositories.getConfiguration(context, input.configurationId),
    ]);
    if (revision.repositoryId !== repository.repositoryId || configuration.repositoryId !== repository.repositoryId)
      throw new Error("Repository, revision과 configuration의 소유 관계가 일치하지 않습니다");
    const scan = await this.scanner.scan(input.root, input.scanOptions);
    if (scan.rootRealPathHash !== repository.rootRealPathHash || scan.rootRealPathHash !== revision.rootRealPathHash)
      throw new Error("Index 대상의 canonical root가 등록된 Repository와 다릅니다");
    if (scan.manifestChecksum !== revision.manifestChecksum)
      throw new Error("Index 대상 manifest가 RepositoryRevision과 다릅니다");

    const started = await this.repositories.startIndex(context, {
      commandId: input.commandId,
      repositoryId: input.repositoryId,
      repositoryRevisionId: input.repositoryRevisionId,
      configurationId: input.configurationId,
      mode: input.mode,
      ...(input.parentIndexVersionId ? { parentIndexVersionId: input.parentIndexVersionId } : {}),
    });
    if (started.index.status !== "building") {
      if (started.index.status === "complete" || started.index.status === "superseded")
        return { index: started.index, stagedFiles: 0, reusedFiles: 0 };
      throw new Error(`완료되지 않은 같은 index command를 재실행할 수 없습니다: ${started.index.status}`);
    }

    let stagedFiles = 0;
    let reusedFiles = 0;
    let parsing = false;
    try {
      const parent = input.parentIndexVersionId
        ? await this.indexes.getSnapshot(context, input.parentIndexVersionId)
        : undefined;
      const parentFiles = new Map(parent?.files.map((file) => [file.relativePath, file]) ?? []);
      for (const file of scan.files) {
        const previous = parentFiles.get(file.relativePath);
        if (previous?.contentHash === file.contentHash && input.parentIndexVersionId) {
          await this.indexes.cloneFile(
            context,
            input.parentIndexVersionId,
            started.index.indexVersionId,
            file.relativePath,
          );
          reusedFiles += 1;
        } else {
          parsing = true;
          const evidence = await this.parser.parse({
            relativePath: file.relativePath,
            language: file.language,
            content: file.content,
            contentHash: file.contentHash,
          });
          parsing = false;
          await this.indexes.stageFile(context, {
            indexVersionId: started.index.indexVersionId,
            relativePath: file.relativePath,
            language: file.language,
            size: file.size,
            contentHash: file.contentHash,
            evidence,
          });
          stagedFiles += 1;
        }
        this.hooks.afterStagedFile?.({
          relativePath: file.relativePath,
          indexVersionId: started.index.indexVersionId,
        });
      }
      const snapshot = await this.indexes.getSnapshot(context, started.index.indexVersionId);
      if (snapshot.files.length !== scan.files.length)
        throw new Error(
          `Index file count drift: expected ${String(scan.files.length)}, actual ${String(snapshot.files.length)}`,
        );
      const completed = await this.repositories.completeIndex(context, {
        commandId: `${input.commandId}:complete`,
        indexVersionId: started.index.indexVersionId,
        counts: {
          files: snapshot.files.length,
          symbols: snapshot.symbols.length,
          relations: snapshot.relations.length,
          chunks: snapshot.chunks.length,
        },
        snapshotChecksum: snapshot.checksum,
      });
      return { index: completed.index, stagedFiles, reusedFiles };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.repositories
        .failIndex(context, {
          commandId: `${input.commandId}:failure`,
          indexVersionId: started.index.indexVersionId,
          status: parsing ? "partial" : "failed",
          error: { category: parsing ? "parser" : "indexer", causeId: sha256(message) },
        })
        .catch(() => undefined);
      throw error;
    }
  }
}
