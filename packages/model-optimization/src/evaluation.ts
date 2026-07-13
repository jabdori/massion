import { createHash, randomUUID } from "node:crypto";

import { type OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import {
  isOptimizationRoleKey,
  recommendModels,
  type EvaluationReceipt,
  type EvaluationRequirements,
  type EvaluationPolicy,
  type ModelRecommendation,
  type OptimizationRoleKey,
} from "./scoring.js";
import type {
  ConfigureOptimizationPolicyInput,
  CompleteEvaluationInput,
  EvaluationBundle,
  EvaluationCase,
  EvaluationRun,
  ModelRecommendationRecord,
  OptimizationModelProfile,
  OptimizationPolicyVersion,
  StartEvaluationInput,
  StoredEvaluationReceipt,
} from "./contracts.js";
import type { EvaluationCapabilities, ModelEvaluationExecutionResult, ModelEvaluationExecutor } from "./ports.js";
import { MODEL_OPTIMIZATION_HARDENING_MIGRATION, MODEL_OPTIMIZATION_MIGRATION } from "./schema.js";
import { createEvaluationExport, validateEvaluationExport, type EvaluationExport } from "./transfer.js";

export type { OptimizationModelProfile } from "./contracts.js";
export type {
  EvaluationCapabilities,
  ModelEvaluationExecutionInput,
  ModelEvaluationExecutionResult,
  ModelEvaluationExecutor,
} from "./ports.js";

interface BundleRecord {
  readonly bundle_id: string;
  readonly organization_id: string;
  readonly role_key: OptimizationRoleKey;
  readonly version: number;
  readonly case_ids: readonly string[];
  readonly runtime_version: string;
  readonly checksum: string;
  readonly status: "active" | "superseded";
  readonly command_id: string;
  readonly request_hash: string;
}

interface RunRecord {
  readonly run_id: string;
  readonly organization_id: string;
  readonly role_key: OptimizationRoleKey;
  readonly bundle_id: string;
  readonly bundle_version: number;
  readonly model_profile_id: string;
  readonly runtime_version: string;
  readonly mode: "standard" | "shadow";
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly input_checksum: string;
  readonly command_id: string;
  readonly request_hash: string;
}

interface ReceiptRecord {
  readonly receipt_id: string;
  readonly run_id: string;
  readonly organization_id: string;
  readonly role_key: OptimizationRoleKey;
  readonly model_profile_id: string;
  readonly bundle_version: number;
  readonly sample_count: number;
  readonly quality_score: number;
  readonly latency_ms: number;
  readonly cost_micros: number;
  readonly privacy_allowed: boolean;
  readonly completed: boolean;
  readonly input_checksum: string;
  readonly receipt_checksum: string;
  readonly command_id: string;
  readonly request_hash: string;
}

interface PolicyRecord {
  readonly policy_version_id: string;
  readonly organization_id: string;
  readonly version: number;
  readonly policy: EvaluationPolicy;
  readonly auto_optimize: boolean;
  readonly production_learning: boolean;
  readonly shadow_enabled: boolean;
  readonly minimum_sample_count: number;
  readonly improvement_threshold: number;
  readonly observation_budget_micros?: number;
  readonly observation_retention_days?: number;
  readonly status: "active" | "superseded";
  readonly checksum: string;
  readonly governance_decision_id: string;
  readonly command_id: string;
  readonly request_hash: string;
  readonly created_by_user_id: string;
}

interface RecommendationRecord {
  readonly recommendation_id: string;
  readonly organization_id: string;
  readonly role_key: OptimizationRoleKey;
  readonly policy_version_id: string;
  readonly primary_model_profile_id?: string;
  readonly fallback_model_profile_ids: readonly string[];
  readonly excluded_json: string;
  readonly receipt_ids: readonly string[];
  readonly status: ModelRecommendationRecord["status"];
  readonly checksum: string;
  readonly command_id: string;
  readonly request_hash: string;
}

const SHA256 = /^[a-f0-9]{64}$/u;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assertText(value: unknown, label: string, maximum = 512): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || /[\0\r\n]/u.test(value)) {
    throw new Error(`${label}이(가) 유효하지 않습니다`);
  }
}

function assertChecksum(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} checksum이 유효하지 않습니다`);
}

function assertRole(value: string): asserts value is OptimizationRoleKey {
  if (!isOptimizationRoleKey(value)) throw new Error(`지원하지 않는 최적화 역할입니다: ${value}`);
}

function bundleView(record: BundleRecord): EvaluationBundle {
  return {
    bundleId: record.bundle_id,
    roleKey: record.role_key,
    version: record.version,
    caseIds: record.case_ids,
    runtimeVersion: record.runtime_version,
    checksum: record.checksum,
    status: record.status,
  };
}

function runView(record: RunRecord): EvaluationRun {
  return {
    runId: record.run_id,
    organizationId: record.organization_id,
    roleKey: record.role_key,
    bundleId: record.bundle_id,
    bundleVersion: record.bundle_version,
    modelProfileId: record.model_profile_id,
    runtimeVersion: record.runtime_version,
    mode: record.mode,
    status: record.status,
    inputChecksum: record.input_checksum,
    commandId: record.command_id,
  };
}

function receiptView(record: ReceiptRecord): StoredEvaluationReceipt {
  return {
    receiptId: record.receipt_id,
    runId: record.run_id,
    organizationId: record.organization_id,
    roleKey: record.role_key,
    modelProfileId: record.model_profile_id,
    bundleVersion: record.bundle_version,
    sampleCount: record.sample_count,
    qualityScore: record.quality_score,
    latencyMs: record.latency_ms,
    costMicros: record.cost_micros,
    privacyAllowed: record.privacy_allowed,
    completed: record.completed,
    inputChecksum: record.input_checksum,
    receiptChecksum: record.receipt_checksum,
  };
}

function policyView(record: PolicyRecord): OptimizationPolicyVersion {
  return {
    policyVersionId: record.policy_version_id,
    organizationId: record.organization_id,
    version: record.version,
    policy: record.policy,
    autoOptimize: record.auto_optimize,
    productionLearning: record.production_learning,
    shadowEnabled: record.shadow_enabled,
    minimumSampleCount: record.minimum_sample_count,
    improvementThreshold: record.improvement_threshold,
    observationBudgetMicros: record.observation_budget_micros ?? 1_000_000,
    observationRetentionDays: record.observation_retention_days ?? 30,
    status: record.status,
    checksum: record.checksum,
  };
}

function recommendationView(record: RecommendationRecord): ModelRecommendationRecord {
  return {
    recommendationId: record.recommendation_id,
    organizationId: record.organization_id,
    roleKey: record.role_key,
    policyVersionId: record.policy_version_id,
    ...(record.primary_model_profile_id ? { primaryModelProfileId: record.primary_model_profile_id } : {}),
    fallbackModelProfileIds: record.fallback_model_profile_ids,
    excludedJson: record.excluded_json,
    receiptIds: record.receipt_ids,
    status: record.status,
    checksum: record.checksum,
  };
}

function scoreReceipt(record: StoredEvaluationReceipt): EvaluationReceipt {
  return {
    roleKey: record.roleKey,
    modelProfileId: record.modelProfileId,
    bundleVersion: record.bundleVersion,
    sampleCount: record.sampleCount,
    qualityScore: record.qualityScore,
    latencyMs: record.latencyMs,
    costMicros: record.costMicros,
    privacyAllowed: record.privacyAllowed,
    completed: record.completed,
    inputChecksum: record.inputChecksum,
    receiptChecksum: record.receiptChecksum,
  };
}

export interface CreateBundleInput {
  readonly commandId: string;
  readonly roleKey: OptimizationRoleKey;
  readonly runtimeVersion: string;
  readonly cases: readonly Omit<EvaluationCase, "caseId" | "roleKey" | "version">[];
}

export interface RecommendInput {
  readonly commandId: string;
  readonly roleKey: OptimizationRoleKey;
  readonly candidates: readonly OptimizationModelProfile[];
  readonly receipts: readonly EvaluationReceipt[];
  readonly requirements: EvaluationRequirements;
  readonly manualModelProfileId?: string;
}

export interface ExportBundleInput {
  readonly bundleId: string;
  readonly license: string;
  readonly configurationChecksum: string;
}

export interface ImportBundleInput {
  readonly commandId: string;
  readonly exportValue: unknown;
}

export interface ModelOptimizationStoreOptions {
  readonly modelCatalog?: (context: TenantContext) => Promise<readonly OptimizationModelProfile[]>;
  readonly executor?: ModelEvaluationExecutor;
}

export interface ExecuteEvaluationInput {
  readonly commandId: string;
  readonly roleKey: OptimizationRoleKey;
  readonly bundleId: string;
  readonly modelProfileId: string;
  readonly runtimeVersion: string;
  readonly mode?: "standard" | "shadow";
  readonly inputChecksum?: string;
}

export class ModelOptimizationStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly options: ModelOptimizationStoreOptions,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    options: ModelOptimizationStoreOptions = {},
  ): Promise<ModelOptimizationStore> {
    await applyMigrations(database, [MODEL_OPTIMIZATION_MIGRATION, MODEL_OPTIMIZATION_HARDENING_MIGRATION]);
    return new ModelOptimizationStore(database, organizations, options);
  }

  public async createBundle(context: TenantContext, input: CreateBundleInput): Promise<EvaluationBundle> {
    await this.organizations.verifyTenantContext(context);
    assertText(input.commandId, "명령 식별자");
    assertRole(input.roleKey);
    assertText(input.runtimeVersion, "runtime version");
    if (input.cases.length < 1 || input.cases.length > 128) throw new Error("평가 case 수가 유효하지 않습니다");
    for (const item of input.cases) {
      assertChecksum(item.promptChecksum, "prompt");
      assertChecksum(item.toolsChecksum, "tools");
      assertChecksum(item.environmentChecksum, "environment");
      if (item.prompt !== undefined) assertText(item.prompt, "평가 prompt", 16_384);
      assertText(item.expectedOutcome, "expected outcome", 4_096);
    }
    const requestHash = digest({ ...input, roleKey: input.roleKey });
    return await this.database.transaction(async (tx) => {
      const repeated = await this.command<BundleRecord>(
        tx,
        context.organizationId,
        "optimization_bundle",
        input.commandId,
      );
      if (repeated) {
        if (repeated.request_hash !== requestHash)
          throw new Error("같은 commandId에 다른 평가 bundle을 사용할 수 없습니다");
        return bundleView(repeated);
      }
      const [versions] = await tx.query<[{ readonly version: number }[]]>(
        "SELECT version FROM optimization_bundle WHERE organization_id = $organization_id AND role_key = $role_key ORDER BY version DESC LIMIT 1;",
        { organization_id: context.organizationId, role_key: input.roleKey },
      );
      const version = (versions[0]?.version ?? 0) + 1;
      const caseIds: string[] = [];
      for (const item of input.cases) {
        const caseId = randomUUID();
        caseIds.push(caseId);
        await tx.query(
          "CREATE optimization_case CONTENT { case_id: $case_id, organization_id: $organization_id, role_key: $role_key, version: $version, prompt_checksum: $prompt_checksum, tools_checksum: $tools_checksum, environment_checksum: $environment_checksum, prompt: $prompt, expected_outcome: $expected_outcome, created_at: time::now() };",
          {
            case_id: caseId,
            organization_id: context.organizationId,
            role_key: input.roleKey,
            version,
            prompt_checksum: item.promptChecksum,
            tools_checksum: item.toolsChecksum,
            environment_checksum: item.environmentChecksum,
            prompt: item.prompt,
            expected_outcome: item.expectedOutcome,
          },
        );
      }
      const bundleId = randomUUID();
      const checksum = digest({ roleKey: input.roleKey, version, runtimeVersion: input.runtimeVersion, caseIds });
      const [created] = await tx.query<[BundleRecord[]]>(
        "CREATE optimization_bundle CONTENT { bundle_id: $bundle_id, organization_id: $organization_id, role_key: $role_key, version: $version, case_ids: $case_ids, runtime_version: $runtime_version, checksum: $checksum, status: 'active', command_id: $command_id, request_hash: $request_hash, created_at: time::now() } RETURN AFTER;",
        {
          bundle_id: bundleId,
          organization_id: context.organizationId,
          role_key: input.roleKey,
          version,
          case_ids: caseIds,
          runtime_version: input.runtimeVersion,
          checksum,
          command_id: input.commandId,
          request_hash: requestHash,
        },
      );
      if (!created[0]) throw new Error("평가 bundle 생성 결과가 없습니다");
      return bundleView(created[0]);
    });
  }

  public async startEvaluation(context: TenantContext, input: StartEvaluationInput): Promise<EvaluationRun> {
    await this.organizations.verifyTenantContext(context);
    assertText(input.commandId, "명령 식별자");
    assertRole(input.roleKey);
    assertText(input.bundleId, "bundle 식별자");
    assertText(input.modelProfileId, "model profile 식별자");
    assertText(input.runtimeVersion, "runtime version");
    assertChecksum(input.inputChecksum, "평가 입력");
    const mode = input.mode ?? "standard";
    return await this.database.transaction(async (tx) => {
      const requestHash = digest(input);
      const repeated = await this.command<RunRecord>(tx, context.organizationId, "optimization_run", input.commandId);
      if (repeated) {
        if (repeated.request_hash !== requestHash)
          throw new Error("같은 commandId에 다른 평가 run을 사용할 수 없습니다");
        return runView(repeated);
      }
      if (mode === "shadow") {
        const policy = await this.activePolicy(tx, context.organizationId);
        if (!policy?.shadow_enabled) throw new Error("shadow 평가가 활성화되지 않았습니다");
      }
      const [bundles] = await tx.query<[BundleRecord[]]>(
        "SELECT * OMIT id FROM optimization_bundle WHERE organization_id = $organization_id AND bundle_id = $bundle_id LIMIT 1;",
        { organization_id: context.organizationId, bundle_id: input.bundleId },
      );
      const bundle = bundles[0];
      if (!bundle || bundle.role_key !== input.roleKey) throw new Error("평가 bundle을 찾을 수 없거나 역할이 다릅니다");
      const [created] = await tx.query<[RunRecord[]]>(
        "CREATE optimization_run CONTENT { run_id: $run_id, organization_id: $organization_id, role_key: $role_key, bundle_id: $bundle_id, bundle_version: $bundle_version, model_profile_id: $model_profile_id, runtime_version: $runtime_version, mode: $mode, status: 'running', input_checksum: $input_checksum, command_id: $command_id, request_hash: $request_hash, created_by_user_id: $user_id, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          run_id: randomUUID(),
          organization_id: context.organizationId,
          role_key: input.roleKey,
          bundle_id: bundle.bundle_id,
          bundle_version: bundle.version,
          model_profile_id: input.modelProfileId,
          runtime_version: input.runtimeVersion,
          mode,
          input_checksum: input.inputChecksum,
          command_id: input.commandId,
          request_hash: requestHash,
          user_id: context.userId,
        },
      );
      if (!created[0]) throw new Error("평가 run 생성 결과가 없습니다");
      return runView(created[0]);
    });
  }

  public async completeEvaluation(
    context: TenantContext,
    input: CompleteEvaluationInput,
  ): Promise<StoredEvaluationReceipt> {
    await this.organizations.verifyTenantContext(context);
    assertText(input.commandId, "명령 식별자");
    assertText(input.runId, "평가 run 식별자");
    if (!Number.isSafeInteger(input.sampleCount) || input.sampleCount < 1)
      throw new Error("평가 sample count가 유효하지 않습니다");
    if (!Number.isFinite(input.qualityScore) || input.qualityScore < 0 || input.qualityScore > 1)
      throw new Error("평가 quality score가 유효하지 않습니다");
    if (
      !Number.isFinite(input.latencyMs) ||
      input.latencyMs < 0 ||
      !Number.isFinite(input.costMicros) ||
      input.costMicros < 0
    )
      throw new Error("평가 latency 또는 cost가 유효하지 않습니다");
    return await this.database.transaction(async (tx) => {
      const requestHash = digest(input);
      const repeated = await this.command<ReceiptRecord>(
        tx,
        context.organizationId,
        "optimization_receipt",
        input.commandId,
      );
      if (repeated) {
        if (repeated.request_hash !== requestHash)
          throw new Error("같은 commandId에 다른 평가 receipt를 사용할 수 없습니다");
        return receiptView(repeated);
      }
      const [runs] = await tx.query<[RunRecord[]]>(
        "SELECT * OMIT id FROM optimization_run WHERE organization_id = $organization_id AND run_id = $run_id LIMIT 1;",
        { organization_id: context.organizationId, run_id: input.runId },
      );
      const run = runs[0];
      if (!run) throw new Error("평가 run을 찾을 수 없습니다");
      if (run.status !== "running") throw new Error("running 상태의 평가 run만 완료할 수 있습니다");
      const receiptChecksum = digest({
        runId: run.run_id,
        sampleCount: input.sampleCount,
        qualityScore: input.qualityScore,
        latencyMs: input.latencyMs,
        costMicros: input.costMicros,
        privacyAllowed: input.privacyAllowed,
        completed: input.completed,
      });
      const [created] = await tx.query<[ReceiptRecord[]]>(
        "CREATE optimization_receipt CONTENT { receipt_id: $receipt_id, run_id: $run_id, organization_id: $organization_id, role_key: $role_key, model_profile_id: $model_profile_id, bundle_version: $bundle_version, sample_count: $sample_count, quality_score: $quality_score, latency_ms: $latency_ms, cost_micros: $cost_micros, privacy_allowed: $privacy_allowed, completed: $completed, input_checksum: $input_checksum, receipt_checksum: $receipt_checksum, command_id: $command_id, request_hash: $request_hash, created_at: time::now() } RETURN AFTER; UPDATE optimization_run SET status = 'completed', updated_at = time::now() WHERE organization_id = $organization_id AND run_id = $run_id;",
        {
          receipt_id: randomUUID(),
          run_id: run.run_id,
          organization_id: context.organizationId,
          role_key: run.role_key,
          model_profile_id: run.model_profile_id,
          bundle_version: run.bundle_version,
          sample_count: input.sampleCount,
          quality_score: input.qualityScore,
          latency_ms: input.latencyMs,
          cost_micros: input.costMicros,
          privacy_allowed: input.privacyAllowed,
          completed: input.completed,
          input_checksum: run.input_checksum,
          receipt_checksum: receiptChecksum,
          command_id: input.commandId,
          request_hash: requestHash,
        },
      );
      if (!created[0]) throw new Error("평가 receipt 생성 결과가 없습니다");
      return receiptView(created[0]);
    });
  }

  /** 고정된 평가 묶음의 모든 case를 실행하고 하나의 불변 receipt로 집계합니다. */
  public async executeEvaluation(
    context: TenantContext,
    input: ExecuteEvaluationInput,
  ): Promise<StoredEvaluationReceipt> {
    const executor = this.options.executor;
    if (!executor) throw new Error("모델 평가 실행기가 구성되지 않았습니다");
    await this.organizations.verifyTenantContext(context);
    assertText(input.commandId, "명령 식별자");
    assertRole(input.roleKey);
    assertText(input.bundleId, "bundle 식별자");
    assertText(input.modelProfileId, "model profile 식별자");
    assertText(input.runtimeVersion, "runtime version");
    const mode = input.mode ?? "standard";

    const [bundles] = await this.database.query<[BundleRecord[]]>(
      "SELECT * OMIT id FROM optimization_bundle WHERE organization_id = $organization_id AND bundle_id = $bundle_id LIMIT 1;",
      { organization_id: context.organizationId, bundle_id: input.bundleId },
    );
    const bundle = bundles[0];
    if (!bundle || bundle.role_key !== input.roleKey) throw new Error("평가 bundle을 찾을 수 없거나 역할이 다릅니다");
    const cases = await this.listBundleCases(context, bundle.bundle_id);
    if (!cases.length) throw new Error("평가 bundle에 case가 없습니다");

    let profile: OptimizationModelProfile | undefined;
    if (this.options.modelCatalog) {
      const profiles = await this.options.modelCatalog(context);
      profile = profiles.find((candidate) => candidate.modelProfileId === input.modelProfileId);
      if (!profile || !profile.verified) throw new Error("검증된 연결 모델 profile이 아닙니다");
    }

    const inputChecksum =
      input.inputChecksum ??
      digest({
        bundleChecksum: bundle.checksum,
        caseChecksums: cases.map((item) => [item.promptChecksum, item.toolsChecksum, item.environmentChecksum]),
        roleKey: input.roleKey,
        modelProfileId: input.modelProfileId,
        runtimeVersion: input.runtimeVersion,
        mode,
      });
    assertChecksum(inputChecksum, "평가 입력");
    const run = await this.startEvaluation(context, {
      commandId: `${input.commandId}:run`,
      roleKey: input.roleKey,
      bundleId: input.bundleId,
      modelProfileId: input.modelProfileId,
      runtimeVersion: input.runtimeVersion,
      mode,
      inputChecksum,
    });
    const capabilities: EvaluationCapabilities = {
      write: false,
      message: false,
      deployment: false,
      approval: false,
      organizationMutation: false,
    };
    const results: ModelEvaluationExecutionResult[] = [];
    try {
      for (const evaluationCase of cases) {
        const result = await executor.execute({
          context,
          organizationId: context.organizationId,
          roleKey: input.roleKey,
          modelProfileId: input.modelProfileId,
          runtimeVersion: input.runtimeVersion,
          mode,
          run,
          case: evaluationCase,
          ...(profile ? { profile } : {}),
          capabilities,
        });
        this.assertExecutionResult(result);
        results.push(result);
      }
    } catch (error) {
      await this.markRunFailed(context, run.runId);
      throw error;
    }
    const sampleCount = results.length;
    return await this.completeEvaluation(context, {
      commandId: `${input.commandId}:receipt`,
      runId: run.runId,
      sampleCount,
      qualityScore: results.reduce((total, result) => total + result.qualityScore, 0) / sampleCount,
      latencyMs: results.reduce((total, result) => total + result.latencyMs, 0) / sampleCount,
      costMicros: results.reduce((total, result) => total + result.costMicros, 0),
      privacyAllowed: results.every((result) => result.privacyAllowed),
      completed: results.every((result) => result.completed),
    });
  }

  public async configurePolicy(
    context: TenantContext,
    input: ConfigureOptimizationPolicyInput,
  ): Promise<OptimizationPolicyVersion> {
    await this.organizations.verifyTenantContext(context);
    assertText(input.commandId, "명령 식별자");
    assertText(input.governanceDecisionId, "거버넌스 결정 식별자");
    if (!["quality", "value", "speed", "privacy", "manual"].includes(input.policy))
      throw new Error("모델 평가 정책이 유효하지 않습니다");
    const minimumSampleCount = input.minimumSampleCount ?? 3;
    const improvementThreshold = input.improvementThreshold ?? 0.05;
    const observationBudgetMicros = input.observationBudgetMicros ?? 1_000_000;
    const observationRetentionDays = input.observationRetentionDays ?? 30;
    if (!Number.isSafeInteger(minimumSampleCount) || minimumSampleCount < 1)
      throw new Error("모델 평가 최소 표본 수가 유효하지 않습니다");
    if (!Number.isFinite(improvementThreshold) || improvementThreshold < 0 || improvementThreshold > 1)
      throw new Error("모델 평가 개선 기준이 유효하지 않습니다");
    if (!Number.isFinite(observationBudgetMicros) || observationBudgetMicros <= 0)
      throw new Error("실사용 observation 예산이 유효하지 않습니다");
    if (
      !Number.isSafeInteger(observationRetentionDays) ||
      observationRetentionDays < 1 ||
      observationRetentionDays > 3650
    )
      throw new Error("실사용 observation 보존 기간이 유효하지 않습니다");
    return await this.database.transaction(async (tx) => {
      const requestHash = digest(input);
      const repeated = await this.command<PolicyRecord>(
        tx,
        context.organizationId,
        "optimization_policy_version",
        input.commandId,
      );
      if (repeated) {
        if (repeated.request_hash !== requestHash)
          throw new Error("같은 commandId에 다른 최적화 정책을 사용할 수 없습니다");
        return policyView(repeated);
      }
      const current = await this.activePolicy(tx, context.organizationId);
      if (current) {
        await tx.query(
          "UPDATE optimization_policy_version SET status = 'superseded', superseded_at = time::now() WHERE organization_id = $organization_id AND policy_version_id = $policy_version_id AND status = 'active';",
          { organization_id: context.organizationId, policy_version_id: current.policy_version_id },
        );
      }
      const version = (current?.version ?? 0) + 1;
      const policyChecksum = digest({
        policy: input.policy,
        autoOptimize: input.autoOptimize,
        productionLearning: input.productionLearning,
        shadowEnabled: input.shadowEnabled,
        minimumSampleCount,
        improvementThreshold,
        observationBudgetMicros,
        observationRetentionDays,
        version,
      });
      const [created] = await tx.query<[PolicyRecord[]]>(
        "CREATE optimization_policy_version CONTENT { policy_version_id: $policy_version_id, organization_id: $organization_id, version: $version, policy: $policy, auto_optimize: $auto_optimize, production_learning: $production_learning, shadow_enabled: $shadow_enabled, minimum_sample_count: $minimum_sample_count, improvement_threshold: $improvement_threshold, observation_budget_micros: $observation_budget_micros, observation_retention_days: $observation_retention_days, status: 'active', checksum: $checksum, governance_decision_id: $governance_decision_id, command_id: $command_id, request_hash: $request_hash, created_by_user_id: $user_id, created_at: time::now() } RETURN AFTER;",
        {
          policy_version_id: randomUUID(),
          organization_id: context.organizationId,
          version,
          policy: input.policy,
          auto_optimize: input.autoOptimize,
          production_learning: input.productionLearning,
          shadow_enabled: input.shadowEnabled,
          minimum_sample_count: minimumSampleCount,
          improvement_threshold: improvementThreshold,
          observation_budget_micros: observationBudgetMicros,
          observation_retention_days: observationRetentionDays,
          status: "active",
          checksum: policyChecksum,
          governance_decision_id: input.governanceDecisionId,
          command_id: input.commandId,
          request_hash: requestHash,
          user_id: context.userId,
        },
      );
      if (!created[0]) throw new Error("최적화 정책 생성 결과가 없습니다");
      return policyView(created[0]);
    });
  }

  public async getActivePolicy(context: TenantContext): Promise<OptimizationPolicyVersion | undefined> {
    await this.organizations.verifyTenantContext(context);
    const record = await this.activePolicy(this.database, context.organizationId);
    return record ? policyView(record) : undefined;
  }

  public async recommend(context: TenantContext, input: RecommendInput): Promise<ModelRecommendationRecord> {
    await this.organizations.verifyTenantContext(context);
    assertText(input.commandId, "명령 식별자");
    assertRole(input.roleKey);
    const policy = (await this.getActivePolicy(context)) ?? {
      policyVersionId: "implicit-default",
      organizationId: context.organizationId,
      version: 0,
      policy: "quality" as const,
      autoOptimize: false,
      productionLearning: false,
      shadowEnabled: false,
      minimumSampleCount: 3,
      improvementThreshold: 0.05,
      status: "active" as const,
      checksum: digest("implicit-default"),
    };
    const candidates =
      input.candidates.length > 0 || !this.options.modelCatalog
        ? input.candidates
        : await this.options.modelCatalog(context);
    const scored: ModelRecommendation = recommendModels({
      roleKey: input.roleKey,
      policy: policy.policy,
      candidates,
      receipts: input.receipts,
      requirements: input.requirements,
      ...(input.manualModelProfileId ? { manualModelProfileId: input.manualModelProfileId } : {}),
      minimumSampleCount: policy.minimumSampleCount,
    });
    const requestHash = digest(input);
    return await this.database.transaction(async (tx) => {
      const repeated = await this.command<RecommendationRecord>(
        tx,
        context.organizationId,
        "optimization_recommendation",
        input.commandId,
      );
      if (repeated) {
        if (repeated.request_hash !== requestHash)
          throw new Error("같은 commandId에 다른 모델 추천을 사용할 수 없습니다");
        return recommendationView(repeated);
      }
      const profileIds = [
        scored.primary?.modelProfileId,
        ...scored.fallbacks.map((candidate) => candidate.modelProfileId),
      ].filter((value): value is string => value !== undefined);
      const [receipts] = await tx.query<[ReceiptRecord[]]>(
        "SELECT * OMIT id FROM optimization_receipt WHERE organization_id = $organization_id AND role_key = $role_key AND model_profile_id IN $profile_ids ORDER BY created_at DESC;",
        { organization_id: context.organizationId, role_key: input.roleKey, profile_ids: profileIds },
      );
      const receiptIds = receipts.map((receipt) => receipt.receipt_id);
      const recommendationChecksum = digest({
        roleKey: input.roleKey,
        policyVersionId: policy.policyVersionId,
        primaryModelProfileId: scored.primary?.modelProfileId,
        fallbackModelProfileIds: scored.fallbacks.map((candidate) => candidate.modelProfileId),
        excluded: scored.excluded,
        receiptIds,
      });
      const [created] = await tx.query<[RecommendationRecord[]]>(
        "CREATE optimization_recommendation CONTENT { recommendation_id: $recommendation_id, organization_id: $organization_id, role_key: $role_key, policy_version_id: $policy_version_id, primary_model_profile_id: $primary_model_profile_id, fallback_model_profile_ids: $fallback_model_profile_ids, excluded_json: $excluded_json, receipt_ids: $receipt_ids, status: $status, checksum: $checksum, command_id: $command_id, request_hash: $request_hash, created_by_user_id: $user_id, created_at: time::now() } RETURN AFTER;",
        {
          recommendation_id: randomUUID(),
          organization_id: context.organizationId,
          role_key: input.roleKey,
          policy_version_id: policy.policyVersionId,
          primary_model_profile_id: scored.primary?.modelProfileId,
          fallback_model_profile_ids: scored.fallbacks.map((candidate) => candidate.modelProfileId),
          excluded_json: JSON.stringify(scored.excluded),
          receipt_ids: receiptIds,
          status: policy.autoOptimize && scored.primary ? "approved" : "pending-approval",
          checksum: recommendationChecksum,
          command_id: input.commandId,
          request_hash: requestHash,
          user_id: context.userId,
        },
      );
      if (!created[0]) throw new Error("모델 추천 생성 결과가 없습니다");
      return recommendationView(created[0]);
    });
  }

  public async listReceipts(
    context: TenantContext,
    roleKey?: OptimizationRoleKey,
  ): Promise<readonly StoredEvaluationReceipt[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[ReceiptRecord[]]>(
      roleKey
        ? "SELECT * OMIT id FROM optimization_receipt WHERE organization_id = $organization_id AND role_key = $role_key ORDER BY created_at DESC;"
        : "SELECT * OMIT id FROM optimization_receipt WHERE organization_id = $organization_id ORDER BY created_at DESC;",
      { organization_id: context.organizationId, role_key: roleKey },
    );
    return records.map(receiptView);
  }

  public async listRecommendations(
    context: TenantContext,
    roleKey?: OptimizationRoleKey,
  ): Promise<readonly ModelRecommendationRecord[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[RecommendationRecord[]]>(
      roleKey
        ? "SELECT * OMIT id FROM optimization_recommendation WHERE organization_id = $organization_id AND role_key = $role_key ORDER BY created_at DESC;"
        : "SELECT * OMIT id FROM optimization_recommendation WHERE organization_id = $organization_id ORDER BY created_at DESC;",
      { organization_id: context.organizationId, role_key: roleKey },
    );
    return records.map(recommendationView);
  }

  public async listBundleCases(context: TenantContext, bundleId: string): Promise<readonly EvaluationCase[]> {
    await this.organizations.verifyTenantContext(context);
    const [bundles] = await this.database.query<[BundleRecord[]]>(
      "SELECT * OMIT id FROM optimization_bundle WHERE organization_id = $organization_id AND bundle_id = $bundle_id LIMIT 1;",
      { organization_id: context.organizationId, bundle_id: bundleId },
    );
    const bundle = bundles[0];
    if (!bundle) throw new Error("평가 bundle을 찾을 수 없습니다");
    const [cases] = await this.database.query<
      [
        Array<{
          readonly case_id: string;
          readonly version: number;
          readonly prompt_checksum: string;
          readonly tools_checksum: string;
          readonly environment_checksum: string;
          readonly prompt?: string;
          readonly expected_outcome: string;
        }>,
      ]
    >(
      "SELECT * OMIT id FROM optimization_case WHERE organization_id = $organization_id AND case_id IN $case_ids ORDER BY case_id ASC;",
      { organization_id: context.organizationId, case_ids: bundle.case_ids },
    );
    return cases.map((item) => ({
      caseId: item.case_id,
      roleKey: bundle.role_key,
      version: item.version,
      promptChecksum: item.prompt_checksum,
      toolsChecksum: item.tools_checksum,
      environmentChecksum: item.environment_checksum,
      ...(item.prompt ? { prompt: item.prompt } : {}),
      expectedOutcome: item.expected_outcome,
    }));
  }

  public async exportBundle(context: TenantContext, input: ExportBundleInput): Promise<EvaluationExport> {
    await this.organizations.verifyTenantContext(context);
    assertText(input.bundleId, "bundle 식별자");
    const [bundles] = await this.database.query<[BundleRecord[]]>(
      "SELECT * OMIT id FROM optimization_bundle WHERE organization_id = $organization_id AND bundle_id = $bundle_id LIMIT 1;",
      { organization_id: context.organizationId, bundle_id: input.bundleId },
    );
    const bundle = bundles[0];
    if (!bundle) throw new Error("평가 bundle을 찾을 수 없습니다");
    const cases = await this.listBundleCases(context, bundle.bundle_id);
    return createEvaluationExport({
      license: input.license,
      configurationChecksum: input.configurationChecksum,
      bundle: bundleView(bundle),
      cases,
    });
  }

  public async importBundle(context: TenantContext, input: ImportBundleInput): Promise<EvaluationBundle> {
    await this.organizations.verifyTenantContext(context);
    assertText(input.commandId, "명령 식별자");
    const imported = validateEvaluationExport(input.exportValue);
    return await this.createBundle(context, {
      commandId: input.commandId,
      roleKey: imported.bundle.roleKey,
      runtimeVersion: imported.bundle.runtimeVersion,
      cases: imported.cases.map((evaluationCase) => ({
        promptChecksum: evaluationCase.promptChecksum,
        toolsChecksum: evaluationCase.toolsChecksum,
        environmentChecksum: evaluationCase.environmentChecksum,
        ...(evaluationCase.prompt === undefined ? {} : { prompt: evaluationCase.prompt }),
        expectedOutcome: evaluationCase.expectedOutcome,
      })),
    });
  }

  private async activePolicy(executor: QueryExecutor, organizationId: string): Promise<PolicyRecord | undefined> {
    const [records] = await executor.query<[PolicyRecord[]]>(
      "SELECT * OMIT id FROM optimization_policy_version WHERE organization_id = $organization_id AND status = 'active' ORDER BY version DESC LIMIT 1;",
      { organization_id: organizationId },
    );
    return records[0];
  }

  private assertExecutionResult(result: ModelEvaluationExecutionResult): void {
    if (
      !Number.isFinite(result.qualityScore) ||
      result.qualityScore < 0 ||
      result.qualityScore > 1 ||
      !Number.isFinite(result.latencyMs) ||
      result.latencyMs < 0 ||
      !Number.isFinite(result.costMicros) ||
      result.costMicros < 0 ||
      typeof result.privacyAllowed !== "boolean" ||
      typeof result.completed !== "boolean"
    ) {
      throw new Error("모델 평가 실행 결과가 유효하지 않습니다");
    }
  }

  private async markRunFailed(context: TenantContext, runId: string): Promise<void> {
    await this.database.query(
      "UPDATE optimization_run SET status = 'failed', updated_at = time::now() WHERE organization_id = $organization_id AND run_id = $run_id AND status = 'running';",
      { organization_id: context.organizationId, run_id: runId },
    );
  }

  private async command<T extends { readonly request_hash: string }>(
    executor: QueryExecutor,
    organizationId: string,
    table: string,
    commandId: string,
  ): Promise<T | undefined> {
    const allowed = new Set([
      "optimization_bundle",
      "optimization_run",
      "optimization_receipt",
      "optimization_policy_version",
      "optimization_recommendation",
    ]);
    if (!allowed.has(table)) throw new Error("허용되지 않은 최적화 command table입니다");
    const [records] = await executor.query<[T[]]>(
      `SELECT * OMIT id FROM ${table} WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;`,
      { organization_id: organizationId, command_id: commandId },
    );
    return records[0];
  }
}

export { scoreReceipt };
