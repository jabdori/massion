import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { GovernanceApprovalRequiredError } from "@massion/governance";
import { ModelOptimizationStore, OptimizationBatchService } from "@massion/model-optimization";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { ApplicationCommandRegistry } from "./command-registry.js";
import { ApplicationCommandStore } from "./command-store.js";
import { registerApplicationDomainCommands } from "./adapters/domain.js";

describe("Application model optimization operations", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let registry: ApplicationCommandRegistry;
  let organizations: OrganizationService;
  let evaluations: ModelOptimizationStore;
  let batches: OptimizationBatchService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({
      email: "application-optimization@example.com",
      displayName: "Optimization API",
    });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    evaluations = await ModelOptimizationStore.create(database, organizations, {
      executor: {
        execute: async () => ({
          qualityScore: 0.9,
          latencyMs: 10,
          costMicros: 1,
          privacyAllowed: true,
          completed: true,
        }),
      },
    });
    batches = await OptimizationBatchService.create(database, organizations);
    registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    registerApplicationDomainCommands(registry, { optimization: { evaluations, batches } });
  });

  afterEach(async () => database.close());

  it("legacy governanceDecisionId 직접 입력을 거부한다", async () => {
    await expect(
      registry.dispatch(context, ["optimization:write"], {
        schemaVersion: "massion.application.v1",
        commandId: "optimization-legacy-decision-command",
        correlationId: "optimization-legacy-decision-correlation",
        operation: "optimization.recommendation.approve",
        payload: {
          recommendationId: "recommendation-legacy",
          governanceDecisionId: "decision-forged",
        },
      }),
    ).rejects.toMatchObject({ category: "validation", operatorCode: "APP_COMMAND_VALIDATION" });
  });

  it("추천 승인은 checksum이 결합된 Governance 요청을 승인 ID로 재개한다", async () => {
    const recommendation = await evaluations.recommend(context, {
      commandId: "optimization-approval-recommendation",
      roleKey: "assurance",
      candidates: [
        {
          modelProfileId: "profile-governed",
          modelId: "model-governed",
          routeId: "route-governed",
          providerId: "provider-governed",
          verified: true,
          supportsStructuredOutput: true,
          supportsTools: true,
          supportsStreaming: true,
          dataPolicy: "external-allowed",
        },
      ],
      receipts: [
        {
          roleKey: "assurance",
          modelProfileId: "profile-governed",
          bundleVersion: 1,
          sampleCount: 3,
          qualityScore: 0.9,
          latencyMs: 10,
          costMicros: 1,
          privacyAllowed: true,
          completed: true,
          inputChecksum: "a".repeat(64),
          receiptChecksum: "b".repeat(64),
        },
      ],
      requirements: {
        requiresTools: false,
        requiresStructuredOutput: false,
        requiresStreaming: false,
        dataPolicy: "external-allowed",
      },
    });
    const authorize = vi
      .fn()
      .mockRejectedValueOnce(new GovernanceApprovalRequiredError("decision-governed", "approval-governed"))
      .mockResolvedValueOnce({
        outcome: "allow",
        decision: { decisionId: "decision-governed" },
        permit: { approval_id: "approval-governed" },
      });
    registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    registerApplicationDomainCommands(registry, {
      governanceGate: { authorize } as never,
      optimization: { evaluations, batches },
    });
    const command = {
      schemaVersion: "massion.application.v1" as const,
      commandId: "optimization-approval-command",
      correlationId: "optimization-approval-correlation",
      operation: "optimization.recommendation.approve",
    };

    const awaiting = await registry.dispatch(context, ["optimization:write"], {
      ...command,
      payload: { recommendationId: recommendation.recommendationId },
    });
    expect(awaiting).toMatchObject({
      outcome: "awaiting-approval",
      data: { decisionId: expect.any(String), approvalId: expect.any(String) },
    });
    const approvalId = (awaiting.data as { readonly approvalId: string }).approvalId;

    await expect(
      registry.dispatch(context, ["optimization:write"], {
        ...command,
        payload: { recommendationId: recommendation.recommendationId, approvalId },
      }),
    ).resolves.toMatchObject({ outcome: "succeeded", data: { status: "approved" } });
    const [recommendationRows] = await database.query<[Array<{ governance_decision_id: string }>]>(
      "SELECT governance_decision_id FROM optimization_recommendation WHERE organization_id = $organization_id AND recommendation_id = $recommendation_id;",
      {
        organization_id: context.organizationId,
        recommendation_id: recommendation.recommendationId,
      },
    );
    expect(recommendationRows).toEqual([{ governance_decision_id: "decision-governed" }]);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(authorize.mock.calls[0]?.[1]).toMatchObject({
      action: "model.optimization.approve",
      resource: {
        type: "OptimizationRecommendation",
        id: recommendation.recommendationId,
        attributes: { recommendationChecksum: recommendation.checksum },
      },
    });
    expect(authorize.mock.calls[1]?.[1]).toMatchObject({ approvalId: "approval-governed" });
    await expect(
      registry.dispatch(context, ["optimization:write"], {
        ...command,
        commandId: "optimization-approval-command-forged-retry",
        payload: { recommendationId: recommendation.recommendationId },
      }),
    ).rejects.toThrow();
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("정책과 평가 bundle을 Application operation으로 tenant 격리해 생성한다", async () => {
    const envelope = (commandId: string, operation: string, payload: unknown) => ({
      schemaVersion: "massion.application.v1",
      commandId,
      correlationId: `${commandId}-correlation`,
      operation,
      payload,
    });
    await expect(
      registry.dispatch(
        context,
        ["optimization:write"],
        envelope("optimization-policy", "optimization.policy.configure", {
          policy: "value",
          autoOptimize: false,
          productionLearning: false,
          shadowEnabled: false,
          observationBudgetMicros: 25000,
          observationRetentionDays: 14,
          governanceDecisionId: "decision-optimization",
        }),
      ),
    ).resolves.toMatchObject({ outcome: "succeeded", resource: { type: "OptimizationPolicy" } });
    await expect(
      registry.dispatch(
        context,
        ["optimization:write"],
        envelope("optimization-bundle", "optimization.bundle.create", {
          roleKey: "assurance",
          runtimeVersion: "runtime-1",
          cases: [
            {
              promptChecksum: "a".repeat(64),
              toolsChecksum: "b".repeat(64),
              environmentChecksum: "c".repeat(64),
              expectedOutcome: "pass",
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({ outcome: "succeeded", resource: { type: "OptimizationBundle", revision: 1 } });
  });

  it("평가 실행 operation은 저장된 bundle을 실제 evaluator port로 전달한다", async () => {
    const envelope = (commandId: string, operation: string, payload: unknown) => ({
      schemaVersion: "massion.application.v1",
      commandId,
      correlationId: `${commandId}-correlation`,
      operation,
      payload,
    });
    const bundle = await registry.dispatch(
      context,
      ["optimization:write"],
      envelope("execute-bundle", "optimization.bundle.create", {
        roleKey: "assurance",
        runtimeVersion: "runtime-1",
        cases: [
          {
            promptChecksum: "a".repeat(64),
            toolsChecksum: "b".repeat(64),
            environmentChecksum: "c".repeat(64),
            expectedOutcome: "pass",
          },
        ],
      }),
    );
    const bundleId = (bundle as { readonly data?: { readonly bundleId?: string } }).data?.bundleId;
    await expect(
      registry.dispatch(
        context,
        ["optimization:write"],
        envelope("execute-run", "optimization.evaluation.execute", {
          roleKey: "assurance",
          bundleId,
          modelProfileId: "profile-1",
          runtimeVersion: "runtime-1",
          mode: "standard",
        }),
      ),
    ).resolves.toMatchObject({ outcome: "succeeded", resource: { type: "OptimizationReceipt" } });
  });

  it("평가 bundle export/import operation은 license와 configuration checksum을 검증한다", async () => {
    const envelope = (commandId: string, operation: string, payload: unknown) => ({
      schemaVersion: "massion.application.v1",
      commandId,
      correlationId: `${commandId}-correlation`,
      operation,
      payload,
    });
    const created = await registry.dispatch(
      context,
      ["optimization:write"],
      envelope("transfer-bundle", "optimization.bundle.create", {
        roleKey: "assurance",
        runtimeVersion: "runtime-1",
        cases: [
          {
            promptChecksum: "a".repeat(64),
            toolsChecksum: "b".repeat(64),
            environmentChecksum: "c".repeat(64),
            expectedOutcome: "pass",
          },
        ],
      }),
    );
    const bundleId = (created as { readonly data?: { readonly bundleId?: string } }).data?.bundleId;
    const exported = await registry.dispatch(
      context,
      ["optimization:read"],
      envelope("transfer-export", "optimization.bundle.export", {
        bundleId,
        license: "MIT",
        configurationChecksum: "d".repeat(64),
      }),
    );
    const exportValue = (exported as { readonly data?: unknown }).data;
    await expect(
      registry.dispatch(
        context,
        ["optimization:write"],
        envelope("transfer-import", "optimization.bundle.import", { export: exportValue }),
      ),
    ).resolves.toMatchObject({ outcome: "succeeded", resource: { type: "OptimizationBundle" } });
  });

  it("승격 게이트 거부는 내부 오류가 아닌 구조화된 정책 오류로 반환한다", async () => {
    const gateRegistry = new ApplicationCommandRegistry(
      await ApplicationCommandStore.create(database, await OrganizationService.create(database)),
    );
    registerApplicationDomainCommands(gateRegistry, {
      optimization: {
        evaluations: {} as never,
        batches: {
          activateBatch: async () => {
            throw new Error("candidate batch는 승격 게이트를 거친 뒤 활성화할 수 없습니다");
          },
        } as never,
      },
    });

    await expect(
      gateRegistry.dispatch(context, ["optimization:write"], {
        schemaVersion: "massion.application.v1",
        commandId: "optimization-gate-command",
        correlationId: "optimization-gate-correlation",
        operation: "optimization.batch.activate",
        payload: { batchId: "candidate-batch" },
      }),
    ).rejects.toMatchObject({
      category: "policy",
      operatorCode: "APP_OPTIMIZATION_POLICY_GATE",
    });
  });
});
