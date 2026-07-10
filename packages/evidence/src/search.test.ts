import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import {
  CodeSearchService,
  EvidenceIndexer,
  EvidenceParser,
  IndexStore,
  RepositoryScanner,
  RepositoryStore,
  type EmbeddingSearchPort,
} from "./index.js";

const OPTIONS = { include: ["**/*"], exclude: [], maxFileBytes: 128 * 1_024 } as const;

describe("versioned code search", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let organizations: OrganizationService;
  let repositories: RepositoryStore;
  let indexes: IndexStore;
  let root: string;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "search@example.com", displayName: "Search" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    repositories = await RepositoryStore.create(database, organizations);
    indexes = await IndexStore.create(database, organizations);
    root = await mkdtemp(path.join(os.tmpdir(), "massion-search-"));
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { recursive: true, force: true });
  });

  async function indexed(embedding: "unavailable" | "complete" = "unavailable") {
    await writeFile(
      path.join(root, "service.ts"),
      "export class Service { durableOrchestration() { return reliableWorkflow(); } }\nfunction reliableWorkflow() { return 'durable evidence'; }\n",
    );
    await writeFile(path.join(root, "notes.md"), "# Operations\n\nRecovery preserves the current complete index.\n");
    const scanner = new RepositoryScanner();
    const scan = await scanner.scan(root, OPTIONS);
    const repository = (
      await repositories.register(context, {
        commandId: crypto.randomUUID(),
        name: "search-fixture",
        providerKind: "filesystem",
        rootRef: root,
        rootRealPathHash: scan.rootRealPathHash,
      })
    ).repository;
    const revision = (
      await repositories.captureRevision(context, {
        commandId: crypto.randomUUID(),
        repositoryId: repository.repositoryId,
        providerRevision: `snapshot:${scan.manifestChecksum}`,
        dirty: false,
        manifestChecksum: scan.manifestChecksum,
        rootRealPathHash: scan.rootRealPathHash,
        collectorVersion: "test-v1",
      })
    ).revision;
    const configuration = (
      await repositories.createConfiguration(context, {
        commandId: crypto.randomUUID(),
        repositoryId: repository.repositoryId,
        checksum: embedding === "complete" ? "e".repeat(64) : "f".repeat(64),
        parserBundleVersion: "parser-v1",
        schemaVersion: "evidence-v1",
        ...(embedding === "complete" ? { embeddingVersion: "embed-v1" } : {}),
        embeddingStatus: embedding,
        settings: OPTIONS,
      })
    ).configuration;
    const result = await new EvidenceIndexer(repositories, indexes, scanner, new EvidenceParser()).index(context, {
      commandId: crypto.randomUUID(),
      repositoryId: repository.repositoryId,
      repositoryRevisionId: revision.repositoryRevisionId,
      configurationId: configuration.configurationId,
      mode: "full",
      root,
      scanOptions: OPTIONS,
    });
    return { repository, revision, index: result.index };
  }

  it("exact path·symbol과 SurrealDB FULLTEXT 결과에 revision·version·hash·range를 고정한다", async () => {
    const prepared = await indexed();
    const search = await CodeSearchService.create(database, repositories, indexes);

    const pathResult = await search.search(context, {
      repositoryId: prepared.repository.repositoryId,
      query: "service.ts",
      limit: 10,
    });
    const symbolResult = await search.search(context, {
      repositoryId: prepared.repository.repositoryId,
      query: "Service.durableOrchestration",
      limit: 10,
    });
    const lexicalResult = await search.search(context, {
      repositoryId: prepared.repository.repositoryId,
      query: "durable evidence",
      limit: 10,
    });

    expect(pathResult.results.some((result) => result.relativePath === "service.ts")).toBe(true);
    expect(symbolResult.results[0]).toMatchObject({
      kind: "symbol",
      qualifiedName: "Service.durableOrchestration",
      exact: true,
    });
    expect(lexicalResult.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "chunk", relativePath: "service.ts" })]),
    );
    for (const result of [...pathResult.results, ...symbolResult.results, ...lexicalResult.results]) {
      expect(result.repositoryRevisionId).toBe(prepared.revision.repositoryRevisionId);
      expect(result.indexVersionId).toBe(prepared.index.indexVersionId);
      expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(result.startLine).toBeGreaterThan(0);
      expect(result.endLine).toBeGreaterThanOrEqual(result.startLine);
    }
    const [events] = await database.query<[{ payload_json: string }[]]>(
      "SELECT payload_json FROM evidence_index_event WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );
    expect(JSON.stringify(events)).not.toContain("durable evidence");
  });

  it("같은 embedding version 후보만 hybrid로 결합하고 unavailable·오류·version mismatch는 lexical로 강등한다", async () => {
    const prepared = await indexed("complete");
    const lexical = await CodeSearchService.create(database, repositories, indexes);
    const baseline = await lexical.search(context, {
      repositoryId: prepared.repository.repositoryId,
      query: "reliable workflow",
      limit: 10,
    });
    expect(baseline).toMatchObject({ searchMode: "lexical_fallback", embeddingStatus: "unavailable" });
    const chunk = baseline.results.find((result) => result.kind === "chunk");
    expect(chunk).toBeDefined();
    const calls: string[] = [];
    const embedding: EmbeddingSearchPort = {
      search: async (input) => {
        calls.push(input.indexVersionId);
        return [
          {
            chunkId: chunk?.referenceId ?? "missing",
            indexVersionId: input.indexVersionId,
            embeddingVersion: "embed-v1",
            score: 0.9,
          },
        ];
      },
    };
    const hybrid = await CodeSearchService.create(database, repositories, indexes, embedding);
    const hybridResult = await hybrid.search(context, {
      repositoryId: prepared.repository.repositoryId,
      query: "workflow",
      limit: 10,
    });
    expect(calls).toEqual([prepared.index.indexVersionId]);
    expect(hybridResult).toMatchObject({ searchMode: "hybrid", embeddingStatus: "complete" });
    expect(hybridResult.results.some((result) => result.matchModes.includes("embedding"))).toBe(true);

    const mismatched: EmbeddingSearchPort = {
      search: async () => [
        {
          chunkId: chunk?.referenceId ?? "missing",
          indexVersionId: "another-index",
          embeddingVersion: "embed-v2",
          score: 1,
        },
      ],
    };
    const fallback = await CodeSearchService.create(database, repositories, indexes, mismatched);
    const mismatchResult = await fallback.search(context, {
      repositoryId: prepared.repository.repositoryId,
      query: "workflow",
      limit: 10,
    });
    expect(mismatchResult).toMatchObject({
      searchMode: "lexical_fallback",
      embeddingStatus: "version_mismatch",
    });

    const unavailable = await CodeSearchService.create(database, repositories, indexes, {
      search: async () => {
        throw new Error("embedding route unavailable");
      },
    });
    const unavailableResult = await unavailable.search(context, {
      repositoryId: prepared.repository.repositoryId,
      query: "workflow",
      limit: 10,
    });
    expect(unavailableResult).toMatchObject({
      searchMode: "lexical_fallback",
      embeddingStatus: "provider_error",
    });
  });
});
