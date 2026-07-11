import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { canonicalGrowthJson, growthChecksum } from "./prompt-memory.js";
import { GROWTH_EVALUATION_MIGRATION } from "./schema.js";

export type GrowthEvaluationOutcome = "eligible" | "ineligible" | "blocked";
export type GrowthSignalGroup = "required" | "supporting" | "conflict";

export interface GrowthSignalReceiptInput {
  readonly commandId: string;
  readonly suggestionId: string;
  readonly signalId: string;
  readonly group: GrowthSignalGroup;
  readonly origin: "deterministic" | "independent" | "model-self";
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly outcome: "passed" | "failed" | "unavailable";
  readonly score: number;
  readonly unit: string;
  readonly sourceId: string;
  readonly sourceChecksum: string;
  readonly fresh: boolean;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface GrowthSignalReceipt extends Omit<GrowthSignalReceiptInput, "evidence"> {
  readonly receiptId: string;
  readonly organizationId: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly requestHash: string;
}

export interface GrowthEvaluationStrategy {
  readonly strategyId: string;
  readonly schemaVersion: "massion.growth.evaluation-strategy.v1";
  readonly requiredSignalIds: readonly ["lineage", "target", "candidate"];
  readonly minimumIndependentSupportingSignals: 1;
  readonly maximumPassedConflicts: 0;
  readonly allowedUnits: readonly string[];
}

export interface GrowthEvaluationStrategyVersion {
  readonly strategyVersionId: string;
  readonly organizationId: string;
  readonly version: number;
  readonly parentVersionId?: string;
  readonly status: "active" | "superseded";
  readonly strategy: GrowthEvaluationStrategy;
  readonly checksum: string;
  readonly governanceDecisionId: string;
}

interface StrategyRecord {
  readonly strategy_version_id: string;
  readonly organization_id: string;
  readonly version: number;
  readonly parent_version_id?: string;
  readonly status: "active" | "superseded";
  readonly strategy_json: string;
  readonly checksum: string;
  readonly governance_decision_id: string;
  readonly command_id: string;
  readonly request_hash: string;
}

interface ReceiptRecord {
  readonly receipt_id: string;
  readonly organization_id: string;
  readonly suggestion_id: string;
  readonly signal_id: string;
  readonly signal_group: GrowthSignalGroup;
  readonly origin: GrowthSignalReceiptInput["origin"];
  readonly adapter_id: string;
  readonly adapter_version: string;
  readonly outcome: GrowthSignalReceiptInput["outcome"];
  readonly score: number;
  readonly unit: string;
  readonly source_id: string;
  readonly source_checksum: string;
  readonly fresh: boolean;
  readonly evidence_json: string;
  readonly command_id: string;
  readonly request_hash: string;
}

export interface GrowthEvaluationRun {
  readonly evaluationRunId: string;
  readonly organizationId: string;
  readonly suggestionId: string;
  readonly strategyVersionId: string;
  readonly receiptIds: readonly string[];
  readonly inputHash: string;
  readonly outcome: GrowthEvaluationOutcome;
}

interface EvaluationRecord {
  readonly evaluation_run_id: string;
  readonly organization_id: string;
  readonly suggestion_id: string;
  readonly strategy_version_id: string;
  readonly receipt_ids: readonly string[];
  readonly input_hash: string;
  readonly outcome: GrowthEvaluationOutcome;
  readonly command_id: string;
  readonly request_hash: string;
}

export interface GrowthSignalAdapter {
  readonly id: string;
  readonly version: string;
  evaluate(context: TenantContext, input: { readonly suggestionId: string }): Promise<GrowthSignalReceiptInput>;
}

const SHA256 = /^[a-f0-9]{64}$/u;

export function decideGrowthEvaluation(input: {
  readonly required: readonly GrowthSignalReceiptInput[];
  readonly supporting: readonly GrowthSignalReceiptInput[];
  readonly conflicts: readonly GrowthSignalReceiptInput[];
}): GrowthEvaluationOutcome {
  if (input.conflicts.some((signal) => signal.outcome === "passed")) return "ineligible";
  const requiredIds = new Set(
    input.required.filter((signal) => signal.outcome === "passed" && signal.fresh).map((signal) => signal.signalId),
  );
  if (!["lineage", "target", "candidate"].every((id) => requiredIds.has(id))) return "blocked";
  if (
    !input.supporting.some((signal) => signal.outcome === "passed" && signal.fresh && signal.origin === "independent")
  )
    return "blocked";
  return "eligible";
}

function strategy(record: StrategyRecord): GrowthEvaluationStrategyVersion {
  const parsed = JSON.parse(record.strategy_json) as GrowthEvaluationStrategy;
  if (growthChecksum(parsed) !== record.checksum)
    throw new Error("Growth EvaluationStrategy checksum이 일치하지 않습니다");
  return {
    strategyVersionId: record.strategy_version_id,
    organizationId: record.organization_id,
    version: record.version,
    ...(record.parent_version_id ? { parentVersionId: record.parent_version_id } : {}),
    status: record.status,
    strategy: parsed,
    checksum: record.checksum,
    governanceDecisionId: record.governance_decision_id,
  };
}

function receipt(record: ReceiptRecord): GrowthSignalReceipt {
  return {
    receiptId: record.receipt_id,
    organizationId: record.organization_id,
    commandId: record.command_id,
    suggestionId: record.suggestion_id,
    signalId: record.signal_id,
    group: record.signal_group,
    origin: record.origin,
    adapterId: record.adapter_id,
    adapterVersion: record.adapter_version,
    outcome: record.outcome,
    score: record.score,
    unit: record.unit,
    sourceId: record.source_id,
    sourceChecksum: record.source_checksum,
    fresh: record.fresh,
    evidence: JSON.parse(record.evidence_json) as Record<string, unknown>,
    requestHash: record.request_hash,
  };
}

export class GrowthEvaluationStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
  ): Promise<GrowthEvaluationStore> {
    await applyMigrations(database, [GROWTH_EVALUATION_MIGRATION]);
    return new GrowthEvaluationStore(database, organizations);
  }

  public async bootstrap(context: TenantContext): Promise<GrowthEvaluationStrategyVersion> {
    await this.organizations.verifyTenantContext(context);
    const existing = await this.active(context.organizationId);
    if (existing) return strategy(existing);
    const initial: GrowthEvaluationStrategy = {
      strategyId: "massion.growth.evidence-gated.v1",
      schemaVersion: "massion.growth.evaluation-strategy.v1",
      requiredSignalIds: ["lineage", "target", "candidate"],
      minimumIndependentSupportingSignals: 1,
      maximumPassedConflicts: 0,
      allowedUnits: ["boolean", "count", "ratio"],
    };
    return strategy(
      await this.createStrategy(context, {
        commandId: "bootstrap-growth-evaluation-strategy",
        governanceDecisionId: "system-bootstrap",
        strategy: initial,
      }),
    );
  }

  public async getActiveStrategy(context: TenantContext): Promise<GrowthEvaluationStrategyVersion> {
    await this.organizations.verifyTenantContext(context);
    const record = await this.active(context.organizationId);
    if (!record) throw new Error("활성 Growth EvaluationStrategy를 찾을 수 없습니다");
    return strategy(record);
  }

  public async activateStrategy(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly expectedVersion: number;
      readonly governanceDecisionId: string;
      readonly strategy: GrowthEvaluationStrategy;
    },
  ): Promise<GrowthEvaluationStrategyVersion> {
    await this.organizations.verifyTenantContext(context);
    if (!input.governanceDecisionId.trim()) {
      throw new Error("EvaluationStrategy activation에는 Governance decision이 필요합니다");
    }
    const requestHash = growthChecksum(input);
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const repeated = await this.byStrategyCommand(context.organizationId, input.commandId, transaction);
      if (repeated) {
        if (repeated.request_hash !== requestHash)
          throw new Error("같은 commandId에 다른 strategy payload를 사용할 수 없습니다");
        return strategy(repeated);
      }
      const current = await this.active(context.organizationId, transaction);
      if (!current || current.version !== input.expectedVersion)
        throw new Error("EvaluationStrategy version precondition이 일치하지 않습니다");
      await transaction.query(
        "UPDATE growth_evaluation_strategy_version SET status = 'superseded', active_guard_key = NONE, superseded_at = time::now() WHERE organization_id = $organization_id AND strategy_version_id = $strategy_version_id;",
        { organization_id: context.organizationId, strategy_version_id: current.strategy_version_id },
      );
      return strategy(await this.createStrategy(context, input, current, requestHash, transaction));
    });
  }

  public async recordSignal(context: TenantContext, input: GrowthSignalReceiptInput): Promise<GrowthSignalReceipt> {
    await this.organizations.verifyTenantContext(context);
    if (!Number.isFinite(input.score)) throw new Error("Growth signal score는 finite number여야 합니다");
    if (!input.fresh) throw new Error("Growth signal source는 fresh해야 합니다");
    if (!SHA256.test(input.sourceChecksum)) throw new Error("Growth signal source checksum이 유효하지 않습니다");
    if (!input.unit.trim() || canonicalGrowthJson(input.evidence).length > 65_536)
      throw new Error("Growth signal unit 또는 evidence 크기가 유효하지 않습니다");
    const requestHash = growthChecksum(input);
    const [replayed] = await this.database.query<[ReceiptRecord[]]>(
      "SELECT * FROM growth_signal_receipt WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: context.organizationId, command_id: input.commandId },
    );
    if (replayed[0]) {
      if (replayed[0].request_hash !== requestHash)
        throw new Error("같은 commandId에 다른 signal payload를 사용할 수 없습니다");
      return receipt(replayed[0]);
    }
    const id = crypto.randomUUID();
    const [records] = await this.database.query<[ReceiptRecord[]]>(
      "CREATE growth_signal_receipt CONTENT { receipt_id: $receipt_id, organization_id: $organization_id, suggestion_id: $suggestion_id, signal_id: $signal_id, signal_group: $signal_group, origin: $origin, adapter_id: $adapter_id, adapter_version: $adapter_version, outcome: $outcome, score: $score, unit: $unit, source_id: $source_id, source_checksum: $source_checksum, fresh: $fresh, evidence_json: $evidence_json, command_id: $command_id, request_hash: $request_hash, created_at: time::now() } RETURN AFTER;",
      {
        receipt_id: id,
        organization_id: context.organizationId,
        suggestion_id: input.suggestionId,
        signal_id: input.signalId,
        signal_group: input.group,
        origin: input.origin,
        adapter_id: input.adapterId,
        adapter_version: input.adapterVersion,
        outcome: input.outcome,
        score: input.score,
        unit: input.unit,
        source_id: input.sourceId,
        source_checksum: input.sourceChecksum,
        fresh: input.fresh,
        evidence_json: canonicalGrowthJson(input.evidence),
        command_id: input.commandId,
        request_hash: requestHash,
      },
    );
    if (!records[0]) throw new Error("Growth signal receipt 생성 결과가 없습니다");
    return receipt(records[0]);
  }

  public async getSignal(context: TenantContext, receiptId: string): Promise<GrowthSignalReceipt> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[ReceiptRecord[]]>(
      "SELECT * FROM growth_signal_receipt WHERE organization_id = $organization_id AND receipt_id = $receipt_id LIMIT 1;",
      { organization_id: context.organizationId, receipt_id: receiptId },
    );
    if (!records[0]) throw new Error("Growth signal receipt를 찾을 수 없습니다");
    return receipt(records[0]);
  }

  public async evaluate(
    context: TenantContext,
    input: { readonly commandId: string; readonly suggestionId: string; readonly receiptIds: readonly string[] },
  ): Promise<GrowthEvaluationRun> {
    await this.organizations.verifyTenantContext(context);
    if (input.receiptIds.length === 0 || new Set(input.receiptIds).size !== input.receiptIds.length) {
      throw new Error("Growth evaluation receipt 집합이 비었거나 중복됐습니다");
    }
    const requestHash = growthChecksum(input);
    const [replayed] = await this.database.query<[EvaluationRecord[]]>(
      "SELECT * FROM growth_evaluation_run WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: context.organizationId, command_id: input.commandId },
    );
    if (replayed[0]) {
      if (replayed[0].request_hash !== requestHash)
        throw new Error("같은 commandId에 다른 evaluation payload를 사용할 수 없습니다");
      return this.evaluation(replayed[0]);
    }
    const active = await this.getActiveStrategy(context);
    const [records] = await this.database.query<[ReceiptRecord[]]>(
      "SELECT * FROM growth_signal_receipt WHERE organization_id = $organization_id AND receipt_id IN $receipt_ids;",
      { organization_id: context.organizationId, receipt_ids: input.receiptIds },
    );
    if (
      records.length !== input.receiptIds.length ||
      records.some((record) => record.suggestion_id !== input.suggestionId)
    ) {
      throw new Error("Growth evaluation receipt의 tenant 또는 Suggestion이 일치하지 않습니다");
    }
    const receipts = records.map((record) => ({
      ...receipt(record),
      evidence: JSON.parse(record.evidence_json) as Record<string, unknown>,
    }));
    let outcome: GrowthEvaluationOutcome;
    if (receipts.some((candidate) => !active.strategy.allowedUnits.includes(candidate.unit))) {
      outcome = "blocked";
    } else if (receipts.some((candidate) => candidate.group === "conflict" && candidate.outcome === "passed")) {
      outcome = "ineligible";
    } else {
      const required = new Set(
        receipts
          .filter((candidate) => candidate.group === "required" && candidate.outcome === "passed" && candidate.fresh)
          .map((candidate) => candidate.signalId),
      );
      const requiredPassed = active.strategy.requiredSignalIds.every((id) => required.has(id));
      const supportingCount = receipts.filter(
        (candidate) =>
          candidate.group === "supporting" &&
          candidate.origin === "independent" &&
          candidate.outcome === "passed" &&
          candidate.fresh,
      ).length;
      outcome =
        requiredPassed && supportingCount >= active.strategy.minimumIndependentSupportingSignals
          ? "eligible"
          : "blocked";
    }
    const inputHash = growthChecksum({
      strategyVersionId: active.strategyVersionId,
      strategyChecksum: active.checksum,
      receipts: receipts.map((candidate) => candidate.requestHash).sort(),
    });
    const id = crypto.randomUUID();
    const [created] = await this.database.query<[EvaluationRecord[]]>(
      "CREATE growth_evaluation_run CONTENT { evaluation_run_id: $id, organization_id: $organization_id, suggestion_id: $suggestion_id, strategy_version_id: $strategy_version_id, receipt_ids: $receipt_ids, input_hash: $input_hash, outcome: $outcome, reason_json: $reason_json, command_id: $command_id, request_hash: $request_hash, created_at: time::now() } RETURN AFTER;",
      {
        id,
        organization_id: context.organizationId,
        suggestion_id: input.suggestionId,
        strategy_version_id: active.strategyVersionId,
        receipt_ids: input.receiptIds,
        input_hash: inputHash,
        outcome,
        reason_json: canonicalGrowthJson({ strategyId: active.strategy.strategyId }),
        command_id: input.commandId,
        request_hash: requestHash,
      },
    );
    if (!created[0]) throw new Error("Growth evaluation run 생성 결과가 없습니다");
    return this.evaluation(created[0]);
  }

  private async active(
    organizationId: string,
    executor: QueryExecutor = this.database,
  ): Promise<StrategyRecord | undefined> {
    const [records] = await executor.query<[StrategyRecord[]]>(
      "SELECT * FROM growth_evaluation_strategy_version WHERE active_guard_key = $guard LIMIT 1;",
      { guard: `${organizationId}:growth-evaluation-strategy` },
    );
    return records[0];
  }

  private async byStrategyCommand(
    organizationId: string,
    commandId: string,
    executor: QueryExecutor = this.database,
  ): Promise<StrategyRecord | undefined> {
    const [records] = await executor.query<[StrategyRecord[]]>(
      "SELECT * FROM growth_evaluation_strategy_version WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    return records[0];
  }

  private async createStrategy(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly governanceDecisionId: string;
      readonly strategy: GrowthEvaluationStrategy;
    },
    parent?: StrategyRecord,
    suppliedRequestHash?: string,
    executor: QueryExecutor = this.database,
  ): Promise<StrategyRecord> {
    const id = crypto.randomUUID();
    const checksum = growthChecksum(input.strategy);
    const requestHash = suppliedRequestHash ?? growthChecksum(input);
    const [records] = await executor.query<[StrategyRecord[]]>(
      "CREATE growth_evaluation_strategy_version CONTENT { strategy_version_id: $id, organization_id: $organization_id, version: $version, parent_version_id: $parent_id, status: 'active', strategy_json: $strategy_json, checksum: $checksum, governance_decision_id: $governance_decision_id, command_id: $command_id, request_hash: $request_hash, active_guard_key: $guard, created_at: time::now() } RETURN AFTER;",
      {
        id,
        organization_id: context.organizationId,
        version: (parent?.version ?? 0) + 1,
        parent_id: parent?.strategy_version_id,
        strategy_json: canonicalGrowthJson(input.strategy),
        checksum,
        governance_decision_id: input.governanceDecisionId,
        command_id: input.commandId,
        request_hash: requestHash,
        guard: `${context.organizationId}:growth-evaluation-strategy`,
      },
    );
    if (!records[0]) throw new Error("Growth EvaluationStrategy 생성 결과가 없습니다");
    return records[0];
  }

  private evaluation(record: EvaluationRecord): GrowthEvaluationRun {
    return {
      evaluationRunId: record.evaluation_run_id,
      organizationId: record.organization_id,
      suggestionId: record.suggestion_id,
      strategyVersionId: record.strategy_version_id,
      receiptIds: record.receipt_ids,
      inputHash: record.input_hash,
      outcome: record.outcome,
    };
  }
}
