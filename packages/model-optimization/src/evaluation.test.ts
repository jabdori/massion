import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { ModelOptimizationStore, type OptimizationModelProfile } from "./evaluation.js";

const checksum = (letter: string) => letter.repeat(64);

describe("Massion 모델 평가실", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let store: ModelOptimizationStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({
      email: "optimization@example.com",
      displayName: "Optimization",
    });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    store = await ModelOptimizationStore.create(database, organizations);
  });

  afterEach(async () => database.close());

  it("평가 bundle·run·receipt를 checksum과 함께 append-only로 저장한다", async () => {
    const bundle = await store.createBundle(context, {
      commandId: "bundle-1",
      roleKey: "context-strategy",
      runtimeVersion: "runtime-1",
      cases: [
        {
          promptChecksum: checksum("a"),
          toolsChecksum: checksum("b"),
          environmentChecksum: checksum("c"),
          expectedOutcome: "plan",
        },
      ],
    });
    const run = await store.startEvaluation(context, {
      commandId: "run-1",
      roleKey: "context-strategy",
      bundleId: bundle.bundleId,
      modelProfileId: "profile-sol",
      runtimeVersion: "runtime-1",
      inputChecksum: checksum("d"),
    });
    const receipt = await store.completeEvaluation(context, {
      commandId: "receipt-1",
      runId: run.runId,
      sampleCount: 10,
      qualityScore: 0.92,
      latencyMs: 200,
      costMicros: 12,
      privacyAllowed: true,
      completed: true,
    });

    expect(bundle.version).toBe(1);
    expect(run.status).toBe("running");
    expect(receipt).toMatchObject({ runId: run.runId, modelProfileId: "profile-sol", sampleCount: 10 });
    await expect(
      store.completeEvaluation(context, {
        commandId: "receipt-1",
        runId: run.runId,
        sampleCount: 1,
        qualityScore: 0.1,
        latencyMs: 1,
        costMicros: 1,
        privacyAllowed: true,
        completed: true,
      }),
    ).rejects.toThrow("같은 commandId");
  });

  it("기본 review 정책에서는 추천 승인 전 batch를 활성화하지 않고 shadow를 차단한다", async () => {
    const profile = (id: string, quality: number): OptimizationModelProfile => ({
      modelProfileId: id,
      modelId: id,
      routeId: `route-${id}`,
      providerId: "openai-codex",
      verified: true,
      supportsStructuredOutput: true,
      supportsTools: true,
      supportsStreaming: true,
      dataPolicy: "external-allowed",
    });
    const bundle = await store.createBundle(context, {
      commandId: "bundle-review",
      roleKey: "assurance",
      runtimeVersion: "runtime-1",
      cases: [
        {
          promptChecksum: checksum("a"),
          toolsChecksum: checksum("b"),
          environmentChecksum: checksum("c"),
          expectedOutcome: "verify",
        },
      ],
    });
    const run = await store.startEvaluation(context, {
      commandId: "run-review",
      roleKey: "assurance",
      bundleId: bundle.bundleId,
      modelProfileId: "profile-quality",
      runtimeVersion: "runtime-1",
      inputChecksum: checksum("d"),
    });
    const receipt = await store.completeEvaluation(context, {
      commandId: "receipt-review",
      runId: run.runId,
      sampleCount: 5,
      qualityScore: 0.95,
      latencyMs: 100,
      costMicros: 10,
      privacyAllowed: true,
      completed: true,
    });
    const recommendation = await store.recommend(context, {
      commandId: "recommend-review",
      roleKey: "assurance",
      candidates: [profile("profile-quality", 0.95)],
      receipts: [
        {
          roleKey: "assurance",
          modelProfileId: "profile-quality",
          bundleVersion: 1,
          sampleCount: receipt.sampleCount,
          qualityScore: receipt.qualityScore,
          latencyMs: receipt.latencyMs,
          costMicros: receipt.costMicros,
          privacyAllowed: true,
          completed: true,
          inputChecksum: receipt.inputChecksum,
          receiptChecksum: receipt.receiptChecksum,
        },
      ],
      requirements: {
        requiresTools: true,
        requiresStructuredOutput: true,
        requiresStreaming: true,
        dataPolicy: "external-allowed",
      },
    });
    expect(recommendation.status).toBe("pending-approval");
    await expect(
      store.startEvaluation(context, {
        commandId: "shadow-blocked",
        roleKey: "assurance",
        bundleId: bundle.bundleId,
        modelProfileId: "profile-quality",
        runtimeVersion: "runtime-1",
        inputChecksum: checksum("e"),
        mode: "shadow",
      }),
    ).rejects.toThrow("shadow");
  });
});
