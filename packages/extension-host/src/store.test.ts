import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, createDatabase, listAppliedMigrations, type MassionDatabase } from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inspectExtensionArchive } from "./artifact-inspector.js";
import {
  EXTENSION_ACTIVATION_MIGRATION,
  EXTENSION_CATALOG_MIGRATION,
  EXTENSION_RECOVERY_METRIC_MIGRATION,
  EXTENSION_WORKER_STORAGE_MIGRATION,
} from "./schema.js";
import { ExtensionStore, FileArtifactStore } from "./store.js";
import { validTar } from "./test-helpers.js";

const runtime = { agentOS: "1.0.0", node: "24.13.0", surrealDB: "3.2.0" };
const digest = (value: Buffer): string => createHash("sha256").update(value).digest("hex");

describe("Extension schema", () => {
  it("0061~0064 migration을 순서대로 한 번만 적용한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const migrations = [
      EXTENSION_CATALOG_MIGRATION,
      EXTENSION_ACTIVATION_MIGRATION,
      EXTENSION_WORKER_STORAGE_MIGRATION,
      EXTENSION_RECOVERY_METRIC_MIGRATION,
    ];
    expect(migrations.map((migration) => migration.id)).toEqual([
      "0061-extension-catalog",
      "0062-extension-activation",
      "0063-extension-worker-storage",
      "0064-extension-recovery-metric",
    ]);
    expect(migrations.map((migration) => migration.checksum)).toEqual([
      "bed104bbbb8e94b8a9d0184a8d488d4d7a2f5b20b67d693c508ffcc177dcca40",
      "02fe4564e621e63a929f8c2329090632d9e76eb7af95ff1eeb8a94c6bcfb133d",
      "794738de330cbd43b4667e46ddb1064fe2a7571129120e17f2d0c258e0b496a4",
      "57b2d875f8d0a8809eeb41a517ab83376ac4be7dc190ec939d32ac6212cc1df4",
    ]);
    expect(await applyMigrations(database, migrations)).toEqual(migrations.map((migration) => migration.id));
    expect(await applyMigrations(database, migrations)).toEqual([]);
    expect((await listAppliedMigrations(database)).map((migration) => migration.migration_id)).toEqual(
      migrations.map((migration) => migration.id),
    );
  });
});

describe("ExtensionStore", () => {
  let database: MassionDatabase;
  let organizations: OrganizationService;
  let context: TenantContext;
  let otherContext: TenantContext;
  let store: ExtensionStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "extension-owner@example.com", displayName: "Owner" });
    const other = await identities.registerPersonalUser({ email: "extension-other@example.com", displayName: "Other" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    otherContext = await organizations.resolveTenantContext(other.user.user_id, other.organization.organization_id);
    store = await ExtensionStore.create(database, organizations);
  });

  afterEach(async () => database.close());

  it("같은 command와 artifact는 재생하고 다른 payload는 거부한다", async () => {
    const artifact = await inspectExtensionArchive(validTar(), { runtime });
    const input = {
      commandId: "install-1",
      artifact,
      trustLevel: "untrusted-local" as const,
      sourceKind: "tarball" as const,
    };

    const first = await store.registerVersion(context, input);
    const repeated = await store.registerVersion(context, input);

    expect(repeated).toEqual(first);
    expect(first).toMatchObject({
      organizationId: context.organizationId,
      packageName: "@massion-ext/echo",
      packageVersion: "1.0.0",
      artifactDigest: artifact.artifactDigest,
      activationGeneration: 0,
    });
    await expect(
      store.registerVersion(context, { ...input, artifact: { ...artifact, artifactDigest: "f".repeat(64) } }),
    ).rejects.toThrow("command");
  });

  it("같은 name·version의 다른 digest와 다른 tenant 읽기를 거부한다", async () => {
    const artifact = await inspectExtensionArchive(validTar(), { runtime });
    const created = await store.registerVersion(context, {
      commandId: "install-version",
      artifact,
      trustLevel: "untrusted-local",
      sourceKind: "tarball",
    });
    await expect(
      store.registerVersion(context, {
        commandId: "install-version-conflict",
        artifact: { ...artifact, artifactDigest: "e".repeat(64) },
        trustLevel: "untrusted-local",
        sourceKind: "tarball",
      }),
    ).rejects.toThrow("같은 package version");
    await expect(store.getVersion(otherContext, created.versionId)).rejects.toThrow("찾을 수 없습니다");
  });

  it("active pointer·activation event를 원자 변경하고 generation 충돌을 거부한다", async () => {
    const artifact = await inspectExtensionArchive(validTar(), { runtime });
    const version = await store.registerVersion(context, {
      commandId: "install-active",
      artifact,
      trustLevel: "untrusted-local",
      sourceKind: "tarball",
    });
    const input = {
      commandId: "activate-1",
      versionId: version.versionId,
      expectedGeneration: 0,
      governanceDecisionIds: ["decision-install"],
      healthReceipt: { status: "healthy", checkedAt: new Date().toISOString(), digest: "a".repeat(64) },
    } as const;

    const activated = await store.activateVersion(context, input);

    expect(activated).toMatchObject({ activeVersionId: version.versionId, activationGeneration: 1, state: "active" });
    expect(await store.activateVersion(context, input)).toEqual(activated);
    await expect(
      store.activateVersion(context, { ...input, commandId: "activate-stale", expectedGeneration: 0 }),
    ).rejects.toThrow("generation");
    const [events] = await database.query<[Array<{ event_type: string; created_at: unknown }>]>(
      "SELECT event_type, created_at FROM extension_event WHERE organization_id = $organization_id ORDER BY created_at ASC;",
      { organization_id: context.organizationId },
    );
    expect(events.map((event) => event.event_type)).toEqual(["version_registered", "version_activated"]);
  });

  it("version content의 직접 수정·삭제를 거부한다", async () => {
    const artifact = await inspectExtensionArchive(validTar(), { runtime });
    const version = await store.registerVersion(context, {
      commandId: "install-immutable",
      artifact,
      trustLevel: "untrusted-local",
      sourceKind: "tarball",
    });
    await expect(
      database.query("UPDATE extension_version SET package_version = '9.9.9' WHERE version_id = $version_id;", {
        version_id: version.versionId,
      }),
    ).rejects.toThrow("immutable");
    await expect(
      database.query("DELETE extension_version WHERE version_id = $version_id;", { version_id: version.versionId }),
    ).rejects.toThrow("immutable");
  });
});

describe("FileArtifactStore", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  it("organization hash namespace에 exclusive staging 후 digest path로 commit한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-artifact-store-"));
    roots.push(root);
    const store = new FileArtifactStore(root);
    const archive = validTar();
    const staged = await store.stage("organization-secret-id", digest(archive), archive);

    expect(staged.path).not.toContain("organization-secret-id");
    const committed = await store.commit(staged);
    expect(committed.digest).toBe(digest(archive));
    expect(await store.read("organization-secret-id", committed.digest)).toEqual(archive);
  });

  it("잘못된 expected digest와 기존 artifact 변조를 거부한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-artifact-corrupt-"));
    roots.push(root);
    const store = new FileArtifactStore(root);
    const archive = validTar();
    await expect(store.stage("organization-1", "0".repeat(64), archive)).rejects.toThrow("digest");
    const committed = await store.commit(await store.stage("organization-1", digest(archive), archive));
    await writeFile(committed.path, "corrupt");
    await expect(store.read("organization-1", committed.digest)).rejects.toThrow("corrupt");
    expect((await readFile(committed.path)).toString()).toBe("corrupt");
  });
});
