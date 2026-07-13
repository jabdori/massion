import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { ModelOptimizationStore, type ModelEvaluationExecutor, type OptimizationModelProfile } from "./evaluation.js";

const checksum = (letter: string) => letter.repeat(64);

describe("Massion 모델 평가실", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let organizations: OrganizationService;
  let store: ModelOptimizationStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
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
    const profile = (id: string): OptimizationModelProfile => ({
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
      candidates: [profile("profile-quality")],
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

  it("고정된 평가 case를 실행하고 shadow에서는 모든 정본 변경 capability를 차단한다", async () => {
    const execute = vi.fn<ModelEvaluationExecutor["execute"]>(async (input) => ({
      qualityScore: input.case.expectedOutcome === "first" ? 0.8 : 1,
      latencyMs: input.case.expectedOutcome === "first" ? 100 : 300,
      costMicros: 10,
      privacyAllowed: true,
      completed: true,
      inputTokens: 20,
      outputTokens: 10,
    }));
    store = await ModelOptimizationStore.create(database, organizations, {
      executor: { execute },
    });
    await store.configurePolicy(context, {
      commandId: "policy-shadow",
      policy: "quality",
      autoOptimize: false,
      productionLearning: false,
      shadowEnabled: true,
      governanceDecisionId: "decision-shadow",
    });
    const bundle = await store.createBundle(context, {
      commandId: "bundle-execute",
      roleKey: "assurance",
      runtimeVersion: "runtime-1",
      cases: [
        {
          promptChecksum: checksum("a"),
          toolsChecksum: checksum("b"),
          environmentChecksum: checksum("c"),
          expectedOutcome: "first",
        },
        {
          promptChecksum: checksum("d"),
          toolsChecksum: checksum("e"),
          environmentChecksum: checksum("f"),
          expectedOutcome: "second",
        },
      ],
    });

    const receipt = await store.executeEvaluation(context, {
      commandId: "execute-shadow",
      roleKey: "assurance",
      bundleId: bundle.bundleId,
      modelProfileId: "profile-shadow",
      runtimeVersion: "runtime-1",
      mode: "shadow",
    });

    expect(receipt).toMatchObject({
      roleKey: "assurance",
      modelProfileId: "profile-shadow",
      sampleCount: 2,
      qualityScore: 0.9,
      latencyMs: 200,
      costMicros: 20,
      privacyAllowed: true,
      completed: true,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.every(([input]) => input.mode === "shadow")).toBe(true);
    expect(
      execute.mock.calls.every(
        ([input]) =>
          input.capabilities.write === false &&
          input.capabilities.message === false &&
          input.capabilities.deployment === false &&
          input.capabilities.approval === false &&
          input.capabilities.organizationMutation === false,
      ),
    ).toBe(true);
  });

  it("후보를 생략하면 연결된 model catalog에서만 추천 후보를 읽는다", async () => {
    const profile: OptimizationModelProfile = {
      modelProfileId: "catalog-profile",
      modelId: "catalog-model",
      routeId: "catalog-route",
      providerId: "openai-codex",
      verified: true,
      supportsStructuredOutput: true,
      supportsTools: true,
      supportsStreaming: true,
      dataPolicy: "external-allowed",
    };
    store = await ModelOptimizationStore.create(database, organizations, {
      modelCatalog: async () => [profile],
    });
    const bundle = await store.createBundle(context, {
      commandId: "catalog-bundle",
      roleKey: "representative",
      runtimeVersion: "runtime-1",
      cases: [
        {
          promptChecksum: checksum("a"),
          toolsChecksum: checksum("b"),
          environmentChecksum: checksum("c"),
          expectedOutcome: "respond",
        },
      ],
    });
    const run = await store.startEvaluation(context, {
      commandId: "catalog-run",
      roleKey: "representative",
      bundleId: bundle.bundleId,
      modelProfileId: profile.modelProfileId,
      runtimeVersion: "runtime-1",
      inputChecksum: checksum("d"),
    });
    const receipt = await store.completeEvaluation(context, {
      commandId: "catalog-receipt",
      runId: run.runId,
      sampleCount: 3,
      qualityScore: 0.9,
      latencyMs: 100,
      costMicros: 10,
      privacyAllowed: true,
      completed: true,
    });
    const recommendation = await store.recommend(context, {
      commandId: "catalog-recommendation",
      roleKey: "representative",
      candidates: [],
      receipts: [
        {
          roleKey: "representative",
          modelProfileId: profile.modelProfileId,
          bundleVersion: receipt.bundleVersion,
          sampleCount: receipt.sampleCount,
          qualityScore: receipt.qualityScore,
          latencyMs: receipt.latencyMs,
          costMicros: receipt.costMicros,
          privacyAllowed: receipt.privacyAllowed,
          completed: receipt.completed,
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
    expect(recommendation.primaryModelProfileId).toBe(profile.modelProfileId);
  });
});
