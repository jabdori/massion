import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { SOFTWARE_ENGINEERING_METRIC_MIGRATION } from "./schema.js";

export type EngineeringMetricName =
  | "engineering_delivery_duration_ms"
  | "engineering_delivery_status_total"
  | "engineering_red_failure_total"
  | "engineering_command_timeout_total"
  | "engineering_file_change_total"
  | "engineering_recovery_total";

type MetricDimensionPolicy = Readonly<Record<string, ReadonlySet<string>>>;

const DIMENSION_VALUES: Readonly<Record<EngineeringMetricName, MetricDimensionPolicy>> = {
  engineering_delivery_duration_ms: {
    status: new Set(["committed", "failed", "cancelled"]),
  },
  engineering_delivery_status_total: {
    status: new Set(["committed", "failed", "cancelled"]),
  },
  engineering_red_failure_total: {
    category: new Set(["false_red", "marker_mismatch", "timeout", "signal", "output_limit", "credential"]),
  },
  engineering_command_timeout_total: {
    stage: new Set(["red", "green", "validation"]),
  },
  engineering_file_change_total: {
    kind: new Set(["added", "modified", "deleted", "renamed"]),
    test: new Set(["true", "false"]),
  },
  engineering_recovery_total: {
    result: new Set(["reconciled_commit", "resumed", "resume_required", "cleaned_terminal", "finalized"]),
  },
};

interface MetricRecord {
  readonly metric_event_id?: string;
  readonly metric_name: EngineeringMetricName;
  readonly dimensions_json: string;
  readonly value: number;
}

function canonicalDimensions(dimensions: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(dimensions).sort(([left], [right]) => left.localeCompare(right))),
  );
}

export class EngineeringMetricStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
  ): Promise<EngineeringMetricStore> {
    await applyMigrations(database, [SOFTWARE_ENGINEERING_METRIC_MIGRATION]);
    return new EngineeringMetricStore(database, organizations);
  }

  public async record(
    context: TenantContext,
    input: {
      readonly name: EngineeringMetricName;
      readonly value: number;
      readonly dimensions: Readonly<Record<string, string>>;
    },
  ): Promise<void> {
    await this.organizations.verifyTenantContext(context);
    this.validate(input);
    await this.insert(context.organizationId, randomUUID(), input);
  }

  public async recordOnce(
    context: TenantContext,
    key: string,
    input: {
      readonly name: EngineeringMetricName;
      readonly value: number;
      readonly dimensions: Readonly<Record<string, string>>;
    },
  ): Promise<void> {
    await this.organizations.verifyTenantContext(context);
    if (!key.trim()) throw new Error("Engineering metric idempotency key가 필요합니다");
    this.validate(input);
    const metricEventId = createHash("sha256").update(`${context.organizationId}:${key.trim()}`).digest("hex");
    await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const [records] = await transaction.query<[MetricRecord[]]>(
        "SELECT metric_event_id, metric_name, dimensions_json, value FROM engineering_metric_event WHERE organization_id = $organization_id AND metric_event_id = $metric_event_id LIMIT 1;",
        { organization_id: context.organizationId, metric_event_id: metricEventId },
      );
      const existing = records[0];
      const dimensionsJson = canonicalDimensions(input.dimensions);
      if (existing) {
        if (
          existing.metric_name !== input.name ||
          existing.dimensions_json !== dimensionsJson ||
          existing.value !== input.value
        ) {
          throw new Error("같은 idempotency key에 다른 Engineering metric을 기록할 수 없습니다");
        }
        return;
      }
      await this.insert(context.organizationId, metricEventId, input, transaction);
    });
  }

  private validate(input: {
    readonly name: EngineeringMetricName;
    readonly value: number;
    readonly dimensions: Readonly<Record<string, string>>;
  }): void {
    if (!Number.isFinite(input.value) || input.value < 0) throw new Error("Engineering metric 값이 잘못됐습니다");
    const policy = DIMENSION_VALUES[input.name];
    const entries = Object.entries(input.dimensions);
    if (entries.length !== Object.keys(policy).length || entries.some(([key, value]) => !policy[key]?.has(value))) {
      throw new Error("Engineering metric dimension이 low-cardinality policy와 다릅니다");
    }
  }

  private async insert(
    organizationId: string,
    metricEventId: string,
    input: {
      readonly name: EngineeringMetricName;
      readonly value: number;
      readonly dimensions: Readonly<Record<string, string>>;
    },
    executor: QueryExecutor = this.database,
  ): Promise<void> {
    await executor.query(
      "CREATE engineering_metric_event CONTENT { metric_event_id: $metric_event_id, organization_id: $organization_id, metric_name: $metric_name, dimensions_json: $dimensions_json, value: $value, occurred_at: time::now() };",
      {
        metric_event_id: metricEventId,
        organization_id: organizationId,
        metric_name: input.name,
        dimensions_json: canonicalDimensions(input.dimensions),
        value: input.value,
      },
    );
  }

  public async aggregate(context: TenantContext): Promise<
    readonly {
      readonly name: EngineeringMetricName;
      readonly dimensions: Record<string, string>;
      readonly value: number;
    }[]
  > {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[MetricRecord[]]>(
      "SELECT metric_name, dimensions_json, value FROM engineering_metric_event WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );
    const totals = new Map<
      string,
      { name: EngineeringMetricName; dimensions: Record<string, string>; value: number }
    >();
    for (const record of records) {
      const key = `${record.metric_name}:${record.dimensions_json}`;
      const current = totals.get(key);
      if (current) current.value += record.value;
      else {
        totals.set(key, {
          name: record.metric_name,
          dimensions: JSON.parse(record.dimensions_json) as Record<string, string>,
          value: record.value,
        });
      }
    }
    return [...totals.values()].sort((left, right) =>
      `${left.name}:${canonicalDimensions(left.dimensions)}`.localeCompare(
        `${right.name}:${canonicalDimensions(right.dimensions)}`,
      ),
    );
  }
}
