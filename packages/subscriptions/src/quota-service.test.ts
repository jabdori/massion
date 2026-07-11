import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { SubscriptionQuotaService } from "./quota-service.js";

describe("구독 할당량 snapshot과 현재 projection", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let quota: SubscriptionQuotaService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "quota@example.com", displayName: "Quota Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    quota = await SubscriptionQuotaService.create(database, organizations);
    await database.query(
      `CREATE subscription_connector CONTENT {
        connector_id: 'quota-edge', organization_id: $organization_id, owner_user_id: $owner_user_id,
        location: 'edge', execution_kind: 'agent-runtime', protocol: 'massion-connector-v1', version: '1.0.0',
        public_key: 'fixture', capabilities: ['quota'], status: 'ready', created_at: time::now(), updated_at: time::now()
      };
      CREATE subscription_account CONTENT {
        account_id: 'quota-account', organization_id: $organization_id, owner_user_id: $owner_user_id,
        provider_id: 'openai-codex', alias: 'Codex', scope: 'personal', connector_id: 'quota-edge',
        profile_fingerprint: $fingerprint, billing_kind: 'consumer-subscription', status: 'active',
        consent_version: 0, version: 1, created_at: time::now(), updated_at: time::now()
      };`,
      { organization_id: context.organizationId, owner_user_id: context.userId, fingerprint: "b".repeat(64) },
    );
  });

  afterEach(async () => database.close());

  it("복수 window를 정규화하고 append-only snapshot과 현재 projection을 함께 갱신한다", async () => {
    const recorded = await quota.record(context, {
      commandId: randomUUID(),
      accountId: "quota-account",
      windows: [
        {
          kind: "weekly",
          limit: 1_000,
          remaining: 800,
          resetsAt: "2030-01-07T00:00:00.000Z",
          observedAt: "2030-01-01T00:00:00.000Z",
          source: "provider-reported",
          confidence: "reported",
        },
        {
          kind: "five-hour",
          remainingRatio: 0.25,
          resetsAt: "2030-01-01T05:00:00.000Z",
          observedAt: "2030-01-01T00:00:00.000Z",
          source: "provider-reported",
          confidence: "reported",
        },
      ],
    });

    expect(recorded.windows.map((window) => window.kind)).toEqual(["five-hour", "weekly"]);
    expect(recorded.windows[1]?.remainingRatio).toBe(0.8);
    expect(recorded.current).toMatchObject({ minimumRemainingRatio: 0.25, exhausted: false });
    expect(recorded.current.earliestResetAt).toBe("2030-01-01T05:00:00.000Z");
    await expect(quota.current(context, "quota-account")).resolves.toEqual(recorded.current);

    await expect(
      database.query("UPDATE subscription_quota_snapshot SET exhausted = true WHERE account_id = 'quota-account';"),
    ).rejects.toThrow("immutable");
  });

  it("어느 window든 소진되면 계정 전체를 소진 상태로 투영한다", async () => {
    const recorded = await quota.record(context, {
      commandId: randomUUID(),
      accountId: "quota-account",
      windows: [
        {
          kind: "five-hour",
          remainingRatio: 0,
          observedAt: "2030-01-01T00:00:00.000Z",
          source: "provider-reported",
          confidence: "reported",
        },
        {
          kind: "weekly",
          remainingRatio: 0.8,
          observedAt: "2030-01-01T00:00:00.000Z",
          source: "provider-reported",
          confidence: "reported",
        },
      ],
    });

    expect(recorded.current.exhausted).toBe(true);
  });

  it("HTTP 429와 제공자 reset 시각을 파생된 소진 snapshot으로 기록한다", async () => {
    const recorded = await quota.recordRateLimit(context, {
      commandId: randomUUID(),
      accountId: "quota-account",
      observedAt: "2030-01-01T00:00:00.000Z",
      resetsAt: "2030-01-01T00:01:00.000Z",
      source: "http-429",
    });

    expect(recorded.windows).toEqual([
      expect.objectContaining({
        kind: "rate-limit",
        remainingRatio: 0,
        resetsAt: "2030-01-01T00:01:00.000Z",
        confidence: "derived",
      }),
    ]);
    expect(recorded.current.exhausted).toBe(true);
  });

  it("같은 명령은 같은 결과를 반환하고 모순되거나 중복된 window를 거부한다", async () => {
    const commandId = randomUUID();
    const input = {
      commandId,
      accountId: "quota-account",
      windows: [
        {
          kind: "weekly",
          limit: 100,
          remaining: 50,
          observedAt: "2030-01-01T00:00:00.000Z",
          source: "provider-reported",
          confidence: "reported" as const,
        },
      ],
    };
    const onlyWindow = input.windows[0];
    if (!onlyWindow) throw new Error("Quota fixture가 없습니다");
    const first = await quota.record(context, input);
    await expect(quota.record(context, input)).resolves.toEqual(first);
    await expect(quota.record(context, { ...input, windows: [...input.windows, ...input.windows] })).rejects.toThrow(
      "중복",
    );
    await expect(
      quota.record(context, {
        ...input,
        commandId: randomUUID(),
        windows: [{ ...onlyWindow, remainingRatio: 0.9 }],
      }),
    ).rejects.toThrow("일치하지 않습니다");
  });
});
