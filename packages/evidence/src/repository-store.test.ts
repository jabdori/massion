import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { RepositoryStore } from "./index.js";

describe("Evidence repository와 immutable index catalog", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let organizations: OrganizationService;
  let store: RepositoryStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "evidence@example.com", displayName: "Evidence" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    store = await RepositoryStore.create(database, organizations);
  });

  afterEach(async () => database.close());

  async function repository(commandId = crypto.randomUUID()) {
    return await store.register(context, {
      commandId,
      name: "massion",
      providerKind: "git",
      rootRef: "/workspace/massion",
      rootRealPathHash: "a".repeat(64),
      defaultBranch: "main",
    });
  }

  it("repository 등록과 같은 command를 멱등 재생하고 payload 변경은 거부한다", async () => {
    const commandId = crypto.randomUUID();
    const first = await repository(commandId);
    const repeated = await repository(commandId);

    expect(first.repository).toMatchObject({
      organizationId: context.organizationId,
      name: "massion",
      providerKind: "git",
      status: "active",
    });
    expect(repeated.repository.repositoryId).toBe(first.repository.repositoryId);
    const [events] = await database.query<[{ payload_json: string; result_json: string }[]]>(
      "SELECT payload_json, result_json FROM evidence_index_event WHERE organization_id = $organization_id AND command_id = $command_id;",
      { organization_id: context.organizationId, command_id: commandId },
    );
    expect(JSON.stringify(events)).not.toContain("/workspace/massion");
    await expect(
      store.register(context, {
        commandId,
        name: "different",
        providerKind: "git",
        rootRef: "/workspace/different",
        rootRealPathHash: "b".repeat(64),
        defaultBranch: "main",
      }),
    ).rejects.toThrow("다른 repository 명령");
  });

  it("provider revision과 dirty fingerprint를 immutable snapshot으로 저장한다", async () => {
    const registered = await repository();
    const input = {
      commandId: crypto.randomUUID(),
      repositoryId: registered.repository.repositoryId,
      providerRevision: "0123456789abcdef0123456789abcdef01234567",
      dirty: true,
      dirtyFingerprint: "c".repeat(64),
      manifestChecksum: "d".repeat(64),
      rootRealPathHash: "a".repeat(64),
      collectorVersion: "git-v1",
    } as const;
    const first = await store.captureRevision(context, input);
    const repeated = await store.captureRevision(context, input);

    expect(first.revision).toMatchObject({
      repositoryId: registered.repository.repositoryId,
      revision: `${input.providerRevision}:dirty:${input.dirtyFingerprint}`,
      dirty: true,
      manifestChecksum: input.manifestChecksum,
    });
    expect(repeated.revision.repositoryRevisionId).toBe(first.revision.repositoryRevisionId);
    await expect(
      store.captureRevision(context, { ...input, commandId: crypto.randomUUID(), manifestChecksum: "e".repeat(64) }),
    ).resolves.toMatchObject({ revision: { version: 2 } });
    expect(
      (await store.listRevisions(context, registered.repository.repositoryId)).map((item) => item.version),
    ).toEqual([1, 2]);
  });

  it("complete index만 current가 되고 새 complete index가 이전 version을 supersede한다", async () => {
    const registered = await repository();
    const revision = await store.captureRevision(context, {
      commandId: crypto.randomUUID(),
      repositoryId: registered.repository.repositoryId,
      providerRevision: "rev-1",
      dirty: false,
      manifestChecksum: "1".repeat(64),
      rootRealPathHash: "a".repeat(64),
      collectorVersion: "filesystem-v1",
    });
    const configuration = await store.createConfiguration(context, {
      commandId: crypto.randomUUID(),
      repositoryId: registered.repository.repositoryId,
      checksum: "2".repeat(64),
      parserBundleVersion: "vscode-tree-sitter-wasm-0.3.1",
      schemaVersion: "evidence-v1",
      embeddingStatus: "unavailable",
      settings: { include: ["**/*"], exclude: ["node_modules"] },
    });
    const first = await store.startIndex(context, {
      commandId: crypto.randomUUID(),
      repositoryId: registered.repository.repositoryId,
      repositoryRevisionId: revision.revision.repositoryRevisionId,
      configurationId: configuration.configuration.configurationId,
      mode: "full",
    });
    expect(await store.getCurrentIndex(context, registered.repository.repositoryId)).toBeUndefined();
    const completedFirst = await store.completeIndex(context, {
      commandId: crypto.randomUUID(),
      indexVersionId: first.index.indexVersionId,
      counts: { files: 2, symbols: 3, relations: 1, chunks: 4 },
      snapshotChecksum: "3".repeat(64),
    });
    expect(completedFirst.index).toMatchObject({ status: "complete", current: true, version: 1 });

    const second = await store.startIndex(context, {
      commandId: crypto.randomUUID(),
      repositoryId: registered.repository.repositoryId,
      repositoryRevisionId: revision.revision.repositoryRevisionId,
      configurationId: configuration.configuration.configurationId,
      mode: "reconcile",
      parentIndexVersionId: completedFirst.index.indexVersionId,
    });
    const completedSecond = await store.completeIndex(context, {
      commandId: crypto.randomUUID(),
      indexVersionId: second.index.indexVersionId,
      counts: { files: 2, symbols: 3, relations: 1, chunks: 4 },
      snapshotChecksum: "4".repeat(64),
    });
    const versions = await store.listIndexes(context, registered.repository.repositoryId);

    expect(completedSecond.index).toMatchObject({ status: "complete", current: true, version: 2 });
    expect(versions.map((item) => [item.version, item.status, item.current])).toEqual([
      [1, "superseded", false],
      [2, "complete", true],
    ]);
    expect(await store.audit(context, registered.repository.repositoryId)).toEqual([]);
  });

  it("다른 조직은 repository, revision과 index를 조회할 수 없다", async () => {
    const registered = await repository();
    const identity = await IdentityService.create(database);
    const other = await identity.registerPersonalUser({ email: "other-evidence@example.com", displayName: "Other" });
    const otherContext = await organizations.resolveTenantContext(
      other.user.user_id,
      other.organization.organization_id,
    );

    await expect(store.getRepository(otherContext, registered.repository.repositoryId)).rejects.toThrow(
      "Repository를 찾을 수 없습니다",
    );
    await expect(store.listRevisions(otherContext, registered.repository.repositoryId)).rejects.toThrow(
      "Repository를 찾을 수 없습니다",
    );
  });
});
