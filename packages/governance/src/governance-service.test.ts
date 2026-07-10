import { beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import type { PolicyRequest } from "./contracts.js";
import { createDefaultPolicy } from "./defaults.js";
import { GovernanceService } from "./governance-service.js";
import { PolicyStore } from "./policy-store.js";

describe("Governance Policy Decision", () => {
  let database: MassionDatabase;
  let organizations: OrganizationService;
  let context: TenantContext;
  let policies: PolicyStore;
  let governance: GovernanceService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "decision@example.com", displayName: "Decision" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    policies = await PolicyStore.create(database, organizations);
    governance = await GovernanceService.create(database, organizations, policies);
  });

  async function activate(kind: "personal" | "team") {
    const defaults = createDefaultPolicy(kind);
    const draft = await policies.createDraft(context, {
      commandId: crypto.randomUUID(),
      bundle: defaults.bundle,
      requirements: defaults.requirements,
    });
    return await policies.activate(context, {
      commandId: crypto.randomUUID(),
      policyVersionId: draft.policy_version_id,
    });
  }

  function request(action: string, overrides: Partial<PolicyRequest> = {}): PolicyRequest {
    return {
      principal: {
        type: "Human",
        id: context.userId,
        organizationId: context.organizationId,
        attributes: { kind: "human", role: context.role },
      },
      action,
      resource: {
        type: "Work",
        id: "work-1",
        organizationId: context.organizationId,
        attributes: { dataClassification: "internal" },
      },
      context: { environment: "local", riskClass: "safe-read", external: false },
      ...overrides,
    };
  }

  it("개인 조직의 safe-read는 자동 허용하고 위험 tool call은 승인을 요구한다", async () => {
    await activate("personal");

    const safe = await governance.evaluate(context, { commandId: crypto.randomUUID(), request: request("work.read") });
    const risky = await governance.evaluate(context, {
      commandId: crypto.randomUUID(),
      request: request("tool.call", { context: { environment: "local", riskClass: "write", external: false } }),
    });

    expect(safe.outcome).toBe("allow");
    expect(risky).toMatchObject({
      outcome: "require_approval",
      requirement: { separationOfDuty: false, quorum: 1 },
    });
  });

  it("team production 위험 작업은 분리된 지정 역할 승인을 요구한다", async () => {
    await activate("team");

    const result = await governance.evaluate(context, {
      commandId: crypto.randomUUID(),
      request: request("tool.call", {
        context: { environment: "production", riskClass: "destructive", external: false },
      }),
    });

    expect(result).toMatchObject({
      outcome: "require_approval",
      requirement: { separationOfDuty: true, quorum: 1, approverRoles: ["owner", "admin"] },
    });
  });

  it("local-private 외부 전송과 Agent의 사람 승인 가장은 non-bypassable deny한다", async () => {
    await activate("personal");
    const localPrivate = await governance.evaluate(context, {
      commandId: crypto.randomUUID(),
      request: request("tool.call", {
        resource: {
          type: "Work",
          id: "work-1",
          organizationId: context.organizationId,
          attributes: { dataClassification: "local-private" },
        },
        context: { environment: "local", riskClass: "write", external: true },
      }),
    });
    const agentApproval = await governance.evaluate(context, {
      commandId: crypto.randomUUID(),
      request: request("approval.decide", {
        principal: {
          type: "Agent",
          id: "governance-agent",
          organizationId: context.organizationId,
          attributes: { kind: "agent" },
        },
      }),
    });

    expect(localPrivate).toMatchObject({ outcome: "deny", reasons: ["invariant-local-private"] });
    expect(agentApproval).toMatchObject({ outcome: "deny", reasons: ["invariant-agent-approval"] });
  });

  it("active 정책이 없으면 fail closed하고 command 결과를 멱등 재생한다", async () => {
    const commandId = crypto.randomUUID();
    const first = await governance.evaluate(context, { commandId, request: request("work.read") });
    const repeated = await governance.evaluate(context, { commandId, request: request("work.read") });

    expect(first.outcome).toBe("deny");
    expect(first.errors).toContain("active_policy_missing");
    expect(repeated).toEqual(first);
  });
});
