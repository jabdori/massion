import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApprovalStore,
  createDefaultPolicy,
  EmergencyControl,
  GovernanceApprovalRequiredError,
  GovernanceGate,
  GovernanceService,
  PermitStore,
  PolicyStore,
} from "@massion/governance";
import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { RuntimeExecutionStore } from "@massion/runtime";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { GrowthConfigurationStore } from "./configuration.js";
import { GrowthGovernanceAdapter, GrowthRuntimeAgentIdentityReader } from "./governance-adapter.js";

describe("Growth Governance adapter", () => {
  let database: MassionDatabase;
  let ownerContext: TenantContext;
  let memberContext: TenantContext;
  let adapter: GrowthGovernanceAdapter;
  let configurations: GrowthConfigurationStore;
  let executions: RuntimeExecutionStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "growth-gov-owner@example.com", displayName: "Owner" });
    const member = await identity.registerPersonalUser({
      email: "growth-gov-member@example.com",
      displayName: "Member",
    });
    ownerContext = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    await organizations.addMember(ownerContext, member.user.user_id, "member");
    memberContext = await organizations.resolveTenantContext(member.user.user_id, owner.organization.organization_id);
    const policies = await PolicyStore.create(database, organizations);
    const defaults = createDefaultPolicy("personal");
    const draft = await policies.createDraft(ownerContext, {
      commandId: "growth-governance-policy",
      bundle: defaults.bundle,
      requirements: defaults.requirements,
    });
    await policies.activate(ownerContext, {
      commandId: "growth-governance-policy-activate",
      policyVersionId: draft.policy_version_id,
    });
    const governance = await GovernanceService.create(database, organizations, policies);
    const approvals = await ApprovalStore.create(database, organizations, governance);
    const permits = await PermitStore.create(database, organizations);
    const emergency = await EmergencyControl.create(database, organizations, permits);
    const identities = new GrowthRuntimeAgentIdentityReader(database, organizations);
    const gate = new GovernanceGate(governance, approvals, permits, emergency, identities);
    adapter = new GrowthGovernanceAdapter(gate);
    configurations = await GrowthConfigurationStore.create(database, organizations, adapter);
    executions = await RuntimeExecutionStore.create(database, organizations);
  });

  afterEach(async () => database.close());

  it("owner 조직 설정과 member 자신의 사용자 설정을 허용하고 권한 확대를 거부한다", async () => {
    await expect(
      configurations.configure(ownerContext, {
        commandId: "owner-organization-auto",
        subject: { type: "organization" },
        reflectionEnabled: true,
        adoptionMode: "auto",
        expectedVersion: 1,
      }),
    ).resolves.toMatchObject({ adoptionMode: "auto" });
    await expect(
      configurations.configure(memberContext, {
        commandId: "member-self-review",
        subject: { type: "user", userId: memberContext.userId },
        reflectionEnabled: true,
        adoptionMode: "review",
      }),
    ).resolves.toMatchObject({ subject: { type: "user", userId: memberContext.userId } });
    await expect(
      configurations.configure(memberContext, {
        commandId: "member-organization-auto",
        subject: { type: "organization" },
        reflectionEnabled: true,
        adoptionMode: "auto",
        expectedVersion: 2,
      }),
    ).rejects.toThrow("거부");
    await expect(
      configurations.configure(memberContext, {
        commandId: "member-owner-override",
        subject: { type: "user", userId: ownerContext.userId },
        reflectionEnabled: true,
        adoptionMode: "auto",
      }),
    ).rejects.toThrow("거부");
  });

  it("review는 승인을 요구하고 auto는 succeeded Growth execution만 허용한다", async () => {
    const queued = await executions.createExecution(ownerContext, {
      commandId: "growth-reflection-execution",
      workId: "work-1",
      agentHandle: "growth",
      modelRoute: "default",
      correlationId: "growth-reflection-correlation",
      estimatedTokens: 100,
      estimatedCostMicros: 1,
      input: "reflection",
    });
    const running = await executions.transition(ownerContext, {
      commandId: "growth-reflection-running",
      executionId: queued.execution.execution_id,
      expectedVersion: 1,
      target: "running",
      payload: {},
    });
    await executions.transition(ownerContext, {
      commandId: "growth-reflection-succeeded",
      executionId: queued.execution.execution_id,
      expectedVersion: running.execution.version,
      target: "succeeded",
      payload: {},
    });
    const review = await configurations.resolve(ownerContext);

    await expect(
      adapter.authorizeAdoption(ownerContext, {
        commandId: "review-adoption",
        workId: "work-1",
        suggestionId: "suggestion-1",
        suggestionRevision: 1,
        reflectionExecutionId: queued.execution.execution_id,
        configuration: review,
      }),
    ).rejects.toBeInstanceOf(GovernanceApprovalRequiredError);
    const auto = await configurations.configure(ownerContext, {
      commandId: "auto-configuration",
      subject: { type: "organization" },
      reflectionEnabled: true,
      adoptionMode: "auto",
      expectedVersion: 1,
    });
    await expect(
      adapter.authorizeAdoption(ownerContext, {
        commandId: "auto-adoption",
        workId: "work-1",
        suggestionId: "suggestion-1",
        suggestionRevision: 1,
        reflectionExecutionId: queued.execution.execution_id,
        configuration: auto,
      }),
    ).resolves.toMatchObject({ outcome: "allow" });
    await expect(
      adapter.authorizeRevert(ownerContext, {
        commandId: "auto-revert",
        workId: "work-1",
        suggestionId: "suggestion-1",
        suggestionRevision: 1,
        runtimeExecutionId: queued.execution.execution_id,
        mode: "auto",
      }),
    ).resolves.toMatchObject({ outcome: "allow" });
    await expect(
      adapter.authorizeRevert(ownerContext, {
        commandId: "explicit-revert",
        workId: "work-1",
        suggestionId: "suggestion-2",
        suggestionRevision: 1,
        runtimeExecutionId: "human-request",
        mode: "explicit",
      }),
    ).rejects.toBeInstanceOf(GovernanceApprovalRequiredError);
  });
});
