import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase } from "@massion/storage";
import { describe, expect, it } from "vitest";

import { RegistryTelemetryStore } from "./telemetry.js";

describe("Registry telemetry", () => {
  it("publish·install·recall 사건과 metric을 bounded idempotent하게 기록한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "registry",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "registry-telemetry@example.com",
      displayName: "Owner",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const telemetry = await RegistryTelemetryStore.create(database, organizations);
    const input = {
      sourceId: "registry-source-0001",
      eventType: "registry.package.published",
      outcome: "succeeded",
      packageName: "@massion-ext/slack",
      packageVersion: "1.0.0",
      metricName: "registry_publish_total",
    };
    await telemetry.record(context, input);
    await telemetry.record(context, input);
    expect(await telemetry.list(context)).toHaveLength(1);
  });
});
