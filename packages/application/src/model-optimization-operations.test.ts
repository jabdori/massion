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
    const evaluations = await ModelOptimizationStore.create(database, organizations);
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
});
