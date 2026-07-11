import { describe, expect, it, vi } from "vitest";

import { RegistryApplicationAdapter } from "./application-adapter.js";
import { RegistryCatalog } from "./catalog.js";
import { MemoryRegistryStore } from "./store.js";

const context = { organizationId: "org-owner", userId: "user-owner", role: "owner" } as never;

describe("Registry Application adapter", () => {
  it("검색·설치·inventory·recall을 같은 catalog와 tenant context에 연결한다", async () => {
    const store = new MemoryRegistryStore();
    const staged = await store.stage("adapter-stage-1", {
      packageName: "@massion-ext/slack",
      packageVersion: "1.0.0",
      artifactDigest: "a".repeat(64),
      contentDigest: "b".repeat(64),
      visibility: "public",
      ownerOrganizationId: "org-owner",
      manifest: { description: "Slack", compatibility: { agentOS: "^1.0.0", node: ">=24" } },
    });
    await store.recordAssessment(staged.versionId, {
      archive: "pass",
      provenance: "pass",
      sbom: "pass",
      vulnerability: "pass",
      contract: "pass",
      policy: "pass",
    });
    await store.publish(staged.versionId, "adapter-decision-1");
    const install = vi.fn(async () => ({
      installationId: "installation-1",
      packageName: "@massion-ext/slack",
      packageVersion: "1.0.0",
    }));
    const adapter = new RegistryApplicationAdapter({
      catalog: new RegistryCatalog(store, { tokenSecret: Buffer.alloc(32, 6) }),
      versions: {
        get: async (_context, versionId) => await store.get(versionId),
        recall: async (_context, versionId, recall) => await store.recall(versionId, recall),
        supersedeRecall: async (_context, versionId, input) => await store.supersedeRecall(versionId, input),
      },
      catalogVersions: store,
      installer: { install },
      inventory: { list: vi.fn(async () => []) },
      runtime: { agentOS: "1.0.0", node: "24.0.0" },
    });
    expect((await adapter.search(context, { query: "slack", limit: 20 })) as { items: unknown[] }).toMatchObject({
      items: [expect.objectContaining({ packageName: "@massion-ext/slack" })],
    });
    await adapter.install(context, {
      commandId: "adapter-install-1",
      versionId: staged.versionId,
      environment: "production",
      riskClass: "medium",
      executionId: "execution-1",
    });
    expect(install).toHaveBeenCalledWith(context, expect.objectContaining({ downloadGrant: expect.any(String) }));
    await adapter.recall(context, {
      commandId: "adapter-recall-1",
      versionId: staged.versionId,
      category: "security",
      severity: "high",
      reason: "security issue",
    });
    expect((await store.get(staged.versionId)).state).toBe("recalled");
  });
});
