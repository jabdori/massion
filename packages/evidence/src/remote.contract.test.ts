import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase } from "@massion/storage";

import {
  CodeSearchService,
  EvidenceBriefStore,
  EvidenceFreshnessService,
  EvidenceIndexRecovery,
  EvidenceIndexer,
  EvidenceParser,
  IndexStore,
  RepositoryScanner,
  RepositoryStore,
  type RepositoryIndexCommand,
  type RepositoryIndexCommandQueue,
} from "./index.js";

const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;
const OPTIONS = { include: ["**/*.ts"], exclude: [], maxFileBytes: 128 * 1_024 } as const;

class MemoryQueue implements RepositoryIndexCommandQueue {
  public readonly commands = new Map<string, RepositoryIndexCommand>();

  public async enqueue(_context: TenantContext, command: RepositoryIndexCommand): Promise<boolean> {
    if (this.commands.has(command.commandId)) return false;
    this.commands.set(command.commandId, command);
    return true;
  }
}

describe("remote Evidence intelligence contract", () => {
  remoteTest("SurrealDB 3에서 current 단일성·증분 snapshot·복구·stale·검색·tenant를 보존한다", async () => {
    const databaseName = `evidence_${crypto.randomUUID().replaceAll("-", "")}`;
    await using admin = await createDatabase({
      url: remoteUrl ?? "",
      namespace: "main",
      database: "main",
      authentication: { username: "root", password: "root" },
    });
    await admin.query(`DEFINE NAMESPACE IF NOT EXISTS massion; USE NS massion; DEFINE DATABASE ${databaseName};`);
    await using database = await createDatabase({
      url: remoteUrl ?? "",
      namespace: "massion",
      database: databaseName,
      authentication: { username: "root", password: "root" },
    });
    expect(await database.version()).toMatch(/^surrealdb-3\./u);
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "remote-evidence@example.com", displayName: "Owner" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const outsider = await identity.registerPersonalUser({
      email: "remote-evidence-other@example.com",
      displayName: "Other",
    });
    const otherContext = await organizations.resolveTenantContext(
      outsider.user.user_id,
      outsider.organization.organization_id,
    );
    const root = await mkdtemp(path.join(os.tmpdir(), "massion-remote-evidence-"));
    try {
      await writeFile(path.join(root, "service.ts"), "export function evidence() { return 'remote lexical proof'; }\n");
      const scanner = new RepositoryScanner();
      const initialScan = await scanner.scan(root, OPTIONS);
      const repositories = await RepositoryStore.create(database, organizations);
      const indexes = await IndexStore.create(database, organizations);
      const repository = (
        await repositories.register(context, {
          commandId: crypto.randomUUID(),
          name: "remote-evidence",
          providerKind: "filesystem",
          rootRef: root,
          rootRealPathHash: initialScan.rootRealPathHash,
        })
      ).repository;
      const revision1 = (
        await repositories.captureRevision(context, {
          commandId: crypto.randomUUID(),
          repositoryId: repository.repositoryId,
          providerRevision: `snapshot:${initialScan.manifestChecksum}`,
          dirty: false,
          manifestChecksum: initialScan.manifestChecksum,
          rootRealPathHash: initialScan.rootRealPathHash,
          collectorVersion: "remote-v1",
        })
      ).revision;
      const configuration = (
        await repositories.createConfiguration(context, {
          commandId: crypto.randomUUID(),
          repositoryId: repository.repositoryId,
          checksum: "a".repeat(64),
          parserBundleVersion: "vscode-tree-sitter-wasm-0.3.1",
          schemaVersion: "evidence-v1",
          embeddingStatus: "unavailable",
          settings: OPTIONS,
        })
      ).configuration;
      const indexer = new EvidenceIndexer(repositories, indexes, scanner, new EvidenceParser());
      const commandId = crypto.randomUUID();
      const request = {
        commandId,
        repositoryId: repository.repositoryId,
        repositoryRevisionId: revision1.repositoryRevisionId,
        configurationId: configuration.configurationId,
        mode: "full" as const,
        root,
        scanOptions: OPTIONS,
      };
      const [concurrent1, concurrent2] = await Promise.all([
        indexer.index(context, request),
        indexer.index(context, request),
      ]);
      expect(concurrent1.index.indexVersionId).toBe(concurrent2.index.indexVersionId);
      expect(await repositories.audit(context, repository.repositoryId)).toEqual([]);
      const search = await CodeSearchService.create(database, repositories, indexes);
      const found = await search.search(context, {
        repositoryId: repository.repositoryId,
        query: "remote lexical proof",
        limit: 10,
      });
      expect(found.results[0]).toMatchObject({
        relativePath: "service.ts",
        indexVersionId: concurrent1.index.indexVersionId,
      });
      const briefs = await EvidenceBriefStore.create(database, repositories, indexes);
      const reference = found.results[0];
      if (!reference) throw new Error("remote lexical reference가 없습니다");
      const brief = (
        await briefs.createBrief(context, {
          commandId: crypto.randomUUID(),
          workId: "remote-work",
          repositoryId: repository.repositoryId,
          indexVersionId: concurrent1.index.indexVersionId,
          query: "remote evidence",
          references: [{ kind: "code", result: reference }],
        })
      ).brief;

      await writeFile(
        path.join(root, "service.ts"),
        "export function evidence() { return 'remote lexical proof v2'; }\nexport const added = true;\n",
      );
      const changedScan = await scanner.scan(root, OPTIONS);
      const revision2 = (
        await repositories.captureRevision(context, {
          commandId: crypto.randomUUID(),
          repositoryId: repository.repositoryId,
          providerRevision: `snapshot:${changedScan.manifestChecksum}`,
          dirty: false,
          manifestChecksum: changedScan.manifestChecksum,
          rootRealPathHash: changedScan.rootRealPathHash,
          collectorVersion: "remote-v1",
        })
      ).revision;
      const interrupted = (
        await repositories.startIndex(context, {
          commandId: crypto.randomUUID(),
          repositoryId: repository.repositoryId,
          repositoryRevisionId: revision2.repositoryRevisionId,
          configurationId: configuration.configurationId,
          mode: "incremental",
          parentIndexVersionId: concurrent1.index.indexVersionId,
        })
      ).index;
      const queue = new MemoryQueue();
      const recovery = new EvidenceIndexRecovery(repositories, queue, { isStale: () => true });
      expect((await recovery.recover(context, repository.repositoryId)).recoveredIndexVersionIds).toEqual([
        interrupted.indexVersionId,
      ]);
      expect((await repositories.getCurrentIndex(context, repository.repositoryId))?.indexVersionId).toBe(
        concurrent1.index.indexVersionId,
      );
      const incremental = await indexer.index(context, {
        commandId: crypto.randomUUID(),
        repositoryId: repository.repositoryId,
        repositoryRevisionId: revision2.repositoryRevisionId,
        configurationId: configuration.configurationId,
        mode: "incremental",
        parentIndexVersionId: concurrent1.index.indexVersionId,
        root,
        scanOptions: OPTIONS,
      });
      expect((await indexes.getSnapshot(context, incremental.index.indexVersionId)).files).toHaveLength(1);
      expect(await repositories.audit(context, repository.repositoryId)).toEqual([]);
      expect(await new EvidenceFreshnessService(repositories, queue).assess(context, brief, "reindex")).toMatchObject({
        status: "reindex_required",
      });
      await expect(indexes.getSnapshot(otherContext, incremental.index.indexVersionId)).rejects.toThrow(
        "IndexVersion을 찾을 수 없습니다",
      );
      await expect(briefs.getBrief(otherContext, brief.evidenceBriefId)).rejects.toThrow(
        "EvidenceBrief를 찾을 수 없습니다",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
