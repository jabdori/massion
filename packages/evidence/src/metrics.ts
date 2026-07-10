import { randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import type { IndexMode, IndexVersionStatus } from "./contracts.js";
import { EVIDENCE_METRIC_MIGRATION } from "./schema.js";

export interface EvidenceMetricSnapshot {
  readonly indexTotal: Readonly<Record<IndexMode, number>>;
  readonly indexStatusTotal: Readonly<Record<"complete" | "partial" | "failed", number>>;
  readonly indexDurationMs: { readonly count: number; readonly total: number; readonly maximum: number };
  readonly fileResultTotal: Readonly<Record<"complete" | "partial", number>>;
  readonly parseErrorTotal: number;
  readonly incrementalChangeTotal: { readonly staged: number; readonly reused: number };
  readonly reconciliationDriftTotal: number;
  readonly staleTotal: Readonly<Record<"fresh" | "stale_warning" | "reindex_required" | "blocked", number>>;
  readonly searchTotal: Readonly<Record<"lexical" | "hybrid" | "lexical_fallback", number>>;
}

interface MetricRecord {
  readonly metric_name: string;
  readonly dimensions_json: string;
  readonly value: number;
}

type EmptyDimensions = Readonly<Record<string, never>>;

type MetricInput =
  | {
      readonly name: "index";
      readonly dimensions: { readonly mode: IndexMode; readonly status: string };
      readonly value: 1;
    }
  | { readonly name: "index_duration_ms"; readonly dimensions: EmptyDimensions; readonly value: number }
  | {
      readonly name: "file_result";
      readonly dimensions: { readonly status: "complete" | "partial" };
      readonly value: number;
    }
  | { readonly name: "parse_error"; readonly dimensions: EmptyDimensions; readonly value: number }
  | {
      readonly name: "incremental_change";
      readonly dimensions: { readonly kind: "staged" | "reused" };
      readonly value: number;
    }
  | { readonly name: "reconciliation_drift"; readonly dimensions: EmptyDimensions; readonly value: number }
  | {
      readonly name: "stale";
      readonly dimensions: { readonly status: "fresh" | "stale_warning" | "reindex_required" | "blocked" };
      readonly value: 1;
    }
  | {
      readonly name: "search";
      readonly dimensions: { readonly mode: "lexical" | "hybrid" | "lexical_fallback" };
      readonly value: 1;
    };

export class EvidenceMetrics {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(database: MassionDatabase, organizations: OrganizationService): Promise<EvidenceMetrics> {
    await applyMigrations(database, [EVIDENCE_METRIC_MIGRATION]);
    return new EvidenceMetrics(database, organizations);
  }

  public async recordIndex(
    context: TenantContext,
    input: {
      readonly mode: IndexMode;
      readonly status: Extract<IndexVersionStatus, "complete" | "partial" | "failed">;
      readonly durationMs: number;
      readonly files: Readonly<Record<"complete" | "partial", number>>;
      readonly parseErrors: number;
      readonly staged: number;
      readonly reused: number;
      readonly reconciliationDrift: number;
    },
  ): Promise<void> {
    const metrics: MetricInput[] = [
      { name: "index", dimensions: { mode: input.mode, status: input.status }, value: 1 },
      { name: "index_duration_ms", dimensions: {}, value: input.durationMs },
      { name: "file_result", dimensions: { status: "complete" }, value: input.files.complete },
      { name: "file_result", dimensions: { status: "partial" }, value: input.files.partial },
      { name: "parse_error", dimensions: {}, value: input.parseErrors },
      { name: "incremental_change", dimensions: { kind: "staged" }, value: input.staged },
      { name: "incremental_change", dimensions: { kind: "reused" }, value: input.reused },
      { name: "reconciliation_drift", dimensions: {}, value: input.reconciliationDrift },
    ];
    await this.record(context, metrics);
  }

  public async recordSearch(context: TenantContext, mode: "lexical" | "hybrid" | "lexical_fallback"): Promise<void> {
    await this.record(context, [{ name: "search", dimensions: { mode }, value: 1 }]);
  }

  public async recordFreshness(
    context: TenantContext,
    status: "fresh" | "stale_warning" | "reindex_required" | "blocked",
  ): Promise<void> {
    await this.record(context, [{ name: "stale", dimensions: { status }, value: 1 }]);
  }

  public async read(context: TenantContext): Promise<EvidenceMetricSnapshot> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[MetricRecord[]]>(
      "SELECT metric_name, dimensions_json, value FROM evidence_metric_event WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );
    const indexTotal = { full: 0, incremental: 0, reconcile: 0 };
    const indexStatusTotal = { complete: 0, partial: 0, failed: 0 };
    const indexDurationMs = { count: 0, total: 0, maximum: 0 };
    const fileResultTotal = { complete: 0, partial: 0 };
    let parseErrorTotal = 0;
    const incrementalChangeTotal = { staged: 0, reused: 0 };
    let reconciliationDriftTotal = 0;
    const staleTotal = { fresh: 0, stale_warning: 0, reindex_required: 0, blocked: 0 };
    const searchTotal = { lexical: 0, hybrid: 0, lexical_fallback: 0 };
    for (const record of records) {
      const dimensions = JSON.parse(record.dimensions_json) as Record<string, string>;
      if (record.metric_name === "index") {
        indexTotal[dimensions.mode as IndexMode] += record.value;
        indexStatusTotal[dimensions.status as "complete" | "partial" | "failed"] += record.value;
      } else if (record.metric_name === "index_duration_ms") {
        indexDurationMs.count += 1;
        indexDurationMs.total += record.value;
        indexDurationMs.maximum = Math.max(indexDurationMs.maximum, record.value);
      } else if (record.metric_name === "file_result") {
        fileResultTotal[dimensions.status as "complete" | "partial"] += record.value;
      } else if (record.metric_name === "parse_error") parseErrorTotal += record.value;
      else if (record.metric_name === "incremental_change")
        incrementalChangeTotal[dimensions.kind as "staged" | "reused"] += record.value;
      else if (record.metric_name === "reconciliation_drift") reconciliationDriftTotal += record.value;
      else if (record.metric_name === "stale")
        staleTotal[dimensions.status as keyof EvidenceMetricSnapshot["staleTotal"]] += record.value;
      else if (record.metric_name === "search")
        searchTotal[dimensions.mode as keyof EvidenceMetricSnapshot["searchTotal"]] += record.value;
    }
    return {
      indexTotal,
      indexStatusTotal,
      indexDurationMs,
      fileResultTotal,
      parseErrorTotal,
      incrementalChangeTotal,
      reconciliationDriftTotal,
      staleTotal,
      searchTotal,
    };
  }

  private async record(context: TenantContext, metrics: readonly MetricInput[]): Promise<void> {
    await this.organizations.verifyTenantContext(context);
    for (const metric of metrics) {
      if (!Number.isFinite(metric.value) || metric.value < 0) throw new Error("Evidence metric 값이 잘못됐습니다");
    }
    await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      for (const metric of metrics) await this.insert(tx, context.organizationId, metric);
    });
  }

  private async insert(executor: QueryExecutor, organizationId: string, metric: MetricInput): Promise<void> {
    await executor.query(
      "CREATE evidence_metric_event CONTENT { metric_event_id: $metric_event_id, organization_id: $organization_id, metric_name: $metric_name, dimensions_json: $dimensions_json, value: $value, occurred_at: time::now() };",
      {
        metric_event_id: randomUUID(),
        organization_id: organizationId,
        metric_name: metric.name,
        dimensions_json: JSON.stringify(metric.dimensions),
        value: metric.value,
      },
    );
  }
}
