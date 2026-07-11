import { randomUUID } from "node:crypto";

import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase } from "@massion/storage";
import { describe, expect, it } from "vitest";

import { SurrealRegistryStore } from "./surreal-store.js";

const input = {
  packageName: "@massion-ext/slack",
  packageVersion: "1.0.0",
  artifactDigest: "a".repeat(64),
  contentDigest: "b".repeat(64),
  visibility: "public" as const,
  manifest: { description: "Slack", compatibility: { agentOS: "^1.0.0", node: ">=24" } },
};

describe("Surreal Registry store", () => {
  it("tenant를 검증하고 immutable version·assessment·recall을 보존한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "registry", database: randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "registry@example.com", displayName: "Registry" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await SurrealRegistryStore.create(database, organizations);
    const staged = await store.stage(context, "registry-command-0001", {
      ...input,
      ownerOrganizationId: context.organizationId,
    });
    const replay = await store.stage(context, "registry-command-0001", {
      ...input,
      ownerOrganizationId: context.organizationId,
    });
    expect(replay.versionId).toBe(staged.versionId);
    await store.recordAssessment(context, staged.versionId, {
      archive: "pass",
      provenance: "pass",
      sbom: "pass",
      vulnerability: "pass",
      contract: "pass",
      policy: "pass",
    });
    await store.publish(context, staged.versionId, "registry-decision-0001");
    await store.recall(context, staged.versionId, {
      recallId: "registry-recall-0001",
      category: "security",
      severity: "high",
      reason: "OSV-2099-0001",
    });
    expect((await store.get(context, staged.versionId)).state).toBe("recalled");
    expect(await store.listRecalls(context, staged.versionId)).toHaveLength(1);
  });
});
