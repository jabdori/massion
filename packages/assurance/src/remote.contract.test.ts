import { describe, expect, it } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase, listAppliedMigrations } from "@massion/storage";
import { WorkService } from "@massion/work";

import {
  AssuranceBootstrap,
  MetricObservationStore,
  metricObservationChecksum,
  type MetricObservationReader,
} from "./index.js";

const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;

async function provision(databaseName: string): Promise<void> {
  await using admin = await createDatabase({
    url: remoteUrl ?? "",
    namespace: "main",
    database: "main",
    authentication: { username: "root", password: "root" },
  });
  await admin.query(`DEFINE NAMESPACE IF NOT EXISTS massion; USE NS massion; DEFINE DATABASE ${databaseName};`);
}

describe("remote Assurance contract", () => {
  remoteTest("SurrealDB 3.2에서 migration·MetricObservation·tenant·command 원장을 보존한다", async () => {
    const databaseName = `assurance_${crypto.randomUUID().replaceAll("-", "")}`;
    await provision(databaseName);
    await using database = await createDatabase({
      url: remoteUrl ?? "",
      namespace: "massion",
      database: databaseName,
      authentication: { username: "root", password: "root" },
    });
    expect(await database.version()).toMatch(/^surrealdb-3\.2\./u);

    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({
      email: `assurance-owner-${crypto.randomUUID()}@example.com`,
      displayName: "Assurance Owner",
    });
    const outsider = await identity.registerPersonalUser({
      email: `assurance-outsider-${crypto.randomUUID()}@example.com`,
      displayName: "Assurance Outsider",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const otherContext = await organizations.resolveTenantContext(
      outsider.user.user_id,
      outsider.organization.organization_id,
    );
    const graph = await OrganizationGraphService.create(database, organizations);
    const organization = await graph.bootstrap(context);
    const firstBootstrap = await AssuranceBootstrap.create(database, organizations);
    await AssuranceBootstrap.create(database, organizations);
    const assuranceMigrations = (await listAppliedMigrations(database)).filter((migration) =>
      ["0039", "0040", "0041", "0042", "0043", "0045", "0046"].some((prefix) =>
        migration.migration_id.startsWith(prefix),
      ),
    );
    expect(assuranceMigrations.map((migration) => migration.migration_id)).toEqual([
      "0039-assurance-run",
      "0040-governance-decision-context",
      "0041-assurance-binding",
      "0042-work-assurance-link",
      "0043-assurance-evidence-integrity",
      "0045-assurance-decision-evidence",
      "0046-assurance-recovery-metric",
    ]);
    expect(new Set(assuranceMigrations.map((migration) => migration.checksum)).size).toBe(assuranceMigrations.length);

    const works = await WorkService.create(database, organizations, graph);
    const created = await works.createWork(context, {
      commandId: crypto.randomUUID(),
      text: "원격 MetricObservation",
      surface: "remote-contract",
      organizationVersionId: organization.version.version_id,
    });
    const artifact = await works.createArtifactVersion(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      kind: "metric-source",
      name: "coverage.json",
      mediaType: "application/json",
      content: { coverage: 98.5 },
    });
    const reader: MetricObservationReader = {
      async observe(_executor, input) {
        const value = 98.5;
        const unit = "percent";
        const measuredAt = "2026-07-11T00:00:00.000Z";
        const sourceChecksum = artifact.artifactVersion.checksum;
        return {
          value,
          unit,
          measuredAt,
          sourceChecksum,
          checksum: metricObservationChecksum({ ...input, value, unit, measuredAt, sourceChecksum }),
        };
      },
    };
    const metrics = new MetricObservationStore(database, organizations, {
      systemAdapters: { "massion.metric.coverage.v1": reader },
      clock: () => new Date("2026-07-11T00:00:30.000Z"),
    });
    const commandId = crypto.randomUUID();
    const input = {
      commandId,
      workId: created.work.work_id,
      producer: { kind: "system_adapter" as const, id: "massion.metric.coverage.v1" },
      source: { kind: "artifact_version" as const, id: artifact.artifactVersion.artifact_version_id },
      expectedUnit: "percent",
      maximumAgeMs: 60_000,
    };
    const [first, concurrent] = await Promise.all([metrics.record(context, input), metrics.record(context, input)]);
    expect(concurrent.observationId).toBe(first.observationId);
    await expect(metrics.record(context, { ...input, expectedUnit: "ratio" })).rejects.toThrow("같은 commandId");
    await expect(metrics.record(otherContext, { ...input, commandId: crypto.randomUUID() })).rejects.toThrow();
    await expect(firstBootstrap.get(otherContext, "missing-run")).rejects.toThrow();

    const [observations] = await database.query<[{ observation_id: string }[]]>(
      "SELECT observation_id FROM assurance_metric_observation WHERE organization_id = $organization_id AND command_id = $command_id;",
      { organization_id: context.organizationId, command_id: commandId },
    );
    expect(observations).toHaveLength(1);
  });
});
