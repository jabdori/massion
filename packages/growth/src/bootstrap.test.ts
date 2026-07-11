import { afterEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { GrowthBootstrap, decideGrowthBootstrap } from "./bootstrap.js";
import { GrowthComplianceAuditor } from "./compliance.js";
import { GrowthEvaluationStore } from "./evaluation.js";
import { PromptMemoryStore } from "./prompt-memory.js";

describe("Growth Bootstrap gate", () => {
  let database: MassionDatabase | undefined;
  afterEach(async () => database?.close());

  it("fresh database는 기본 정본을 만들고 valid restore는 활성화한다", () => {
    expect(decideGrowthBootstrap({ fresh: true, compliant: true })).toBe("initialize");
    expect(decideGrowthBootstrap({ fresh: false, compliant: true })).toBe("activate");
  });

  it("위반 restore는 gateway 활성화 전에 거부한다", () => {
    expect(() => decideGrowthBootstrap({ fresh: false, compliant: false })).toThrow("활성화");
  });

  it("fresh DB에 Core Office 기반 Prompt·Memory와 EvaluationStrategy를 멱등 생성한다", async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "bootstrap@example.com", displayName: "Bootstrap" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    const prompts = await PromptMemoryStore.create(database, organizations);
    const evaluations = await GrowthEvaluationStore.create(database, organizations);
    await database.query("DEFINE TABLE growth_adoption_run SCHEMALESS;");
    const bootstrap = new GrowthBootstrap(
      graph,
      prompts,
      evaluations,
      new GrowthComplianceAuditor(database, organizations),
    );

    await expect(bootstrap.start(context)).resolves.toEqual({ action: "initialize" });
    await expect(bootstrap.start(context)).resolves.toEqual({ action: "activate" });
    expect((await prompts.getActivePromptDefinition(context)).version).toBe(1);
    expect((await evaluations.getActiveStrategy(context)).version).toBe(1);
  });
});
