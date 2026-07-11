import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inspectExtensionArchive } from "./artifact-inspector.js";
import { ExtensionComplianceAuditor } from "./compliance.js";
import { ExtensionStore, FileArtifactStore } from "./store.js";
import { validTar } from "./test-helpers.js";

describe("ExtensionComplianceAuditor", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let organizations: OrganizationService;
  let artifacts: FileArtifactStore;
  let committedPath: string;
  let root: string;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "compliance@example.com", displayName: "Compliance" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await ExtensionStore.create(database, organizations);
    root = await mkdtemp(join(tmpdir(), "massion-compliance-"));
    artifacts = new FileArtifactStore(root);
    const archive = validTar();
    const report = await inspectExtensionArchive(archive, {
      runtime: { agentOS: "1.0.0", node: "24.13.0", surrealDB: "3.2.0" },
    });
    const committed = await artifacts.commit(
      await artifacts.stage(context.organizationId, report.artifactDigest, archive),
    );
    committedPath = committed.path;
    await artifacts.materialize(context.organizationId, report.artifactDigest, report);
    const version = await store.registerVersion(context, {
      commandId: "compliance-version",
      artifact: report,
      trustLevel: "built-in",
      sourceKind: "bundled",
    });
    await store.activateVersion(context, {
      commandId: "compliance-activation",
      versionId: version.versionId,
      expectedGeneration: 0,
      governanceDecisionIds: ["decision-compliance"],
      healthReceipt: { status: "healthy", checkedAt: new Date().toISOString() },
    });
  });
  afterEach(async () => {
    await database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("artifact·manifest·permission·activation·grant 계보가 맞으면 통과한다", async () => {
    const auditor = await ExtensionComplianceAuditor.create(database, organizations, artifacts);
    await expect(auditor.assertCompliant(context)).resolves.toBeUndefined();
  });

  it("restore 뒤 artifact 변조를 탐지해 gateway 활성화를 차단한다", async () => {
    await writeFile(committedPath, "corrupt");
    const auditor = await ExtensionComplianceAuditor.create(database, organizations, artifacts);
    await expect(auditor.assertCompliant(context)).rejects.toThrow("artifact");
  });
});
