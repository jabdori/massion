import { randomUUID } from "node:crypto";

import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase } from "@massion/storage";
import { describe, expect, it } from "vitest";

import { SurrealRegistryStore } from "./surreal-store.js";
import { RegistryTelemetryStore } from "./telemetry.js";

const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;

describe("Registry remote contract", () => {
  remoteTest(
    "실제 SurrealDB 3.2.x에서 동시 게시·검사·리콜·telemetry 계보를 보존한다",
    async () => {
      const databaseName = `registry_${randomUUID().replaceAll("-", "")}`;
      await using admin = await createDatabase({
        url: remoteUrl ?? "",
        namespace: "main",
        database: "main",
        authentication: { username: "root", password: "root" },
      });
      await admin.query(`DEFINE NAMESPACE IF NOT EXISTS massion; USE NS massion; DEFINE DATABASE ${databaseName};`);
      await using database = await createDatabase({
        url: remoteUrl ?? "",
        namespace: "massion",
        database: databaseName,
        authentication: { username: "root", password: "root" },
      });
      expect(await database.version()).toMatch(/^surrealdb-3\.2\./u);
      const identities = await IdentityService.create(database);
      const organizations = await OrganizationService.create(database);
      const owner = await identities.registerPersonalUser({
        email: `${databaseName}@example.com`,
        displayName: "Registry Remote",
      });
      const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
      const store = await SurrealRegistryStore.create(database, organizations);
      const input = {
        packageName: "@massion-ext/github",
        packageVersion: "1.0.0",
        artifactDigest: "a".repeat(64),
        contentDigest: "b".repeat(64),
        visibility: "public" as const,
        ownerOrganizationId: context.organizationId,
        manifest: { description: "GitHub", compatibility: { agentOS: "^1.0.0", node: ">=24" } },
      };
      const [first, replay] = await Promise.all([
        store.stage(context, "registry-remote-command-1", input),
        store.stage(context, "registry-remote-command-1", input),
      ]);
      expect(replay.versionId).toBe(first.versionId);
      await store.recordAssessment(context, first.versionId, {
        archive: "pass",
        provenance: "pass",
        sbom: "pass",
        vulnerability: "pass",
        contract: "pass",
        policy: "pass",
      });
      await store.publish(context, first.versionId, "registry-remote-decision-1");
      await store.recall(context, first.versionId, {
        recallId: "registry-remote-recall-1",
        category: "security",
        severity: "critical",
        reason: "remote security drill",
      });
      await store.supersedeRecall(context, first.versionId, {
        recallId: "registry-remote-recall-2",
        supersedesRecallId: "registry-remote-recall-1",
        reason: "독립 재검증으로 오탐 확인",
      });
      expect((await store.get(context, first.versionId)).state).toBe("published");
      const telemetry = await RegistryTelemetryStore.create(database, organizations);
      await telemetry.record(context, {
        sourceId: "registry-remote-source-1",
        eventType: "registry.package.recalled",
        outcome: "succeeded",
        packageName: input.packageName,
        packageVersion: input.packageVersion,
        metricName: "registry_recall_total",
      });
      expect(await telemetry.list(context)).toHaveLength(1);
    },
    30_000,
  );
});
