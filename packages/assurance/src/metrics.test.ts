import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { AssuranceMetricStore } from "./metrics.js";

describe("Assurance low-cardinality metrics", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let metrics: AssuranceMetricStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({
      email: "assurance-metrics@example.com",
      displayName: "Metrics",
    });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    metrics = await AssuranceMetricStore.create(database, organizations);
  });

  afterEach(async () => database.close());

  it("run·verdict·criterion·finding·check·blocked·recovery를 고정 dimension으로 집계한다", async () => {
    await metrics.record(context, {
      name: "assurance_run_duration_ms",
      value: 120,
      dimensions: { profileFamily: "software-change", verdict: "passed" },
    });
    await metrics.record(context, {
      name: "assurance_verdict_total",
      value: 1,
      dimensions: { profileFamily: "software-change", verdict: "passed" },
    });
    await metrics.record(context, {
      name: "assurance_criterion_total",
      value: 1,
      dimensions: { method: "test", status: "passed" },
    });
    await metrics.record(context, {
      name: "assurance_finding_total",
      value: 1,
      dimensions: { category: "security", severity: "major" },
    });
    await metrics.record(context, {
      name: "assurance_check_total",
      value: 1,
      dimensions: { kind: "command", status: "passed" },
    });
    await metrics.record(context, {
      name: "assurance_blocked_total",
      value: 1,
      dimensions: { reason: "evidence" },
    });
    await metrics.record(context, {
      name: "assurance_recovery_total",
      value: 1,
      dimensions: { result: "projected" },
    });

    expect(await metrics.aggregate(context)).toEqual([
      { name: "assurance_blocked_total", dimensions: { reason: "evidence" }, value: 1 },
      { name: "assurance_check_total", dimensions: { kind: "command", status: "passed" }, value: 1 },
      { name: "assurance_criterion_total", dimensions: { method: "test", status: "passed" }, value: 1 },
      { name: "assurance_finding_total", dimensions: { category: "security", severity: "major" }, value: 1 },
      {
        name: "assurance_recovery_total",
        dimensions: { result: "projected" },
        value: 1,
      },
      {
        name: "assurance_run_duration_ms",
        dimensions: { profileFamily: "software-change", verdict: "passed" },
        value: 120,
      },
      {
        name: "assurance_verdict_total",
        dimensions: { profileFamily: "software-change", verdict: "passed" },
        value: 1,
      },
    ]);
  });

  it("조직·Work·run·criterion·path·tool·agent·user·model과 사용자 profile을 dimension으로 거부한다", async () => {
    for (const key of [
      "organizationId",
      "workId",
      "runId",
      "criterionId",
      "path",
      "tool",
      "agent",
      "user",
      "model",
      "profileId",
    ]) {
      await expect(
        metrics.record(context, {
          name: "assurance_recovery_total",
          value: 1,
          dimensions: { result: "resumed", [key]: "identifier" },
        }),
      ).rejects.toThrow("low-cardinality");
    }
  });

  it("같은 idempotency key의 metric은 한 번만 기록하고 payload 충돌을 거부한다", async () => {
    const input = {
      name: "assurance_recovery_total",
      value: 1,
      dimensions: { result: "blocked" },
    } as const;
    await metrics.recordOnce(context, "recovery:one", input);
    await metrics.recordOnce(context, "recovery:one", input);
    expect(await metrics.aggregate(context)).toEqual([
      { name: "assurance_recovery_total", dimensions: { result: "blocked" }, value: 1 },
    ]);
    await expect(
      metrics.recordOnce(context, "recovery:one", {
        ...input,
        dimensions: { result: "projected" },
      }),
    ).rejects.toThrow("다른 Assurance metric");
    const [records] = await database.query<[{ metric_event_id: string }[]]>(
      "SELECT metric_event_id FROM assurance_metric_event WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );
    await expect(
      database.query("UPDATE assurance_metric_event SET numeric_value = 2 WHERE metric_event_id = $metric_event_id;", {
        metric_event_id: records[0]?.metric_event_id,
      }),
    ).rejects.toThrow("immutable");
  });
});
