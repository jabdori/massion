import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import {
  EvidenceFreshnessService,
  RepositoryStore,
  type EvidenceBrief,
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

describe("Evidence freshness policy", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let repositories: RepositoryStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "stale@example.com", displayName: "Stale" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    repositories = await RepositoryStore.create(database, organizations);
  });

  afterEach(async () => database.close());

  it("fresh·revision warning·reindex·block과 configuration mismatch를 정책대로 판정한다", async () => {
    const repository = (
      await repositories.register(context, {
        commandId: crypto.randomUUID(),
        name: "stale-fixture",
        providerKind: "filesystem",
        rootRef: "/workspace/stale",
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
    const current = (
      await repositories.completeIndex(context, {
        commandId: crypto.randomUUID(),
        indexVersionId: started.indexVersionId,
        counts: { files: 0, symbols: 0, relations: 0, chunks: 0 },
        snapshotChecksum: "d".repeat(64),
      })
    ).index;
    const brief: EvidenceBrief = {
      evidenceBriefId: "brief-1",
      organizationId: context.organizationId,
      workId: "work-1",
      repositoryId: repository.repositoryId,
      repositoryRevisionId: revision.repositoryRevisionId,
      indexVersionId: current.indexVersionId,
      configurationChecksum: configuration.checksum,
      query: "freshness",
      status: "ready",
      references: [],
      claims: [],
      checksum: "e".repeat(64),
      createdByUserId: context.userId,
      createdAt: new Date(),
    };
    const queue = new MemoryQueue();
    const freshness = new EvidenceFreshnessService(repositories, queue);
    expect(await freshness.assess(context, brief, "warn")).toMatchObject({ status: "fresh", reasons: [] });

    const latest = (
      await repositories.captureRevision(context, {
        commandId: crypto.randomUUID(),
        repositoryId: repository.repositoryId,
        providerRevision: "snapshot:two",
        dirty: false,
        manifestChecksum: "f".repeat(64),
        rootRealPathHash: "a".repeat(64),
        collectorVersion: "test-v1",
      })
    ).revision;
    expect(await freshness.assess(context, brief, "warn")).toMatchObject({
      status: "stale_warning",
      reasons: ["repository_revision_changed"],
    });
    expect(await freshness.assess(context, brief, "reindex")).toMatchObject({
      status: "reindex_required",
      reindexAccepted: true,
    });
    expect(await freshness.assess(context, brief, "block")).toMatchObject({ status: "blocked" });
    expect([...queue.commands.values()]).toEqual([
      expect.objectContaining({ reason: "stale_evidence", parentIndexVersionId: current.indexVersionId }),
    ]);

    await database.query(
      "UPDATE index_version SET configuration_checksum = $checksum WHERE organization_id = $organization_id AND index_version_id = $index_version_id;",
      { checksum: "0".repeat(64), organization_id: context.organizationId, index_version_id: current.indexVersionId },
    );
    const mismatch = await freshness.assess(
      context,
      { ...brief, repositoryRevisionId: latest.repositoryRevisionId },
      "warn",
    );
    expect(mismatch).toMatchObject({ status: "reindex_required" });
    expect(mismatch.reasons).toContain("configuration_mismatch");
  });
});
