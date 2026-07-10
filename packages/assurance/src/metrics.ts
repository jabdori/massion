import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { ASSURANCE_RECOVERY_METRIC_MIGRATION } from "./schema.js";

export type AssuranceMetricName =
  | "assurance_run_duration_ms"
  | "assurance_verdict_total"
  | "assurance_criterion_total"
  | "assurance_finding_total"
  | "assurance_check_total"
  | "assurance_blocked_total"
  | "assurance_recovery_total";

export type AssuranceRecoveryMetricResult =
  "resumed" | "resume_required" | "blocked" | "projected" | "terminal_unchanged";

type DimensionPolicy = Readonly<Record<string, ReadonlySet<string>>>;

const VERDICTS = new Set(["passed", "failed", "blocked", "cancelled"]);
const PROFILE_FAMILIES = new Set(["acceptance", "software-change", "custom"]);
const DIMENSION_VALUES: Readonly<Record<AssuranceMetricName, DimensionPolicy>> = {
  assurance_run_duration_ms: { profileFamily: PROFILE_FAMILIES, verdict: VERDICTS },
  assurance_verdict_total: { profileFamily: PROFILE_FAMILIES, verdict: VERDICTS },
  assurance_criterion_total: {
    method: new Set(["test", "inspection", "evidence", "metric", "human"]),
    status: new Set(["pending", "passed", "failed", "blocked", "excluded"]),
  },
  assurance_finding_total: {
    category: new Set(["correctness", "security", "reliability", "operability", "supply-chain"]),
    severity: new Set(["critical", "major", "minor", "info"]),
  },
  assurance_check_total: {
    kind: new Set(["command", "inspection", "evidence", "metric", "human"]),
    status: new Set(["pending", "running", "passed", "failed", "blocked", "cancelled"]),
  },
  assurance_blocked_total: {
    reason: new Set(["integrity", "evidence", "model", "timeout", "output_limit", "recovery", "unknown"]),
  },
  assurance_recovery_total: {
    result: new Set<AssuranceRecoveryMetricResult>([
      "resumed",
      "resume_required",
      "blocked",
      "projected",
      "terminal_unchanged",
    ]),
  },
};

interface MetricRecord {
  readonly metric_event_id?: string;
  readonly metric_name: AssuranceMetricName;
  readonly dimensions_json: string;
  readonly numeric_value: number;
}

interface RunMetricRecord {
  readonly assurance_run_id: string;
  readonly profile_id: string;
  readonly status: "passed" | "failed" | "blocked" | "cancelled";
  readonly failure_json?: string;
  readonly started_at: unknown;
  readonly completed_at: unknown;
}

interface CriterionMetricRecord {
  readonly criterion_id: string;
  readonly method: string;
  readonly status: string;
}

interface CheckMetricRecord {
  readonly check_id: string;
  readonly kind: string;
  readonly status: string;
}

interface FindingMetricRecord {
  readonly finding_id: string;
  readonly category: string;
  readonly severity: string;
}

export interface RecordAssuranceMetricInput {
  readonly name: AssuranceMetricName;
  readonly value: number;
  readonly dimensions: Readonly<Record<string, string>>;
}

function canonicalDimensions(dimensions: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(dimensions).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function dateMillis(value: unknown, label: string): number {
  if (typeof value === "string") {
    const milliseconds = new Date(value).getTime();
    if (!Number.isNaN(milliseconds)) return milliseconds;
  }
  if (value && typeof value === "object" && "valueOf" in value) {
    const raw = (value as { valueOf(): unknown }).valueOf();
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string") {
      const milliseconds = new Date(raw).getTime();
      if (!Number.isNaN(milliseconds)) return milliseconds;
    }
  }
  if (value && typeof value === "object" && "toISOString" in value) {
    const convert = (value as { readonly toISOString?: unknown }).toISOString;
    if (typeof convert === "function") {
      const milliseconds = new Date(String(convert.call(value))).getTime();
      if (!Number.isNaN(milliseconds)) return milliseconds;
    }
  }
  throw new Error(`${label} 시각이 유효하지 않습니다`);
}

function profileFamily(profileId: string): "acceptance" | "software-change" | "custom" {
  if (profileId === "massion.assurance.acceptance.v1") return "acceptance";
  if (profileId === "massion.assurance.software-change.v1") return "software-change";
  return "custom";
}

function blockedReason(failureJson: string | undefined): string {
  let category: string;
  try {
    const rawCategory = failureJson ? (JSON.parse(failureJson) as { category?: unknown }).category : undefined;
    category = typeof rawCategory === "string" ? rawCategory : "";
  } catch {
    return "unknown";
  }
  if (category.includes("integrity")) return "integrity";
  if (category.includes("evidence")) return "evidence";
  if (category.includes("model")) return "model";
  if (category.includes("timeout")) return "timeout";
  if (category.includes("output_limit")) return "output_limit";
  if (category.includes("recovery")) return "recovery";
  return "unknown";
}

export class AssuranceMetricStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
  ): Promise<AssuranceMetricStore> {
    await applyMigrations(database, [ASSURANCE_RECOVERY_METRIC_MIGRATION]);
    return new AssuranceMetricStore(database, organizations);
  }

  public async record(context: TenantContext, input: RecordAssuranceMetricInput): Promise<void> {
    await this.organizations.verifyTenantContext(context);
    this.validate(input);
    const metricEventId = createHash("sha256").update(randomUUID()).digest("hex");
    await this.insert(context.organizationId, metricEventId, input);
  }

  public async recordOnce(context: TenantContext, key: string, input: RecordAssuranceMetricInput): Promise<void> {
    await this.organizations.verifyTenantContext(context);
    if (!key.trim() || key.length > 500) throw new Error("Assurance metric idempotency key가 필요합니다");
    this.validate(input);
    const metricEventId = createHash("sha256").update(`${context.organizationId}:${key.trim()}`).digest("hex");
    await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const [records] = await transaction.query<[MetricRecord[]]>(
        "SELECT metric_event_id, metric_name, dimensions_json, numeric_value FROM assurance_metric_event WHERE organization_id = $organization_id AND metric_event_id = $metric_event_id LIMIT 1;",
        { organization_id: context.organizationId, metric_event_id: metricEventId },
      );
      const existing = records[0];
      const dimensionsJson = canonicalDimensions(input.dimensions);
      if (existing) {
        if (
          existing.metric_name !== input.name ||
          existing.dimensions_json !== dimensionsJson ||
          existing.numeric_value !== input.value
        ) {
          throw new Error("같은 idempotency key에 다른 Assurance metric을 기록할 수 없습니다");
        }
        return;
      }
      await this.insert(context.organizationId, metricEventId, input, transaction);
    });
  }

  public async aggregate(context: TenantContext): Promise<
    readonly {
      readonly name: AssuranceMetricName;
      readonly dimensions: Record<string, string>;
      readonly value: number;
    }[]
  > {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[MetricRecord[]]>(
      "SELECT metric_name, dimensions_json, numeric_value FROM assurance_metric_event WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );
    const totals = new Map<string, { name: AssuranceMetricName; dimensions: Record<string, string>; value: number }>();
    for (const record of records) {
      const key = `${record.metric_name}:${record.dimensions_json}`;
      const current = totals.get(key);
      if (current) current.value += record.numeric_value;
      else {
        totals.set(key, {
          name: record.metric_name,
          dimensions: JSON.parse(record.dimensions_json) as Record<string, string>,
          value: record.numeric_value,
        });
      }
    }
    return [...totals.values()].sort((left, right) =>
      `${left.name}:${canonicalDimensions(left.dimensions)}`.localeCompare(
        `${right.name}:${canonicalDimensions(right.dimensions)}`,
      ),
    );
  }

  public async recordRun(context: TenantContext, assuranceRunId: string): Promise<void> {
    await this.organizations.verifyTenantContext(context);
    if (!assuranceRunId.trim() || assuranceRunId.length > 200) throw new Error("Assurance metric run ID가 필요합니다");
    const parameters = { organization_id: context.organizationId, assurance_run_id: assuranceRunId };
    const [runs] = await this.database.query<[RunMetricRecord[]]>(
      "SELECT assurance_run_id, profile_id, status, failure_json, started_at, completed_at FROM assurance_run WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id AND status IN ['passed', 'failed', 'blocked', 'cancelled'] LIMIT 1;",
      parameters,
    );
    const run = runs[0];
    if (!run) throw new Error("Terminal Assurance run metric source를 찾을 수 없습니다");
    const [criteria] = await this.database.query<[CriterionMetricRecord[]]>(
      "SELECT criterion_id, method, status FROM assurance_criterion WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id;",
      parameters,
    );
    const [checks] = await this.database.query<[CheckMetricRecord[]]>(
      "SELECT check_id, kind, status FROM assurance_check WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id;",
      parameters,
    );
    const [findings] = await this.database.query<[FindingMetricRecord[]]>(
      "SELECT finding_id, category, severity FROM assurance_finding WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id;",
      parameters,
    );
    const family = profileFamily(run.profile_id);
    const duration = Math.max(
      0,
      dateMillis(run.completed_at, "Assurance 완료") - dateMillis(run.started_at, "Assurance 시작"),
    );
    await this.recordOnce(context, `run:${assuranceRunId}:duration`, {
      name: "assurance_run_duration_ms",
      value: duration,
      dimensions: { profileFamily: family, verdict: run.status },
    });
    await this.recordOnce(context, `run:${assuranceRunId}:verdict`, {
      name: "assurance_verdict_total",
      value: 1,
      dimensions: { profileFamily: family, verdict: run.status },
    });
    for (const criterion of criteria) {
      await this.recordOnce(context, `run:${assuranceRunId}:criterion:${criterion.criterion_id}`, {
        name: "assurance_criterion_total",
        value: 1,
        dimensions: { method: criterion.method, status: criterion.status },
      });
    }
    for (const check of checks) {
      await this.recordOnce(context, `run:${assuranceRunId}:check:${check.check_id}`, {
        name: "assurance_check_total",
        value: 1,
        dimensions: { kind: check.kind, status: check.status },
      });
    }
    for (const finding of findings) {
      await this.recordOnce(context, `run:${assuranceRunId}:finding:${finding.finding_id}`, {
        name: "assurance_finding_total",
        value: 1,
        dimensions: { category: finding.category, severity: finding.severity },
      });
    }
    if (run.status === "blocked") {
      await this.recordOnce(context, `run:${assuranceRunId}:blocked`, {
        name: "assurance_blocked_total",
        value: 1,
        dimensions: { reason: blockedReason(run.failure_json) },
      });
    }
  }

  private validate(input: RecordAssuranceMetricInput): void {
    if (!Number.isFinite(input.value) || input.value < 0) throw new Error("Assurance metric 값이 잘못됐습니다");
    const policy = (DIMENSION_VALUES as Partial<Record<string, DimensionPolicy>>)[input.name];
    if (!policy) throw new Error("Assurance metric 이름이 허용 목록에 없습니다");
    const entries = Object.entries(input.dimensions);
    if (entries.length !== Object.keys(policy).length || entries.some(([key, value]) => !policy[key]?.has(value))) {
      throw new Error("Assurance metric dimension이 low-cardinality policy와 다릅니다");
    }
  }

  private async insert(
    organizationId: string,
    metricEventId: string,
    input: RecordAssuranceMetricInput,
    executor: QueryExecutor = this.database,
  ): Promise<void> {
    await executor.query(
      "CREATE assurance_metric_event CONTENT { metric_event_id: $metric_event_id, organization_id: $organization_id, metric_name: $metric_name, dimensions_json: $dimensions_json, numeric_value: $numeric_value, occurred_at: time::now() };",
      {
        metric_event_id: metricEventId,
        organization_id: organizationId,
        metric_name: input.name,
        dimensions_json: canonicalDimensions(input.dimensions),
        numeric_value: input.value,
      },
    );
  }
}
