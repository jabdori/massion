export type RecordsMetricName =
  | "records_run_duration_ms"
  | "records_run_total"
  | "records_document_total"
  | "documentation_impact_total"
  | "records_blocked_total"
  | "records_recovery_total";

export interface RecordRecordsMetricInput {
  readonly name: RecordsMetricName;
  readonly value: number;
  readonly dimensions: Readonly<Record<string, string>>;
}

interface MetricRecord {
  readonly metric_event_id?: string;
  readonly metric_name: RecordsMetricName;
  readonly dimensions_json: string;
  readonly numeric_value: number;
}

const RESULTS = new Set(["completed", "blocked", "cancelled", "failed"]);
const DOCUMENT_KINDS = new Set(["adr", "changelog", "runbook"]);
const RECOVERY_RESULTS = new Set(["resumed", "blocked", "terminal-unchanged"]);
const POLICIES: Readonly<Record<RecordsMetricName, Readonly<Record<string, ReadonlySet<string>>>>> = {
  records_run_duration_ms: { result: RESULTS },
  records_run_total: { result: RESULTS },
  records_document_total: { kind: DOCUMENT_KINDS },
  documentation_impact_total: {
    kind: new Set(["work-record", "adr", "changelog", "runbook"]),
    outcome: new Set(["required", "not-applicable"]),
  },
  records_blocked_total: {
    reason: new Set(["integrity", "source", "render", "projection", "recovery", "unknown"]),
  },
  records_recovery_total: { result: RECOVERY_RESULTS },
};

export function validateRecordsMetric(input: RecordRecordsMetricInput): void {
  if (!Number.isFinite(input.value) || input.value < 0) throw new Error("Metric value는 0 이상인 유한한 수여야 합니다");
  const policy = (POLICIES as Partial<Record<string, Readonly<Record<string, ReadonlySet<string>>>>>)[input.name];
  if (!policy) throw new Error("지원하지 않는 Records metric 이름입니다");
  const actual = Object.keys(input.dimensions).sort();
  const expected = Object.keys(policy).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Records metric dimension 집합이 allowlist와 다릅니다");
  }
  for (const [name, values] of Object.entries(policy)) {
    const value = input.dimensions[name];
    if (value === undefined || !values.has(value))
      throw new Error(`Records metric ${name} dimension 값이 허용되지 않습니다`);
  }
}

function canonicalDimensions(dimensions: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(dimensions).sort(([left], [right]) => left.localeCompare(right))),
  );
}

export class RecordsMetricStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
  ): Promise<RecordsMetricStore> {
    await applyMigrations(database, [RECORDS_DOCUMENTATION_MIGRATION, RECORDS_RECOVERY_METRIC_MIGRATION]);
    return new RecordsMetricStore(database, organizations);
  }

  public async recordOnce(context: TenantContext, key: string, input: RecordRecordsMetricInput): Promise<void> {
    await this.organizations.verifyTenantContext(context);
    if (!key.trim() || key.length > 500) throw new Error("Records metric idempotency key가 필요합니다");
    validateRecordsMetric(input);
    const metricEventId = createHash("sha256").update(`${context.organizationId}:${key.trim()}`).digest("hex");
    const dimensionsJson = canonicalDimensions(input.dimensions);
    await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const [records] = await transaction.query<[MetricRecord[]]>(
        "SELECT metric_event_id, metric_name, dimensions_json, numeric_value FROM records_metric_event WHERE organization_id = $organization_id AND metric_event_id = $metric_event_id LIMIT 1;",
        { organization_id: context.organizationId, metric_event_id: metricEventId },
      );
      const existing = records[0];
      if (existing) {
        if (
          existing.metric_name !== input.name ||
          existing.dimensions_json !== dimensionsJson ||
          existing.numeric_value !== input.value
        ) {
          throw new Error("같은 idempotency key에 다른 Records metric을 기록할 수 없습니다");
        }
        return;
      }
      await this.insert(transaction, context.organizationId, metricEventId, input, dimensionsJson);
    });
  }

  public async aggregate(context: TenantContext): Promise<readonly RecordRecordsMetricInput[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[MetricRecord[]]>(
      "SELECT metric_name, dimensions_json, numeric_value FROM records_metric_event WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );
    const totals = new Map<string, RecordRecordsMetricInput>();
    for (const record of records) {
      const key = `${record.metric_name}:${record.dimensions_json}`;
      const current = totals.get(key);
      const dimensions = JSON.parse(record.dimensions_json) as Record<string, string>;
      totals.set(key, {
        name: record.metric_name,
        dimensions,
        value: (current?.value ?? 0) + record.numeric_value,
      });
    }
    return [...totals.values()].sort((left, right) =>
      `${left.name}:${canonicalDimensions(left.dimensions)}`.localeCompare(
        `${right.name}:${canonicalDimensions(right.dimensions)}`,
      ),
    );
  }

  private async insert(
    executor: QueryExecutor,
    organizationId: string,
    metricEventId: string,
    input: RecordRecordsMetricInput,
    dimensionsJson: string,
  ): Promise<void> {
    await executor.query(
      "CREATE records_metric_event CONTENT { metric_event_id: $metric_event_id, organization_id: $organization_id, metric_name: $metric_name, dimensions_json: $dimensions_json, numeric_value: $numeric_value, occurred_at: time::now() };",
      {
        metric_event_id: metricEventId,
        organization_id: organizationId,
        metric_name: input.name,
        dimensions_json: dimensionsJson,
        numeric_value: input.value,
      },
    );
  }
}
import { createHash } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { RECORDS_DOCUMENTATION_MIGRATION, RECORDS_RECOVERY_METRIC_MIGRATION } from "./schema.js";
