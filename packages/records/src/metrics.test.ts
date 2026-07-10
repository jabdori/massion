import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { RecordsMetricStore, validateRecordsMetric } from "./metrics.js";
import { RECORDS_RECOVERY_METRIC_MIGRATION } from "./schema.js";

describe("Records low-cardinality metric", () => {
  it.each([
    ["records_run_duration_ms", { result: "completed" }],
    ["records_run_total", { result: "blocked" }],
    ["records_document_total", { kind: "adr" }],
    ["documentation_impact_total", { kind: "runbook", outcome: "not-applicable" }],
    ["records_blocked_total", { reason: "integrity" }],
    ["records_recovery_total", { result: "resumed" }],
  ] as const)("%s의 허용된 dimension을 승인한다", (name, dimensions) => {
    expect(() => validateRecordsMetric({ name, value: 1, dimensions })).not.toThrow();
  });

  it.each(["organizationId", "workId", "recordsRunId", "documentId", "path", "title", "agent", "user", "model"])(
    "%s 고카디널리티 dimension을 거부한다",
    (dimension) => {
      expect(() =>
        validateRecordsMetric({
          name: "records_run_total",
          value: 1,
          dimensions: { result: "completed", [dimension]: "secret-value" },
        }),
      ).toThrow("dimension");
    },
  );

  it("허용되지 않은 값·누락 dimension·NaN을 거부한다", () => {
    expect(() =>
      validateRecordsMetric({ name: "records_document_total", value: 1, dimensions: { kind: "work-123" } }),
    ).toThrow("값");
    expect(() => validateRecordsMetric({ name: "records_run_total", value: 1, dimensions: {} })).toThrow("dimension");
    expect(() =>
      validateRecordsMetric({ name: "records_run_total", value: Number.NaN, dimensions: { result: "completed" } }),
    ).toThrow("유한");
  });
});

describe("Records metric ledger", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let store: RecordsMetricStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "records-metric@example.com", displayName: "Metric" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    store = await RecordsMetricStore.create(database, organizations);
  });

  afterEach(async () => database.close());

  it("0050 migration과 같은 key의 같은 metric을 한 번만 기록한다", async () => {
    expect(RECORDS_RECOVERY_METRIC_MIGRATION.id).toBe("0050-records-recovery-metric");
    expect(RECORDS_RECOVERY_METRIC_MIGRATION.checksum).toBe(
      "9bf34c644c93745f0f0656a9b0fcf60ebd2b3f22c38d796941f6725056894fe4",
    );
    const metric = {
      name: "documentation_impact_total" as const,
      value: 1,
      dimensions: { kind: "adr", outcome: "required" },
    };
    await store.recordOnce(context, "records-run-1:impact:adr", metric);
    await store.recordOnce(context, "records-run-1:impact:adr", metric);

    expect(await store.aggregate(context)).toEqual([{ ...metric, dimensions: metric.dimensions }]);
    await expect(store.recordOnce(context, "records-run-1:impact:adr", { ...metric, value: 2 })).rejects.toThrow(
      "다른 Records metric",
    );
  });

  it("metric event UPDATE와 DELETE를 거부한다", async () => {
    await store.recordOnce(context, "records-run-1:total", {
      name: "records_run_total",
      value: 1,
      dimensions: { result: "completed" },
    });
    await expect(database.query("UPDATE records_metric_event SET numeric_value = 2;")).rejects.toThrow("immutable");
    await expect(database.query("DELETE records_metric_event;")).rejects.toThrow("immutable");
  });
});
