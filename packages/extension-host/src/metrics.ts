import { randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase } from "@massion/storage";

import { EXTENSION_RECOVERY_METRIC_MIGRATION } from "./schema.js";

const METRICS = new Set([
  "extension_worker_start_total",
  "extension_worker_stop_total",
  "extension_invocation_total",
  "extension_protocol_violation_total",
  "extension_activation_total",
  "extension_rollback_total",
  "extension_sandbox_unavailable_total",
  "extension_recovery_total",
  "extension_operation_duration_ms",
]);
const OUTCOMES = new Set(["success", "failure", "blocked", "recovered", "quarantined", "timeout"]);

export type ExtensionMetricName =
  | "extension_worker_start_total"
  | "extension_worker_stop_total"
  | "extension_invocation_total"
  | "extension_protocol_violation_total"
  | "extension_activation_total"
  | "extension_rollback_total"
  | "extension_sandbox_unavailable_total"
  | "extension_recovery_total"
  | "extension_operation_duration_ms";
export type ExtensionMetricOutcome = "success" | "failure" | "blocked" | "recovered" | "quarantined" | "timeout";

interface MetricRecord {
  readonly metric_id: string;
  readonly organization_id: string;
  readonly source_event_id: string;
  readonly metric_name: ExtensionMetricName;
  readonly outcome: ExtensionMetricOutcome;
  readonly value: number;
  readonly unit: "count" | "ms";
}

export interface ExtensionMetricView {
  readonly metricId: string;
  readonly organizationId: string;
  readonly sourceEventId: string;
  readonly metricName: ExtensionMetricName;
  readonly outcome: ExtensionMetricOutcome;
  readonly value: number;
  readonly unit: "count" | "ms";
}

export class ExtensionMetrics {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(database: MassionDatabase, organizations: OrganizationService): Promise<ExtensionMetrics> {
    await applyMigrations(database, [EXTENSION_RECOVERY_METRIC_MIGRATION]);
    return new ExtensionMetrics(database, organizations);
  }

  public async record(
    context: TenantContext,
    input: {
      readonly sourceEventId: string;
      readonly metricName: ExtensionMetricName;
      readonly outcome: ExtensionMetricOutcome;
      readonly value: number;
      readonly unit: "count" | "ms";
    },
  ): Promise<ExtensionMetricView> {
    await this.organizations.verifyTenantContext(context);
    if (!METRICS.has(input.metricName)) throw new Error("허용되지 않은 Extension metric name입니다");
    if (!OUTCOMES.has(input.outcome)) throw new Error("허용되지 않은 Extension metric outcome입니다");
    if (!Number.isFinite(input.value) || input.value < 0)
      throw new Error("Extension metric value는 finite 양수여야 합니다");
    if (
      (input.metricName.endsWith("_ms") && input.unit !== "ms") ||
      (!input.metricName.endsWith("_ms") && input.unit !== "count")
    ) {
      throw new Error("Extension metric unit이 name과 일치하지 않습니다");
    }
    const [existing] = await this.database.query<[MetricRecord[]]>(
      "SELECT * OMIT id FROM extension_recovery_metric WHERE organization_id = $organization_id AND source_event_id = $source_event_id AND metric_name = $metric_name LIMIT 1;",
      {
        organization_id: context.organizationId,
        source_event_id: input.sourceEventId,
        metric_name: input.metricName,
      },
    );
    if (existing[0]) {
      if (
        existing[0].outcome !== input.outcome ||
        existing[0].value !== input.value ||
        existing[0].unit !== input.unit
      ) {
        throw new Error("같은 source event에 다른 Extension metric을 기록할 수 없습니다");
      }
      return this.view(existing[0]);
    }
    const metricId = randomUUID();
    const [created] = await this.database.query<[MetricRecord[]]>(
      "CREATE extension_recovery_metric CONTENT { metric_id: $metric_id, organization_id: $organization_id, source_event_id: $source_event_id, metric_name: $metric_name, outcome: $outcome, value: $value, unit: $unit, created_at: time::now() } RETURN AFTER;",
      {
        metric_id: metricId,
        organization_id: context.organizationId,
        source_event_id: input.sourceEventId,
        metric_name: input.metricName,
        outcome: input.outcome,
        value: input.value,
        unit: input.unit,
      },
    );
    if (!created[0]) throw new Error("Extension metric 생성 결과가 없습니다");
    return this.view(created[0]);
  }

  private view(record: MetricRecord): ExtensionMetricView {
    return {
      metricId: record.metric_id,
      organizationId: record.organization_id,
      sourceEventId: record.source_event_id,
      metricName: record.metric_name,
      outcome: record.outcome,
      value: record.value,
      unit: record.unit,
    };
  }
}
