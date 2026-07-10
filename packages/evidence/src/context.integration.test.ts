import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContextStore } from "@massion/context-strategy";
import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import {
  EvidenceBlockedError,
  EvidenceBriefStore,
  EvidenceContextBinder,
  EvidenceFreshnessService,
  EvidenceReindexRequiredError,
  IndexStore,
  RepositoryStore,
  type CodeSearchResult,
  type RepositoryIndexCommand,
  type RepositoryIndexCommandQueue,
} from "./index.js";

class MemoryQueue implements RepositoryIndexCommandQueue {
  public readonly commands = new Map<string, RepositoryIndexCommand>();

  public async enqueue(_context: TenantContext, command: RepositoryIndexCommand): Promise<boolean> {
    if (this.commands.has(command.commandId)) return false;
    this.commands.set(command.commandId, command);
    return true;
  }
}

describe("EvidenceBrief와 Phase 9 Context 통합", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let otherContext: TenantContext;
  let organizations: OrganizationService;
  let repositories: RepositoryStore;
  let indexes: IndexStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "evidence-context@example.com", displayName: "Owner" });
    const other = await identity.registerPersonalUser({
      email: "evidence-context-other@example.com",
      displayName: "Other",
    });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    otherContext = await organizations.resolveTenantContext(other.user.user_id, other.organization.organization_id);
    repositories = await RepositoryStore.create(database, organizations);
    indexes = await IndexStore.create(database, organizations);
  });

  afterEach(async () => database.close());

  it("brief 본문을 복제하지 않고 ID·revision·checksum만 Context에 연결하며 stale 정책과 tenant를 강제한다", async () => {
    const repository = (
      await repositories.register(context, {
        commandId: crypto.randomUUID(),
        name: "context-fixture",
        providerKind: "filesystem",
        rootRef: "/workspace/context-fixture",
        rootRealPathHash: "a".repeat(64),
      })
    ).repository;
    const revision = (
      await repositories.captureRevision(context, {
        commandId: crypto.randomUUID(),
        repositoryId: repository.repositoryId,
        providerRevision: "snapshot:one",
        dirty: false,
        manifestChecksum: "b".repeat(64),
        rootRealPathHash: "a".repeat(64),
        collectorVersion: "test-v1",
      })
    ).revision;
    const configuration = (
      await repositories.createConfiguration(context, {
        commandId: crypto.randomUUID(),
        repositoryId: repository.repositoryId,
        checksum: "c".repeat(64),
        parserBundleVersion: "parser-v1",
        schemaVersion: "evidence-v1",
        embeddingStatus: "unavailable",
        settings: {},
      })
    ).configuration;
    const started = (
      await repositories.startIndex(context, {
        commandId: crypto.randomUUID(),
        repositoryId: repository.repositoryId,
        repositoryRevisionId: revision.repositoryRevisionId,
        configurationId: configuration.configurationId,
        mode: "full",
      })
    ).index;
    await indexes.stageFile(context, {
      indexVersionId: started.indexVersionId,
      relativePath: "evidence.ts",
      language: "typescript",
      size: 20,
      contentHash: "d".repeat(64),
      evidence: {
        parserKind: "tree-sitter",
        grammarVersion: "test-v1",
        status: "complete",
        parseErrorCount: 0,
        symbols: [],
        relations: [],
        chunks: [
          {
            chunkKey: "chunk",
            startByte: 0,
            endByte: 20,
            startLine: 1,
            endLine: 1,
            content: "secret brief content",
            contentHash: "e".repeat(64),
          },
        ],
      },
    });
    const snapshot = await indexes.getSnapshot(context, started.indexVersionId);
    const current = (
      await repositories.completeIndex(context, {
        commandId: crypto.randomUUID(),
        indexVersionId: started.indexVersionId,
        counts: { files: 1, symbols: 0, relations: 0, chunks: 1 },
        snapshotChecksum: snapshot.checksum,
      })
    ).index;
    const chunk = snapshot.chunks[0];
    if (!chunk) throw new Error("integration chunk가 없습니다");
    const result: CodeSearchResult = {
      referenceId: chunk.chunkId,
      kind: "chunk",
      repositoryId: repository.repositoryId,
      repositoryRevisionId: revision.repositoryRevisionId,
      indexVersionId: current.indexVersionId,
      relativePath: chunk.relativePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      startByte: chunk.startByte,
      endByte: chunk.endByte,
      contentHash: chunk.contentHash,
      content: chunk.content,
      exact: false,
      matchModes: ["lexical"],
      rank: 1,
    };
    const briefs = await EvidenceBriefStore.create(database, repositories, indexes);
    const brief = (
      await briefs.createBrief(context, {
        commandId: crypto.randomUUID(),
        workId: "work-1",
        repositoryId: repository.repositoryId,
        indexVersionId: current.indexVersionId,
        query: "private evidence query",
        references: [{ kind: "code", result }],
      })
    ).brief;
    const queue = new MemoryQueue();
    const freshness = new EvidenceFreshnessService(repositories, queue);
    const binder = new EvidenceContextBinder(briefs, freshness);
    const source = await binder.bind(context, { evidenceBriefId: brief.evidenceBriefId, policy: "warn" });
    expect(source).toMatchObject({
      kind: "evidence",
      sourceId: brief.evidenceBriefId,
      revision: current.indexVersionId,
      contentHash: brief.checksum,
      estimatedTokens: 0,
    });
    expect(source).not.toHaveProperty("content");

    const contexts = await ContextStore.create(database, organizations, {
      getWork: async (_tenant, workId) => ({
        work_id: workId,
        organization_id: context.organizationId,
        request_id: "request-1",
        project_id: "project-1",
        status: "running",
        revision: 1,
        organization_version_id: "organization-v1",
        artifact_version_ids: [],
        created_at: new Date(),
        updated_at: new Date(),
      }),
    });
    const created = await contexts.create(context, {
      commandId: crypto.randomUUID(),
      workId: "work-1",
      projectId: "project-1",
      tokenBudget: 100,
      objective: "Use verified evidence",
      scopeIn: ["evidence"],
      scopeOut: [],
      constraints: [],
      assumptions: [],
      unknowns: [],
      decisions: [],
      sources: [source],
    });
    expect(created.selectedSources[0]?.evidenceRef).toMatchObject({ evidenceBriefId: brief.evidenceBriefId });
    const [records] = await database.query<[{ package_json: string }[]]>(
      "SELECT package_json FROM context_version WHERE organization_id = $organization_id AND context_version_id = $context_version_id;",
      { organization_id: context.organizationId, context_version_id: created.contextVersionId },
    );
    expect(records[0]?.package_json).not.toContain("secret brief content");
    expect(records[0]?.package_json).not.toContain("private evidence query");
    await expect(binder.bind(otherContext, { evidenceBriefId: brief.evidenceBriefId })).rejects.toThrow(
      "EvidenceBrief를 찾을 수 없습니다",
    );

    await repositories.captureRevision(context, {
      commandId: crypto.randomUUID(),
      repositoryId: repository.repositoryId,
      providerRevision: "snapshot:two",
      dirty: false,
      manifestChecksum: "f".repeat(64),
      rootRealPathHash: "a".repeat(64),
      collectorVersion: "test-v1",
    });
    expect(
      (await binder.bind(context, { evidenceBriefId: brief.evidenceBriefId, policy: "warn" })).evidenceRef
        ?.freshnessStatus,
    ).toBe("stale_warning");
    await expect(
      binder.bind(context, { evidenceBriefId: brief.evidenceBriefId, policy: "reindex" }),
    ).rejects.toBeInstanceOf(EvidenceReindexRequiredError);
    await expect(
      binder.bind(context, { evidenceBriefId: brief.evidenceBriefId, policy: "block" }),
    ).rejects.toBeInstanceOf(EvidenceBlockedError);
  });
});
