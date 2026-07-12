import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { SubscriptionMetrics } from "./metrics.js";
import { SubscriptionQuotaService } from "./quota-service.js";

describe("구독·라우팅 event-derived metric", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let organizations: OrganizationService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({
      email: "subscription-metrics@example.com",
      displayName: "Metrics",
    });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
  });

  afterEach(async () => database.close());

  it("계정 식별자 없이 provider quota ratio와 route attempt 상태를 집계한다", async () => {
    const metrics = await SubscriptionMetrics.create(database, organizations);
    const quota = await SubscriptionQuotaService.create(database, organizations);
    await database.query(
      `CREATE subscription_connector CONTENT {
         connector_id: 'metric-edge', organization_id: $organization_id, owner_user_id: $owner_user_id,
         location: 'edge', execution_kind: 'agent-runtime', protocol: 'massion-connector-v1', version: '1.0.0',
         public_key: 'fixture', capabilities: ['quota'], status: 'ready', created_at: time::now(), updated_at: time::now()
       };
       CREATE subscription_account CONTENT {
         account_id: 'metric-account-secret', organization_id: $organization_id, owner_user_id: $owner_user_id,
         provider_id: 'openai-codex', alias: 'Metric', scope: 'personal', connector_id: 'metric-edge',
         profile_fingerprint: $fingerprint, billing_kind: 'consumer-subscription', status: 'active',
         consent_version: 0, version: 1, created_at: time::now(), updated_at: time::now()
       };
       CREATE route_attempt CONTENT {
         organization_id: $organization_id, attempt_id: 'attempt-reserved', status: 'reserved'
       };
       CREATE route_attempt CONTENT {
         organization_id: $organization_id, attempt_id: 'attempt-failed', status: 'failed', failure_class: 'rate-limit'
       };
       CREATE route_attempt CONTENT {
         organization_id: $organization_id, attempt_id: 'attempt-succeeded', status: 'succeeded'
       };`,
      { organization_id: context.organizationId, owner_user_id: context.userId, fingerprint: "c".repeat(64) },
    );
    await quota.record(context, {
      commandId: randomUUID(),
      accountId: "metric-account-secret",
      windows: [
        {
          kind: "weekly",
          remainingRatio: 0.75,
          observedAt: "2030-01-01T00:00:00.000Z",
          source: "provider-reported",
          confidence: "reported",
        },
      ],
    });

    const snapshot = await metrics.read(context);

    expect(snapshot).toEqual([
      {
        name: "model_route_attempt_total",
        kind: "counter",
        labels: { failureClass: "rate-limit", status: "failed" },
        value: 1,
      },
      {
        name: "model_route_attempt_total",
        kind: "counter",
        labels: { failureClass: "none", status: "reserved" },
        value: 1,
      },
      {
        name: "model_route_attempt_total",
        kind: "counter",
        labels: { failureClass: "none", status: "succeeded" },
        value: 1,
      },
      {
        name: "subscription_quota_remaining_ratio",
        kind: "gauge",
        labels: { provider: "openai-codex" },
        value: 0.75,
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain(context.organizationId);
    expect(JSON.stringify(snapshot)).not.toContain("metric-account-secret");
  });
});
