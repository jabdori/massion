import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { EvidenceMetrics } from "./index.js";

describe("low-cardinality Evidence metrics", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let metrics: EvidenceMetrics;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({
      email: "evidence-metrics@example.com",
      displayName: "Metrics",
    });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    metrics = await EvidenceMetrics.create(database, organizations);
  });

  afterEach(async () => database.close());

  it("index·file·parse·incremental·drift·stale·search를 식별자 label 없이 집계한다", async () => {
    await metrics.recordIndex(context, {
      mode: "incremental",
      status: "complete",
      durationMs: 125,
      files: { complete: 3, partial: 1 },
      parseErrors: 2,
      staged: 2,
      reused: 2,
      reconciliationDrift: 1,
    });
    await metrics.recordFreshness(context, "stale_warning");
    await metrics.recordSearch(context, "lexical_fallback");

    expect(await metrics.read(context)).toEqual({
      indexTotal: { full: 0, incremental: 1, reconcile: 0 },
      indexStatusTotal: { complete: 1, partial: 0, failed: 0 },
      indexDurationMs: { count: 1, total: 125, maximum: 125 },
      fileResultTotal: { complete: 3, partial: 1 },
      parseErrorTotal: 2,
      incrementalChangeTotal: { staged: 2, reused: 2 },
      reconciliationDriftTotal: 1,
      staleTotal: { fresh: 0, stale_warning: 1, reindex_required: 0, blocked: 0 },
      searchTotal: { lexical: 0, hybrid: 0, lexical_fallback: 1 },
    });
    const [records] = await database.query<[{ dimensions_json: string }[]]>(
      "SELECT dimensions_json FROM evidence_metric_event WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(context.organizationId);
    expect(serialized).not.toContain("repository");
    expect(serialized).not.toContain("path");
    expect(serialized).not.toContain("model");
  });
});
