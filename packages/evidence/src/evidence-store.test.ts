import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import {
  EvidenceBriefStore,
  ExternalResearchStore,
  IndexStore,
  RepositoryStore,
  type CodeSearchResult,
  type EvidenceSynthesisPort,
} from "./index.js";

describe("immutable EvidenceBrief", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let repositories: RepositoryStore;
  let indexes: IndexStore;
  let fixture: Awaited<ReturnType<typeof createFixture>>;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "brief@example.com", displayName: "Brief" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    repositories = await RepositoryStore.create(database, organizations);
    indexes = await IndexStore.create(database, organizations);
    fixture = await createFixture();
  });

  afterEach(async () => database.close());

  async function createFixture() {
    const repository = (
      await repositories.register(context, {
        commandId: crypto.randomUUID(),
        name: "brief-fixture",
        providerKind: "filesystem",
        rootRef: "/workspace/brief",
        rootRealPathHash: "a".repeat(64),
      })
    ).repository;
    const revision = (
      await repositories.captureRevision(context, {
        commandId: crypto.randomUUID(),
        repositoryId: repository.repositoryId,
        providerRevision: "snapshot:brief",
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
    const index = (
      await repositories.startIndex(context, {
        commandId: crypto.randomUUID(),
        repositoryId: repository.repositoryId,
        repositoryRevisionId: revision.repositoryRevisionId,
        configurationId: configuration.configurationId,
        mode: "full",
      })
    ).index;
    await indexes.stageFile(context, {
      indexVersionId: index.indexVersionId,
      relativePath: "service.ts",
      language: "typescript",
      size: 30,
      contentHash: "d".repeat(64),
      evidence: {
        parserKind: "tree-sitter",
        grammarVersion: "test-v1",
        status: "complete",
        parseErrorCount: 0,
        symbols: [
          {
            symbolKey: "symbol-key",
            name: "Service",
            qualifiedName: "Service",
            kind: "class",
            startByte: 0,
            endByte: 30,
            startLine: 1,
            endLine: 2,
            contentHash: "d".repeat(64),
          },
        ],
        chunks: [
          {
            chunkKey: "chunk-key",
            symbolKey: "symbol-key",
            startByte: 0,
            endByte: 30,
            startLine: 1,
            endLine: 2,
            content: "export class Service {}",
            contentHash: "e".repeat(64),
          },
        ],
        relations: [],
      },
    });
    const snapshot = await indexes.getSnapshot(context, index.indexVersionId);
    const completed = (
      await repositories.completeIndex(context, {
        commandId: crypto.randomUUID(),
        indexVersionId: index.indexVersionId,
        counts: { files: 1, symbols: 1, relations: 0, chunks: 1 },
        snapshotChecksum: snapshot.checksum,
      })
    ).index;
    const chunk = snapshot.chunks[0];
    if (!chunk) throw new Error("fixture chunk가 없습니다");
    const result: CodeSearchResult = {
      referenceId: chunk.chunkId,
      kind: "chunk",
      repositoryId: repository.repositoryId,
      repositoryRevisionId: revision.repositoryRevisionId,
      indexVersionId: completed.indexVersionId,
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
    return { repository, revision, configuration, index: completed, result };
  }

  it("모델이 없으면 새 claim 없이 검증된 reference만 deterministic brief로 저장하고 command를 멱등 재생한다", async () => {
    const store = await EvidenceBriefStore.create(database, repositories, indexes);
    const commandId = crypto.randomUUID();
    const input = {
      commandId,
      workId: "work-1",
      repositoryId: fixture.repository.repositoryId,
      indexVersionId: fixture.index.indexVersionId,
      query: "Service 구현 근거",
      references: [{ kind: "code" as const, result: fixture.result }],
    };
    const first = await store.createBrief(context, input);
    const repeated = await store.createBrief(context, input);

    expect(first.brief).toMatchObject({ status: "ready", claims: [], references: [{ kind: "code" }] });
    expect(repeated.brief.evidenceBriefId).toBe(first.brief.evidenceBriefId);
    expect((await store.getBrief(context, first.brief.evidenceBriefId)).checksum).toBe(first.brief.checksum);
    const [events] = await database.query<[{ payload_json: string }[]]>(
      "SELECT payload_json FROM evidence_brief_event WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );
    expect(JSON.stringify(events)).not.toContain("Service 구현 근거");
    expect(JSON.stringify(events)).not.toContain("service.ts");
  });

  it("citation 없는 claim, 제공되지 않은 reference, 다른 index와 존재하지 않거나 checksum이 다른 근거를 거부한다", async () => {
    const noCitation: EvidenceSynthesisPort = {
      synthesize: async () => ({ claims: [{ text: "unsupported", referenceIds: [] }] }),
    };
    const unknownCitation: EvidenceSynthesisPort = {
      synthesize: async () => ({ claims: [{ text: "unknown", referenceIds: ["not-provided"] }] }),
    };
    const base = {
      workId: "work-1",
      repositoryId: fixture.repository.repositoryId,
      indexVersionId: fixture.index.indexVersionId,
      query: "integrity",
      references: [{ kind: "code" as const, result: fixture.result }],
    };
    await expect(
      (await EvidenceBriefStore.create(database, repositories, indexes, noCitation)).createBrief(context, {
        ...base,
        commandId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("citation");
    await expect(
      (await EvidenceBriefStore.create(database, repositories, indexes, unknownCitation)).createBrief(context, {
        ...base,
        commandId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("제공된 reference");
    const store = await EvidenceBriefStore.create(database, repositories, indexes);
    await expect(
      store.createBrief(context, {
        ...base,
        commandId: crypto.randomUUID(),
        references: [{ kind: "code", result: { ...fixture.result, indexVersionId: crypto.randomUUID() } }],
      }),
    ).rejects.toThrow("IndexVersion");
    await expect(
      store.createBrief(context, {
        ...base,
        commandId: crypto.randomUUID(),
        references: [{ kind: "code", result: { ...fixture.result, referenceId: "missing" } }],
      }),
    ).rejects.toThrow("찾을 수 없습니다");
    await expect(
      store.createBrief(context, {
        ...base,
        commandId: crypto.randomUUID(),
        references: [{ kind: "code", result: { ...fixture.result, contentHash: "f".repeat(64) } }],
      }),
    ).rejects.toThrow("checksum");
  });

  it("저장 뒤 checksum이 변조된 brief 조회를 거부한다", async () => {
    const store = await EvidenceBriefStore.create(database, repositories, indexes);
    const created = await store.createBrief(context, {
      commandId: crypto.randomUUID(),
      workId: "work-1",
      repositoryId: fixture.repository.repositoryId,
      indexVersionId: fixture.index.indexVersionId,
      query: "tamper",
      references: [{ kind: "code", result: fixture.result }],
    });
    await database.query(
      "UPDATE evidence_brief SET checksum = $checksum WHERE organization_id = $organization_id AND evidence_brief_id = $evidence_brief_id;",
      {
        checksum: "0".repeat(64),
        organization_id: context.organizationId,
        evidence_brief_id: created.brief.evidenceBriefId,
      },
    );
    await expect(store.getBrief(context, created.brief.evidenceBriefId)).rejects.toThrow("checksum");
  });

  it("저장된 external snapshot만 reference로 허용하고 content checksum을 다시 검증한다", async () => {
    const content = "verified external snapshot";
    const contentHash = createHash("sha256").update(content).digest("hex");
    const research = await ExternalResearchStore.create(database, {
      fetch: async () => ({
        canonicalUrl: "https://example.com/source",
        providerKind: "test",
        fetchedAt: "2026-07-10T00:00:00.000Z",
        mediaType: "text/plain",
        contentHash,
        content,
      }),
    });
    const source = (
      await research.capture(context, { commandId: crypto.randomUUID(), url: "https://example.com/source" })
    ).source;
    const store = await EvidenceBriefStore.create(database, repositories, indexes);
    const brief = await store.createBrief(context, {
      commandId: crypto.randomUUID(),
      workId: "work-1",
      repositoryId: fixture.repository.repositoryId,
      indexVersionId: fixture.index.indexVersionId,
      query: "external evidence",
      references: [{ kind: "external", externalSourceId: source.externalSourceId, contentHash }],
    });
    expect(brief.brief.references).toEqual([
      expect.objectContaining({ kind: "external", externalSourceId: source.externalSourceId, contentHash }),
    ]);
    await expect(
      store.createBrief(context, {
        commandId: crypto.randomUUID(),
        workId: "work-1",
        repositoryId: fixture.repository.repositoryId,
        indexVersionId: fixture.index.indexVersionId,
        query: "tampered external evidence",
        references: [{ kind: "external", externalSourceId: source.externalSourceId, contentHash: "0".repeat(64) }],
      }),
    ).rejects.toThrow("checksum");
  });
});
