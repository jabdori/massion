import { describe, expect, it } from "vitest";

import { RegistryCatalog } from "./catalog.js";
import { MemoryRegistryStore } from "./store.js";

async function published(store: MemoryRegistryStore, input: { name: string; version: string; visibility?: "public" | "private"; owner?: string }) {
  const staged = await store.stage(`command-${input.name.split("/")[1]}-${input.version}`, {
    packageName: input.name,
    packageVersion: input.version,
    artifactDigest: input.version.replaceAll(".", "").padEnd(64, "a"),
    contentDigest: input.version.replaceAll(".", "").padEnd(64, "b"),
    visibility: input.visibility ?? "public",
    ownerOrganizationId: input.owner ?? "org-owner",
    manifest: { description: `${input.name} extension`, compatibility: { agentOS: "^1.0.0", node: ">=24.0.0" } },
  });
  await store.recordAssessment(staged.versionId, { archive: "pass", provenance: "pass", sbom: "pass", vulnerability: "pass", contract: "pass", policy: "pass" });
  return await store.publish(staged.versionId, `decision-${input.version}`);
}

describe("Registry catalog", () => {
  it("호환되는 public package만 결정론적으로 검색하고 private tenant를 격리한다", async () => {
    const store = new MemoryRegistryStore();
    await published(store, { name: "@massion-ext/slack", version: "1.0.0" });
    await published(store, { name: "@massion-ext/github", version: "1.0.0", visibility: "private", owner: "org-private" });
    const catalog = new RegistryCatalog(store, { tokenSecret: Buffer.alloc(32, 3) });
    const publicResult = await catalog.search({ organizationId: "org-other", query: "extension", runtime: { agentOS: "1.0.0", node: "24.0.0" }, limit: 10 });
    expect(publicResult.items.map((item) => item.packageName)).toEqual(["@massion-ext/slack"]);
    const privateResult = await catalog.search({ organizationId: "org-private", query: "github", runtime: { agentOS: "1.0.0", node: "24.0.0" }, limit: 10 });
    expect(privateResult.items).toHaveLength(1);
  });

  it("recalled version은 검색·download grant에서 차단하고 packument에 경고한다", async () => {
    const store = new MemoryRegistryStore();
    const version = await published(store, { name: "@massion-ext/slack", version: "1.0.0" });
    const catalog = new RegistryCatalog(store, { tokenSecret: Buffer.alloc(32, 4) });
    await store.recall(version.versionId, { recallId: "recall-slack-1", category: "security", severity: "critical", reason: "GHSA-test" });
    expect((await catalog.search({ organizationId: "org-other", query: "slack", runtime: { agentOS: "1.0.0", node: "24.0.0" }, limit: 10 })).items).toHaveLength(0);
    await expect(catalog.issueDownload({ organizationId: "org-owner", versionId: version.versionId })).rejects.toThrow("recalled");
    const packument = await catalog.packument("org-other", "@massion-ext/slack");
    expect(packument.versions["1.0.0"]?.deprecated).toContain("recalled");
  });
});
