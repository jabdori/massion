import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import {
  EvidenceIndexRecovery,
  RepositoryStore,
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

describe("Evidence index startup recovery", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let repositories: RepositoryStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "recover-index@example.com", displayName: "Recovery" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    repositories = await RepositoryStore.create(database, organizations);
  });

  afterEach(async () => database.close());

  it("오래된 building version을 partial로 만들고 current complete를 보존한 채 reconcile을 한 번 예약한다", async () => {
    const repository = (
      await repositories.register(context, {
        commandId: crypto.randomUUID(),
        name: "recovery-fixture",
        providerKind: "filesystem",
        rootRef: "/workspace/recovery",
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
    const complete = (
      await repositories.startIndex(context, {
        commandId: crypto.randomUUID(),
        repositoryId: repository.repositoryId,
        repositoryRevisionId: revision.repositoryRevisionId,
        configurationId: configuration.configurationId,
        mode: "reconcile",
      })
    ).index;
    await repositories.completeIndex(context, {
      commandId: crypto.randomUUID(),
      indexVersionId: complete.indexVersionId,
      counts: { files: 0, symbols: 0, relations: 0, chunks: 0 },
      snapshotChecksum: "d".repeat(64),
    });
    const building = (
      await repositories.startIndex(context, {
        commandId: crypto.randomUUID(),
        repositoryId: repository.repositoryId,
        repositoryRevisionId: revision.repositoryRevisionId,
        configurationId: configuration.configurationId,
        mode: "reconcile",
        parentIndexVersionId: complete.indexVersionId,
      })
    ).index;
    const queue = new MemoryQueue();
    const recovery = new EvidenceIndexRecovery(repositories, queue, { isStale: () => true });

    const first = await recovery.recover(context, repository.repositoryId);
    const repeated = await recovery.recover(context, repository.repositoryId);
    const versions = await repositories.listIndexes(context, repository.repositoryId);

    expect(first.recoveredIndexVersionIds).toEqual([building.indexVersionId]);
    expect(repeated.recoveredIndexVersionIds).toEqual([]);
    expect(versions.map(({ status, current }) => [status, current])).toEqual([
      ["complete", true],
      ["partial", false],
    ]);
    expect([...queue.commands.values()]).toEqual([
      expect.objectContaining({
        repositoryId: repository.repositoryId,
        mode: "reconcile",
        parentIndexVersionId: complete.indexVersionId,
        reason: "startup_recovery",
      }),
    ]);
  });
});
