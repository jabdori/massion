import { randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { canonicalGrowthJson, growthChecksum } from "./prompt-memory.js";
import { GROWTH_EFFECT_REVERT_MIGRATION } from "./schema.js";

export interface GrowthEffectContract {
  readonly strategyVersionId: string;
  readonly caseSetChecksum: string;
  readonly metricSourceId: string;
  readonly metricSourceVersion: string;
  readonly unit: string;
  readonly windowChecksum: string;
  readonly direction: "higher" | "lower";
  readonly stableTolerance: number;
  readonly degradationThreshold: number;
  readonly minimumObservations: number;
}

export interface GrowthEffectSample {
  readonly score: number;
  readonly observationCount: number;
  readonly contract: GrowthEffectContract;
}

export interface GrowthEffectComparison {
  readonly result: "improved" | "stable" | "degraded" | "inconclusive";
  readonly rawDelta: number;
  readonly directionalDelta: number;
  readonly contractChecksum: string;
}

function assertSample(sample: GrowthEffectSample): void {
  if (!Number.isFinite(sample.score)) throw new Error("Growth effect score는 finite number여야 합니다");
  if (!Number.isInteger(sample.observationCount) || sample.observationCount < 0)
    throw new Error("Growth effect observation count가 유효하지 않습니다");
  const contract = sample.contract;
  for (const value of [
    contract.strategyVersionId,
    contract.caseSetChecksum,
    contract.metricSourceId,
    contract.metricSourceVersion,
    contract.unit,
    contract.windowChecksum,
  ]) {
    if (!value.trim()) throw new Error("Growth effect contract 값이 비었습니다");
  }
  if (
    !Number.isFinite(contract.stableTolerance) ||
    contract.stableTolerance < 0 ||
    !Number.isFinite(contract.degradationThreshold) ||
    contract.degradationThreshold <= contract.stableTolerance ||
    !Number.isInteger(contract.minimumObservations) ||
    contract.minimumObservations < 1
  ) {
    throw new Error("Growth effect threshold 또는 minimum observation이 유효하지 않습니다");
  }
}

export function compareGrowthEffect(
  baseline: GrowthEffectSample,
  observation: GrowthEffectSample,
): GrowthEffectComparison {
  assertSample(baseline);
  assertSample(observation);
  if (canonicalGrowthJson(baseline.contract) !== canonicalGrowthJson(observation.contract))
    throw new Error("Growth effect는 동일 측정 계약끼리만 비교할 수 있습니다");
  const rawDelta = observation.score - baseline.score;
  const directionalDelta = baseline.contract.direction === "higher" ? rawDelta : -rawDelta;
  const contractChecksum = growthChecksum(baseline.contract);
  if (
    baseline.observationCount < baseline.contract.minimumObservations ||
    observation.observationCount < baseline.contract.minimumObservations
  )
    return { result: "inconclusive", rawDelta, directionalDelta, contractChecksum };
  if (directionalDelta <= -baseline.contract.degradationThreshold)
    return { result: "degraded", rawDelta, directionalDelta, contractChecksum };
  if (directionalDelta > baseline.contract.stableTolerance)
    return { result: "improved", rawDelta, directionalDelta, contractChecksum };
  return { result: "stable", rawDelta, directionalDelta, contractChecksum };
}

interface BaselineRecord {
  readonly baseline_id: string;
  readonly organization_id: string;
  readonly adoption_id: string;
  readonly status: "pending" | "captured" | "closed";
  readonly metrics_json: string;
  readonly contract_json?: string;
  readonly checksum: string;
}
export interface GrowthEffectEvaluationRecord {
  readonly effect_evaluation_id: string;
  readonly organization_id: string;
  readonly adoption_id: string;
  readonly baseline_id: string;
  readonly observation_id: string;
  readonly result: GrowthEffectComparison["result"];
  readonly comparison_json: string;
  readonly command_id: string;
  readonly request_hash: string;
}

export class GrowthEffectStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}
  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
  ): Promise<GrowthEffectStore> {
    await applyMigrations(database, [GROWTH_EFFECT_REVERT_MIGRATION]);
    return new GrowthEffectStore(database, organizations);
  }

  public async captureBaseline(
    context: TenantContext,
    input: { readonly commandId: string; readonly adoptionId: string; readonly sample: GrowthEffectSample },
  ): Promise<void> {
    await this.organizations.verifyTenantContext(context);
    assertSample(input.sample);
    await this.database.transaction(async (executor) => {
      const baseline = await this.baseline(context.organizationId, input.adoptionId, executor);
      const checksum = growthChecksum(input.sample);
      if (baseline.status === "captured") {
        if (baseline.checksum !== checksum) throw new Error("Growth baseline은 이미 다른 값으로 확정됐습니다");
        return;
      }
      if (baseline.status !== "pending") throw new Error("Growth baseline을 캡처할 수 없는 상태입니다");
      const [updated] = await executor.query<[BaselineRecord[]]>(
        "UPDATE growth_effect_baseline SET status = 'captured', metrics_json = $metrics_json, contract_json = $contract_json, checksum = $checksum, captured_at = time::now() WHERE organization_id = $organization_id AND baseline_id = $baseline_id AND status = 'pending' RETURN AFTER;",
        {
          organization_id: context.organizationId,
          baseline_id: baseline.baseline_id,
          metrics_json: canonicalGrowthJson({
            score: input.sample.score,
            observationCount: input.sample.observationCount,
          }),
          contract_json: canonicalGrowthJson(input.sample.contract),
          checksum,
        },
      );
      if (!updated[0]) throw new Error("Growth baseline이 동시에 변경됐습니다");
    });
  }

  public async observe(
    context: TenantContext,
    input: { readonly commandId: string; readonly adoptionId: string; readonly sample: GrowthEffectSample },
  ): Promise<GrowthEffectEvaluationRecord> {
    await this.organizations.verifyTenantContext(context);
    assertSample(input.sample);
    const requestHash = growthChecksum(input);
    return await this.database.transaction(async (executor) => {
      const [replayed] = await executor.query<[GrowthEffectEvaluationRecord[]]>(
        "SELECT * FROM growth_effect_evaluation WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
        { organization_id: context.organizationId, command_id: input.commandId },
      );
      if (replayed[0]) {
        if (replayed[0].request_hash !== requestHash)
          throw new Error("같은 commandId에 다른 effect observation을 사용할 수 없습니다");
        return replayed[0];
      }
      const baseline = await this.baseline(context.organizationId, input.adoptionId, executor);
      if (baseline.status !== "captured" || !baseline.contract_json)
        throw new Error("captured Growth baseline이 필요합니다");
      const metrics = JSON.parse(baseline.metrics_json) as { score: number; observationCount: number };
      const comparison = compareGrowthEffect(
        { ...metrics, contract: JSON.parse(baseline.contract_json) as GrowthEffectContract },
        input.sample,
      );
      const observationId = randomUUID();
      await executor.query(
        "CREATE growth_effect_observation CONTENT { observation_id: $observation_id, organization_id: $organization_id, adoption_id: $adoption_id, score: $score, observation_count: $observation_count, contract_json: $contract_json, contract_checksum: $contract_checksum, command_id: $command_id, request_hash: $request_hash, created_at: time::now() };",
        {
          observation_id: observationId,
          organization_id: context.organizationId,
          adoption_id: input.adoptionId,
          score: input.sample.score,
          observation_count: input.sample.observationCount,
          contract_json: canonicalGrowthJson(input.sample.contract),
          contract_checksum: comparison.contractChecksum,
          command_id: input.commandId,
          request_hash: requestHash,
        },
      );
      const id = randomUUID();
      const [created] = await executor.query<[GrowthEffectEvaluationRecord[]]>(
        "CREATE growth_effect_evaluation CONTENT { effect_evaluation_id: $id, organization_id: $organization_id, adoption_id: $adoption_id, baseline_id: $baseline_id, observation_id: $observation_id, result: $result, comparison_json: $comparison_json, command_id: $command_id, request_hash: $request_hash, created_at: time::now() } RETURN AFTER;",
        {
          id,
          organization_id: context.organizationId,
          adoption_id: input.adoptionId,
          baseline_id: baseline.baseline_id,
          observation_id: observationId,
          result: comparison.result,
          comparison_json: canonicalGrowthJson(comparison),
          command_id: input.commandId,
          request_hash: requestHash,
        },
      );
      if (!created[0]) throw new Error("Growth effect evaluation 생성 결과가 없습니다");
      if (comparison.result === "degraded")
        await executor.query(
          "UPDATE growth_adoption_run SET exposure_status = 'suspended', updated_at = time::now() WHERE organization_id = $organization_id AND adoption_id = $adoption_id AND status = 'observing';",
          { organization_id: context.organizationId, adoption_id: input.adoptionId },
        );
      return created[0];
    });
  }

  private async baseline(org: string, adoptionId: string, executor: QueryExecutor): Promise<BaselineRecord> {
    const [rows] = await executor.query<[BaselineRecord[]]>(
      "SELECT * FROM growth_effect_baseline WHERE organization_id = $organization_id AND adoption_id = $adoption_id LIMIT 1;",
      { organization_id: org, adoption_id: adoptionId },
    );
    if (!rows[0]) throw new Error("Growth effect baseline을 찾을 수 없습니다");
    return rows[0];
  }
}
