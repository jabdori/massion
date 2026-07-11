import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inspectExtensionArchive } from "./artifact-inspector.js";
import { ExtensionStorageService } from "./storage.js";
import { ExtensionStore, type ExtensionVersionView } from "./store.js";
import { validTar } from "./test-helpers.js";

describe("ExtensionStorageService", () => {
  let database: MassionDatabase;
  let organizations: OrganizationService;
  let context: TenantContext;
  let otherContext: TenantContext;
  let version: ExtensionVersionView;
  let storage: ExtensionStorageService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "storage-owner@example.com", displayName: "Owner" });
    const other = await identities.registerPersonalUser({ email: "storage-other@example.com", displayName: "Other" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    otherContext = await organizations.resolveTenantContext(other.user.user_id, other.organization.organization_id);
    const store = await ExtensionStore.create(database, organizations);
    version = await store.registerVersion(context, {
      commandId: "storage-install",
      artifact: await inspectExtensionArchive(validTar(), {
        runtime: { agentOS: "1.0.0", node: "24.13.0", surrealDB: "3.2.0" },
      }),
      trustLevel: "untrusted-local",
      sourceKind: "tarball",
    });
    storage = await ExtensionStorageService.create(database, organizations);
  });

  afterEach(async () => database.close());

  it("installation namespace에 version precondition으로 값을 저장하고 멱등 재생한다", async () => {
    const input = {
      commandId: "storage-put-1",
      installationId: version.installationId,
      versionId: version.versionId,
      key: "cursor",
      value: { page: 1 },
      quotaBytes: 1024,
      maxValueBytes: 256,
    } as const;
    const first = await storage.put(context, input);
    expect(await storage.put(context, input)).toEqual(first);
    expect(first).toMatchObject({ key: "cursor", value: { page: 1 }, version: 1 });
    const updated = await storage.put(context, {
      ...input,
      commandId: "storage-put-2",
      value: { page: 2 },
      expectedVersion: 1,
    });
    expect(updated.version).toBe(2);
    expect(await storage.get(context, version.installationId, "cursor")).toEqual(updated);
  });

  it("command payload 충돌·version 충돌·key traversal·value·quota 초과를 거부한다", async () => {
    const base = {
      commandId: "storage-boundary",
      installationId: version.installationId,
      versionId: version.versionId,
      key: "state",
      value: { text: "small" },
      quotaBytes: 64,
      maxValueBytes: 32,
    } as const;
    await storage.put(context, base);
    await expect(storage.put(context, { ...base, value: { text: "changed" } })).rejects.toThrow("command");
    await expect(storage.put(context, { ...base, commandId: "version-conflict", expectedVersion: 9 })).rejects.toThrow(
      "version",
    );
    await expect(storage.put(context, { ...base, commandId: "bad-key", key: "../secret" })).rejects.toThrow("key");
    await expect(
      storage.put(context, { ...base, commandId: "large", key: "large", value: "x".repeat(100) }),
    ).rejects.toThrow("value");
    await expect(
      storage.put(context, {
        ...base,
        commandId: "quota",
        key: "second",
        value: { text: "12345678901234567890" },
        quotaBytes: 40,
      }),
    ).rejects.toThrow("quota");
  });

  it("다른 tenant installation을 읽거나 쓸 수 없다", async () => {
    await expect(storage.get(otherContext, version.installationId, "cursor")).rejects.toThrow("installation");
    await expect(
      storage.put(otherContext, {
        commandId: "cross-tenant",
        installationId: version.installationId,
        versionId: version.versionId,
        key: "cursor",
        value: {},
        quotaBytes: 1024,
        maxValueBytes: 256,
      }),
    ).rejects.toThrow("installation");
  });
});
