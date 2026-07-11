import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase } from "@massion/storage";
import { describe, expect, it } from "vitest";

import { ApplicationMetricStore } from "./metrics.js";
import { APPLICATION_METRIC_MIGRATION } from "./schema.js";

describe("ApplicationMetricStore", () => {
  it("저카디널리티 dimension만 멱등 기록하고 조직별 집계한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "metric@example.com", displayName: "Metric" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const metrics = await ApplicationMetricStore.create(database, organizations);
    const input = {
      name: "application_command_total" as const,
      value: 1,
      dimensions: { operationClass: "run", result: "succeeded" },
    };
    await metrics.recordOnce(context, "command:1", input);
    await metrics.recordOnce(context, "command:1", input);
    await expect(metrics.aggregate(context, input.name)).resolves.toEqual([{ dimensions: input.dimensions, value: 1 }]);
    await expect(
      metrics.recordOnce(context, "command:2", {
        ...input,
        dimensions: { operationClass: "run", result: "succeeded", workId: "secret-id" },
      }),
    ).rejects.toThrow("dimension");
    expect(APPLICATION_METRIC_MIGRATION.id).toBe("0070-application-metric");
  });
});
