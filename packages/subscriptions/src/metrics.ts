import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase } from "@massion/storage";

import { listCodingPlanPresets } from "./coding-plan.js";
import { listSubscriptionProviderManifests } from "./provider-catalog.js";
import { SUBSCRIPTION_MIGRATION } from "./schema.js";

export type SubscriptionMetricSample =
  | {
      readonly name: "model_route_attempt_total";
      readonly kind: "counter";
      readonly labels: { readonly status: string; readonly failureClass: string };
      readonly value: number;
    }
  | {
      readonly name: "subscription_quota_remaining_ratio";
      readonly kind: "gauge";
      readonly labels: { readonly provider: string };
      readonly value: number;
    };

interface AccountMetricRecord {
  readonly account_id: string;
  readonly provider_id: string;
}

interface QuotaMetricRecord {
  readonly account_id: string;
  readonly minimum_remaining_ratio?: number;
}

interface AttemptMetricRecord {
  readonly status: string;
  readonly failure_class?: string;
}

const BUILT_IN_PROVIDERS = new Set([
  ...listSubscriptionProviderManifests().map((provider) => provider.id),
  ...listCodingPlanPresets().map((preset) => preset.id),
]);

const ATTEMPT_STATUSES = new Set(["reserved", "succeeded", "failed", "interrupted", "blocked", "cancelled"]);
const FAILURE_CLASSES = new Set([
  "authentication",
  "quota",
  "rate-limit",
  "timeout",
  "provider",
  "network",
  "policy",
  "input",
  "cancelled",
  "unknown",
]);

function boundedStatus(value: string): string {
  return ATTEMPT_STATUSES.has(value) ? value : "other";
}

function boundedFailure(value: string | undefined): string {
  if (value === undefined) return "none";
  return FAILURE_CLASSES.has(value) ? value : "other";
}

function providerLabel(value: string): string {
  return BUILT_IN_PROVIDERS.has(value) ? value : "custom";
}

export class SubscriptionMetrics {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
  ): Promise<SubscriptionMetrics> {
    await applyMigrations(database, [SUBSCRIPTION_MIGRATION]);
    return new SubscriptionMetrics(database, organizations);
  }

  public async read(context: TenantContext): Promise<readonly SubscriptionMetricSample[]> {
    await this.organizations.verifyTenantContext(context);
    const [[accounts], [quota], [attempts]] = await Promise.all([
      this.database.query<[AccountMetricRecord[]]>(
        "SELECT account_id, provider_id FROM subscription_account WHERE organization_id = $organization_id;",
        { organization_id: context.organizationId },
      ),
      this.database.query<[QuotaMetricRecord[]]>(
        "SELECT account_id, minimum_remaining_ratio FROM subscription_quota_current WHERE organization_id = $organization_id;",
        { organization_id: context.organizationId },
      ),
      this.database.query<[AttemptMetricRecord[]]>(
        "SELECT status, failure_class FROM route_attempt WHERE organization_id = $organization_id;",
        { organization_id: context.organizationId },
      ),
    ]);

    const attemptCounts = new Map<string, { readonly status: string; readonly failureClass: string; value: number }>();
    for (const attempt of attempts) {
      const status = boundedStatus(attempt.status);
      const failureClass = boundedFailure(attempt.failure_class);
      const key = `${status}\0${failureClass}`;
      const current = attemptCounts.get(key);
      if (current) current.value += 1;
      else attemptCounts.set(key, { status, failureClass, value: 1 });
    }
    const attemptSamples: SubscriptionMetricSample[] = [...attemptCounts.values()]
      .sort(
        (left, right) => left.status.localeCompare(right.status) || left.failureClass.localeCompare(right.failureClass),
      )
      .map((entry) => ({
        name: "model_route_attempt_total",
        kind: "counter",
        labels: { failureClass: entry.failureClass, status: entry.status },
        value: entry.value,
      }));

    const providerByAccount = new Map(
      accounts.map((account) => [account.account_id, providerLabel(account.provider_id)]),
    );
    const minimumRatioByProvider = new Map<string, number>();
    for (const current of quota) {
      const provider = providerByAccount.get(current.account_id);
      const ratio = current.minimum_remaining_ratio;
      if (!provider || ratio === undefined || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) continue;
      minimumRatioByProvider.set(provider, Math.min(minimumRatioByProvider.get(provider) ?? 1, ratio));
    }
    const quotaSamples: SubscriptionMetricSample[] = [...minimumRatioByProvider.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, value]) => ({
        name: "subscription_quota_remaining_ratio",
        kind: "gauge",
        labels: { provider },
        value,
      }));

    return [...attemptSamples, ...quotaSamples];
  }
}
