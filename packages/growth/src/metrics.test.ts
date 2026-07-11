import { afterEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { GrowthMetricStore, validateGrowthMetric } from "./metrics.js";
import { GROWTH_RECOVERY_METRIC_MIGRATION } from "./schema.js";

describe("Growth low-cardinality metric", () => {
  let database: MassionDatabase | undefined;
  afterEach(async () => database?.close());

  it("0060 recovery·metric migration checksum을 고정한다", () => {
    expect(GROWTH_RECOVERY_METRIC_MIGRATION.id).toBe("0060-growth-recovery-metric");
    expect(GROWTH_RECOVERY_METRIC_MIGRATION.checksum).toBe(
      "6944a011eb47ddccc165afe4386a56d4e0874032f649be2d19c3a28aa7f09f13",
    );
  });

  it("설계의 metric과 고정 dimension만 허용한다", () => {
    expect(() =>
      validateGrowthMetric({
        name: "growth_adoption_total",
        value: 1,
        unit: "count",
        dimensions: { targetKind: "prompt", mode: "auto", result: "observing" },
      }),
    ).not.toThrow();
    expect(() =>
      validateGrowthMetric({
        name: "growth_adoption_total",
        value: 1,
        unit: "count",
        dimensions: { organizationId: "secret-tenant" },
      }),
    ).toThrow("dimension");
  });

  it("NaN·임의 metric·label injection을 거부한다", () => {
    expect(() =>
      validateGrowthMetric({ name: "growth_adoption_total", value: Number.NaN, unit: "count", dimensions: {} }),
    ).toThrow("finite");
    expect(() => validateGrowthMetric({ name: "custom_metric", value: 1, unit: "count", dimensions: {} })).toThrow(
      "allowlist",
    );
    expect(() =>
      validateGrowthMetric({
        name: "growth_recovery_total",
        value: 1,
        unit: "count",
        dimensions: { stage: "../../tenant", result: "ok" },
      }),
    ).toThrow("label");
  });

  it("같은 idempotency key와 payload를 한 번만 기록하고 변조를 거부한다", async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "metric@example.com", displayName: "Metric" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const store = await GrowthMetricStore.create(database, organizations);
    const metric = {
      name: "growth_recovery_total",
      value: 1,
      unit: "count",
      dimensions: { stage: "adoption", result: "recovered" },
    } as const;
    const first = await store.recordOnce(context, "recovery:adoption:1", metric);
    await expect(store.recordOnce(context, "recovery:adoption:1", metric)).resolves.toEqual(first);
    await expect(store.recordOnce(context, "recovery:adoption:1", { ...metric, value: 2 })).rejects.toThrow(
      "다른 payload",
    );
    await expect(database.query("DELETE growth_metric;")).rejects.toThrow("immutable");
  });
});
