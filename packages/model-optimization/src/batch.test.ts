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
});
