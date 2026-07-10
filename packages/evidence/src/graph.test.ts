import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import {
  CodeGraphService,
  EvidenceIndexer,
  EvidenceParser,
  IndexStore,
  RepositoryScanner,
  RepositoryStore,
} from "./index.js";

const OPTIONS = { include: ["**/*"], exclude: [], maxFileBytes: 128 * 1_024 } as const;

describe("version-scoped code graph", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let repositories: RepositoryStore;
  let indexes: IndexStore;
  let root: string;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "graph@example.com", displayName: "Graph" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    repositories = await RepositoryStore.create(database, organizations);
    indexes = await IndexStore.create(database, organizations);
    root = await mkdtemp(path.join(os.tmpdir(), "massion-graph-"));
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("resolved contains·call neighbor와 unresolved target을 구분하고 index 밖 target을 거부한다", async () => {
    await writeFile(
      path.join(root, "graph.ts"),
      "class Service { run() { helper(); externalPackage(); } }\nfunction helper() { return true; }\n",
    );
    const scanner = new RepositoryScanner();
    const scan = await scanner.scan(root, OPTIONS);
    const repository = (
      await repositories.register(context, {
        commandId: crypto.randomUUID(),
        name: "graph-fixture",
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
        checksum: "9".repeat(64),
        parserBundleVersion: "parser-v1",
        schemaVersion: "evidence-v1",
        embeddingStatus: "unavailable",
        settings: OPTIONS,
      })
    ).configuration;
    const indexed = await new EvidenceIndexer(repositories, indexes, scanner, new EvidenceParser()).index(context, {
      commandId: crypto.randomUUID(),
      repositoryId: repository.repositoryId,
      repositoryRevisionId: revision.repositoryRevisionId,
      configurationId: configuration.configurationId,
      mode: "full",
      root,
      scanOptions: OPTIONS,
    });
    const snapshot = await indexes.getSnapshot(context, indexed.index.indexVersionId);
    const service = snapshot.symbols.find((symbol) => symbol.qualifiedName === "Service");
    const run = snapshot.symbols.find((symbol) => symbol.qualifiedName === "Service.run");
    const helper = snapshot.symbols.find((symbol) => symbol.qualifiedName === "helper");
    const graph = new CodeGraphService(repositories, indexes);

    const contains = await graph.neighbors(context, {
      repositoryId: repository.repositoryId,
      indexVersionId: indexed.index.indexVersionId,
      symbolKey: service?.symbolKey ?? "missing",
      direction: "outgoing",
      depth: 1,
    });
    const calls = await graph.neighbors(context, {
      repositoryId: repository.repositoryId,
      indexVersionId: indexed.index.indexVersionId,
      symbolKey: run?.symbolKey ?? "missing",
      direction: "outgoing",
      depth: 1,
    });
    expect(contains.nodes.map((node) => node.symbolKey)).toContain(run?.symbolKey);
    expect(contains.edges).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "contains" })]));
    expect(calls.nodes.map((node) => node.symbolKey)).toContain(helper?.symbolKey);
    expect(calls.unresolved).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "calls", targetText: "externalPackage" })]),
    );

    await database.query(
      "UPDATE evidence_relation SET target_symbol_key = 'outside-index', resolved = true WHERE organization_id = $organization_id AND index_version_id = $index_version_id AND kind = 'calls' AND target_text = 'helper';",
      { organization_id: context.organizationId, index_version_id: indexed.index.indexVersionId },
    );
    await expect(
      graph.neighbors(context, {
        repositoryId: repository.repositoryId,
        indexVersionId: indexed.index.indexVersionId,
        symbolKey: run?.symbolKey ?? "missing",
        direction: "outgoing",
        depth: 1,
      }),
    ).rejects.toThrow("IndexVersion 밖");
  });
});
