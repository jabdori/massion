import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExtensionMetrics } from "./metrics.js";

describe("ExtensionMetrics", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let metrics: ExtensionMetrics;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "metric@example.com", displayName: "Metric" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    metrics = await ExtensionMetrics.create(database, organizations);
  });
  afterEach(async () => database.close());

  it("허용된 저카디널리티 metric을 source event별 한 번 기록한다", async () => {
    const input = {
      sourceEventId: "event-1",
      metricName: "extension_recovery_total" as const,
      outcome: "recovered" as const,
      value: 1,
      unit: "count" as const,
    };
    const first = await metrics.record(context, input);
    expect(await metrics.record(context, input)).toEqual(first);
    expect(first).toMatchObject(input);
  });

  it("package·organization·version·error text label과 유효하지 않은 값은 받지 않는다", async () => {
    await expect(
      metrics.record(context, {
        sourceEventId: "event-2",
        metricName: "extension_package_name" as never,
        outcome: "failure",
        value: 1,
        unit: "count",
      }),
    ).rejects.toThrow("metric");
    await expect(
      metrics.record(context, {
        sourceEventId: "event-3",
        metricName: "extension_operation_duration_ms",
        outcome: "success",
        value: Number.NaN,
        unit: "ms",
      }),
    ).rejects.toThrow("finite");
  });
});
