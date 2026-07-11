import { randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase } from "@massion/storage";

import { canonicalGrowthJson, growthChecksum } from "./prompt-memory.js";
import { GROWTH_RECOVERY_METRIC_MIGRATION } from "./schema.js";

const DIMENSIONS = {
  growth_trigger_total: ["result"],
  reflection_run_duration_ms: ["result"],
  growth_suggestion_total: ["targetKind", "result"],
  growth_evaluation_total: ["targetKind", "result"],
  growth_adoption_total: ["targetKind", "mode", "result"],
  growth_effect_total: ["targetKind", "result"],
  growth_revert_total: ["targetKind", "result"],
  growth_recovery_total: ["stage", "result"],
} as const;

export type GrowthMetricName = keyof typeof DIMENSIONS;
export interface GrowthMetricInput {
  readonly name: string;
  readonly value: number;
  readonly unit: "count" | "milliseconds";
  readonly dimensions: Readonly<Record<string, string>>;
}
export interface GrowthMetricRecord {
  readonly metric_id: string;
  readonly organization_id: string;
  readonly idempotency_key: string;
  readonly metric_name: GrowthMetricName;
  readonly value: number;
  readonly unit: string;
  readonly dimensions_json: string;
  readonly request_hash: string;
}

export function validateGrowthMetric(
  input: GrowthMetricInput,
): asserts input is GrowthMetricInput & { readonly name: GrowthMetricName } {
  if (!(input.name in DIMENSIONS)) throw new Error("Growth metric allowlist에 없는 이름입니다");
  if (!Number.isFinite(input.value)) throw new Error("Growth metric value는 finite number여야 합니다");
  if (input.value < 0) throw new Error("Growth metric value는 음수일 수 없습니다");
  const allowed = DIMENSIONS[input.name as GrowthMetricName] as readonly string[];
  const keys = Object.keys(input.dimensions).sort();
  if (keys.length !== allowed.length || !allowed.every((key) => keys.includes(key)))
    throw new Error("Growth metric dimension이 고정 계약과 일치하지 않습니다");
  for (const value of Object.values(input.dimensions)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value)) throw new Error("Growth metric label이 유효하지 않습니다");
  }
}

export class GrowthMetricStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}
  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
  ): Promise<GrowthMetricStore> {
    await applyMigrations(database, [GROWTH_RECOVERY_METRIC_MIGRATION]);
    return new GrowthMetricStore(database, organizations);
  }
  public async recordOnce(
    context: TenantContext,
    idempotencyKey: string,
    input: GrowthMetricInput,
  ): Promise<GrowthMetricRecord> {
    await this.organizations.verifyTenantContext(context);
    validateGrowthMetric(input);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/u.test(idempotencyKey))
      throw new Error("Growth metric idempotency key가 유효하지 않습니다");
    const requestHash = growthChecksum(input);
    const [existing] = await this.database.query<[GrowthMetricRecord[]]>(
      "SELECT * FROM growth_metric WHERE organization_id = $organization_id AND idempotency_key = $key LIMIT 1;",
      { organization_id: context.organizationId, key: idempotencyKey },
    );
    if (existing[0]) {
      if (existing[0].request_hash !== requestHash)
        throw new Error("같은 metric key에 다른 payload를 사용할 수 없습니다");
      return existing[0];
    }
    const [created] = await this.database.query<[GrowthMetricRecord[]]>(
      "CREATE growth_metric CONTENT { metric_id: $id, organization_id: $organization_id, idempotency_key: $key, metric_name: $name, value: $value, unit: $unit, dimensions_json: $dimensions_json, request_hash: $request_hash, created_at: time::now() } RETURN AFTER;",
      {
        id: randomUUID(),
        organization_id: context.organizationId,
        key: idempotencyKey,
        name: input.name,
        value: input.value,
        unit: input.unit,
        dimensions_json: canonicalGrowthJson(input.dimensions),
        request_hash: requestHash,
      },
    );
    if (!created[0]) throw new Error("Growth metric 생성 결과가 없습니다");
    return created[0];
  }
}
