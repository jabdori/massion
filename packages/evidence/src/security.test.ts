import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { EvidenceIndexer, EvidenceParser, IndexStore, RepositoryScanner, RepositoryStore } from "./index.js";

const OPTIONS = { include: ["**/*.ts"], exclude: [], maxFileBytes: 16 * 1_024 } as const;

describe("source secret persistence boundary", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let organizations: OrganizationService;
  let root: string;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "secret-index@example.com", displayName: "Secret" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    root = await mkdtemp(path.join(os.tmpdir(), "massion-secret-index-"));
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("credential 원문을 parser·chunk·event에 전달하지 않고 range hash만 SourceFile에 저장한다", async () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    await writeFile(path.join(root, "credential.ts"), `export const accessToken = "${secret}";\n`);
    const scanner = new RepositoryScanner();
    const scan = await scanner.scan(root, OPTIONS);
    const repositories = await RepositoryStore.create(database, organizations);
    const indexes = await IndexStore.create(database, organizations);
    const repository = (
      await repositories.register(context, {
        commandId: crypto.randomUUID(),
        name: "secret-fixture",
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
        checksum: "a".repeat(64),
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

    expect(snapshot.files[0]?.redactions).toEqual([
      expect.objectContaining({
        reason: "provider_token",
        contentHash: createHash("sha256").update(secret).digest("hex"),
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(await database.exportSql()).not.toContain(secret);
  });
});
