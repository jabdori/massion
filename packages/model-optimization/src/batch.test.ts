import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { OptimizationBatchService } from "./batch.js";

describe("모델 최적화 batch lifecycle", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let batches: OptimizationBatchService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "batch@example.com", displayName: "Batch" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    batches = await OptimizationBatchService.create(database, organizations);
  });

  afterEach(async () => database.close());

  it("승인된 추천만 immutable version batch로 원자 활성화한다", async () => {
    await database.query(
      "CREATE optimization_recommendation CONTENT { recommendation_id: 'recommendation-1', organization_id: $organization_id, role_key: 'assurance', policy_version_id: 'policy-1', primary_model_profile_id: 'profile-1', fallback_model_profile_ids: ['profile-2'], excluded_json: '[]', receipt_ids: ['receipt-1'], status: 'pending-approval', checksum: $checksum, command_id: 'recommendation-command', request_hash: $request_hash, created_by_user_id: $user_id, created_at: time::now() };",
      {
        organization_id: context.organizationId,
        checksum: "a".repeat(64),
        request_hash: "b".repeat(64),
        user_id: context.userId,
      },
    );
    const approved = await batches.approveRecommendation(context, {
      commandId: "approve-1",
      recommendationId: "recommendation-1",
      governanceDecisionId: "decision-1",
    });
    expect(approved.status).toBe("approved");
    const candidate = await batches.createBatch(context, {
      commandId: "batch-1",
      recommendationId: approved.recommendationId,
      status: "limited",
    });
    await expect(
      batches.createBatch(context, {
        commandId: "batch-1",
        recommendationId: approved.recommendationId,
        status: "limited",
      }),
    ).resolves.toEqual(candidate);
    await expect(
      batches.createBatch(context, {
        commandId: "batch-1",
        recommendationId: approved.recommendationId,
        status: "shadow",
      }),
    ).rejects.toThrow("같은 commandId");
    expect(candidate.status).toBe("limited");
    const active = await batches.activateBatch(context, { commandId: "activate-1", batchId: candidate.batchId });
    expect(active.status).toBe("active");
    expect(await batches.getActiveBatch(context, "assurance")).toMatchObject({
      batchId: candidate.batchId,
      status: "active",
    });
  });

  it("degraded 관측은 실행 중 batch를 자동으로 이전 healthy batch로 복구한다", async () => {
    await database.query(
      "CREATE optimization_recommendation CONTENT { recommendation_id: 'recommendation-old', organization_id: $organization_id, role_key: 'growth', policy_version_id: 'policy-1', primary_model_profile_id: 'profile-old', fallback_model_profile_ids: [], excluded_json: '[]', receipt_ids: [], status: 'approved', checksum: $checksum, command_id: 'recommendation-old-command', request_hash: $request_hash, created_by_user_id: $user_id, created_at: time::now() }; CREATE optimization_recommendation CONTENT { recommendation_id: 'recommendation-new', organization_id: $organization_id, role_key: 'growth', policy_version_id: 'policy-1', primary_model_profile_id: 'profile-new', fallback_model_profile_ids: [], excluded_json: '[]', receipt_ids: [], status: 'approved', checksum: $checksum2, command_id: 'recommendation-new-command', request_hash: $request_hash2, created_by_user_id: $user_id, created_at: time::now() };",
      {
        organization_id: context.organizationId,
        checksum: "a".repeat(64),
        request_hash: "b".repeat(64),
        checksum2: "c".repeat(64),
        request_hash2: "d".repeat(64),
        user_id: context.userId,
      },
    );
    const oldBatch = await batches.createBatch(context, {
      commandId: "batch-old",
      recommendationId: "recommendation-old",
      status: "active",
    });
    await batches.activateBatch(context, { commandId: "activate-old", batchId: oldBatch.batchId });
    const newBatch = await batches.createBatch(context, {
      commandId: "batch-new",
      recommendationId: "recommendation-new",
      status: "limited",
    });
    await batches.activateBatch(context, { commandId: "activate-new", batchId: newBatch.batchId });
    const observation = await batches.recordObservation(context, {
      commandId: "observation-1",
      batchId: newBatch.batchId,
      sampleCount: 10,
      qualityScore: 0.2,
      latencyMs: 1000,
      costMicros: 100,
      status: "degraded",
    });
    const recovery = await batches.recover(context, {
      commandId: "recovery-1",
      observationId: observation.observationId,
    });
    expect(recovery.toBatchId).toBe(oldBatch.batchId);
    expect(await batches.getActiveBatch(context, "growth")).toMatchObject({
      batchId: oldBatch.batchId,
      status: "active",
    });
  });

  it("정책이 요구한 최소 표본을 채우지 못한 추천은 제한 batch로 승격하지 않는다", async () => {
    await database.query(
      "CREATE optimization_policy_version CONTENT { policy_version_id: 'policy-gated', organization_id: $organization_id, version: 1, policy: 'quality', auto_optimize: false, production_learning: false, shadow_enabled: true, minimum_sample_count: 3, improvement_threshold: 0.1, status: 'active', checksum: $checksum, governance_decision_id: 'decision-gated', command_id: 'policy-gated-command', request_hash: $request_hash, created_by_user_id: $user_id, created_at: time::now() }; CREATE optimization_recommendation CONTENT { recommendation_id: 'recommendation-gated', organization_id: $organization_id, role_key: 'growth', policy_version_id: 'policy-gated', primary_model_profile_id: 'profile-gated', fallback_model_profile_ids: [], excluded_json: '[]', receipt_ids: ['receipt-gated'], status: 'approved', checksum: $checksum2, command_id: 'recommendation-gated-command', request_hash: $request_hash2, created_by_user_id: $user_id, created_at: time::now() }; CREATE optimization_receipt CONTENT { receipt_id: 'receipt-gated', run_id: 'run-gated', organization_id: $organization_id, role_key: 'growth', model_profile_id: 'profile-gated', bundle_version: 1, sample_count: 1, quality_score: 0.9, latency_ms: 100, cost_micros: 10, privacy_allowed: true, completed: true, input_checksum: $checksum3, receipt_checksum: $checksum4, command_id: 'receipt-gated-command', request_hash: $request_hash3, created_at: time::now() };",
      {
        organization_id: context.organizationId,
        checksum: "a".repeat(64),
        request_hash: "b".repeat(64),
        checksum2: "c".repeat(64),
        request_hash2: "d".repeat(64),
        checksum3: "e".repeat(64),
        checksum4: "f".repeat(64),
        request_hash3: "1".repeat(64),
        user_id: context.userId,
      },
    );

    await expect(
      batches.createBatch(context, {
        commandId: "batch-gated",
        recommendationId: "recommendation-gated",
        status: "limited",
      }),
    ).rejects.toThrow("최소 표본");
  });

  it("production learning 동의가 없으면 실사용 observation을 기록하지 않는다", async () => {
    await database.query(
      "CREATE optimization_policy_version CONTENT { policy_version_id: 'policy-production-off', organization_id: $organization_id, version: 1, policy: 'quality', auto_optimize: false, production_learning: false, shadow_enabled: true, minimum_sample_count: 1, improvement_threshold: 0, status: 'active', checksum: $checksum, governance_decision_id: 'decision-production-off', command_id: 'policy-production-off-command', request_hash: $request_hash, created_by_user_id: $user_id, created_at: time::now() }; CREATE optimization_recommendation CONTENT { recommendation_id: 'recommendation-production-off', organization_id: $organization_id, role_key: 'assurance', policy_version_id: 'policy-production-off', primary_model_profile_id: 'profile-production-off', fallback_model_profile_ids: [], excluded_json: '[]', receipt_ids: [], status: 'approved', checksum: $checksum2, command_id: 'recommendation-production-off-command', request_hash: $request_hash2, created_by_user_id: $user_id, created_at: time::now() };",
      {
        organization_id: context.organizationId,
        checksum: "a".repeat(64),
        request_hash: "b".repeat(64),
        checksum2: "c".repeat(64),
        request_hash2: "d".repeat(64),
        user_id: context.userId,
      },
    );
    const batch = await batches.createBatch(context, {
      commandId: "batch-production-off",
      recommendationId: "recommendation-production-off",
      status: "candidate",
    });
    await expect(
      batches.recordObservation(context, {
        commandId: "observation-production-off",
        batchId: batch.batchId,
        sampleCount: 1,
        qualityScore: 0.9,
        latencyMs: 100,
        costMicros: 10,
        status: "healthy",
        source: "production",
      }),
    ).rejects.toThrow("production learning");
  });
});
