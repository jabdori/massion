import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { ModelOptimizationStore, OptimizationBatchService } from "@massion/model-optimization";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { ApplicationCommandRegistry } from "./command-registry.js";
import { ApplicationCommandStore } from "./command-store.js";
import { registerApplicationDomainCommands } from "./adapters/domain.js";

describe("Application model optimization operations", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let registry: ApplicationCommandRegistry;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({
      email: "application-optimization@example.com",
      displayName: "Optimization API",
    });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const evaluations = await ModelOptimizationStore.create(database, organizations, {
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
    const batches = await OptimizationBatchService.create(database, organizations);
    registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    registerApplicationDomainCommands(registry, { optimization: { evaluations, batches } });
  });

  afterEach(async () => database.close());

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
});
