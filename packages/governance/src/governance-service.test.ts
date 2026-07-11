import { beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import type { PolicyRequest } from "./contracts.js";
import { createDefaultPolicy } from "./defaults.js";
import { GovernanceService } from "./governance-service.js";
import { PolicyStore } from "./policy-store.js";
import { GOVERNANCE_GROWTH_AUTONOMY_MIGRATION } from "./schema.js";

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

  it("0055 Growth autonomy migration checksum을 고정한다", () => {
    expect(GOVERNANCE_GROWTH_AUTONOMY_MIGRATION.id).toBe("0055-governance-growth-autonomy");
    expect(GOVERNANCE_GROWTH_AUTONOMY_MIGRATION.checksum).toBe(
      "ad24ffe8e535701bd0397021e6c0242b661a718c4dd63510efd1575619d991d9",
    );
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

  it("Policy 원문 context의 secret을 Decision 감사 레코드에 저장하지 않는다", async () => {
    await activate("personal");
    await governance.evaluate(context, {
      commandId: crypto.randomUUID(),
      request: request("tool.call", {
        context: {
          environment: "local",
          riskClass: "write",
          external: false,
          apiKey: "secret-value",
        },
      }),
    });

    const [records] = await database.query<[{ request_json: string; request_summary_json: string }[]]>(
      "SELECT request_json, request_summary_json FROM governance_policy_decision;",
    );
    expect(JSON.stringify(records)).not.toContain("secret-value");
  });

  it("Policy bundle이 요구사항을 제거해도 policy.activate는 non-bypassable 승인을 요구한다", async () => {
    const defaults = createDefaultPolicy("personal");
    const draft = await policies.createDraft(context, {
      commandId: crypto.randomUUID(),
      bundle: defaults.bundle,
      requirements: [],
    });
    await policies.activate(context, { commandId: crypto.randomUUID(), policyVersionId: draft.policy_version_id });

    const result = await governance.evaluate(context, {
      commandId: crypto.randomUUID(),
      request: request("policy.activate", {
        resource: {
          type: "Policy",
          id: "policy-v2",
          organizationId: context.organizationId,
          revision: 1,
          attributes: { dataClassification: "internal" },
        },
        context: { environment: "local", riskClass: "destructive", external: false },
      }),
    });

    expect(result).toMatchObject({
      outcome: "require_approval",
      requirement: { requirementId: "invariant-policy-activate" },
    });
  });

  it("Extension 설치와 권한 증가는 active policy가 review 또는 auto를 선택한다", async () => {
    const defaults = createDefaultPolicy("personal");
    const draft = await policies.createDraft(context, {
      commandId: "extension-auto-policy",
      bundle: defaults.bundle,
      requirements: [],
    });
    await policies.activate(context, {
      commandId: "extension-auto-policy-activate",
      policyVersionId: draft.policy_version_id,
    });
    const extensionRequest = (action: "extension.install" | "extension.permission_increase"): PolicyRequest =>
      request(action, {
        resource: {
          type: "ExtensionResource",
          id: "@massion-ext/echo@1.0.0",
          organizationId: context.organizationId,
          revision: 0,
          attributes: { dataClassification: "internal" },
        },
        context: { environment: "local", riskClass: "extension-change", external: false },
      });

    const install = await governance.evaluate(context, {
      commandId: "extension-auto-install",
      request: extensionRequest("extension.install"),
    });
    const permission = await governance.evaluate(context, {
      commandId: "extension-auto-permission",
      request: extensionRequest("extension.permission_increase"),
    });

    expect(install.outcome).toBe("allow");
    expect(permission.outcome).toBe("allow");
  });

  it("Growth adoption의 review만 builtin 승인을 요구하고 auto는 active policy 허용을 따른다", async () => {
    await activate("personal");
    const review = await governance.evaluate(context, {
      commandId: "growth-review",
      request: request("growth.adopt", {
        principal: {
          type: "Agent",
          id: "growth-execution-1",
          organizationId: context.organizationId,
          attributes: { kind: "agent", role: "growth" },
        },
        resource: {
          type: "Suggestion",
          id: "suggestion-1",
          organizationId: context.organizationId,
          revision: 1,
        },
        context: { environment: "local", riskClass: "growth-adoption", external: false, automationMode: "review" },
      }),
    });
    const auto = await governance.evaluate(context, {
      commandId: "growth-auto",
      request: request("growth.adopt", {
        principal: {
          type: "Agent",
          id: "growth-execution-1",
          organizationId: context.organizationId,
          attributes: { kind: "agent", role: "growth" },
        },
        resource: {
          type: "Suggestion",
          id: "suggestion-1",
          organizationId: context.organizationId,
          revision: 1,
        },
        context: { environment: "local", riskClass: "growth-adoption", external: false, automationMode: "auto" },
      }),
    });

    expect(review).toMatchObject({ outcome: "require_approval", automationMode: "review" });
    expect(auto).toMatchObject({ outcome: "allow", automationMode: "auto" });
  });

  it("Growth auto도 active policy의 명시적 approval requirement를 우회하지 않는다", async () => {
    const defaults = createDefaultPolicy("personal");
    const draft = await policies.createDraft(context, {
      commandId: "growth-auto-requirement-policy",
      bundle: defaults.bundle,
      requirements: [
        ...defaults.requirements,
        {
          requirementId: "growth-auto-review",
          actions: ["growth.adopt"],
          environments: ["*"],
          riskClasses: ["growth-adoption"],
          approverRoles: ["owner"],
          quorum: 1,
          separationOfDuty: false,
          expiresInSeconds: 3600,
        },
      ],
    });
    await policies.activate(context, {
      commandId: "growth-auto-requirement-activate",
      policyVersionId: draft.policy_version_id,
    });

    const result = await governance.evaluate(context, {
      commandId: "growth-auto-requirement",
      request: request("growth.adopt", {
        resource: { type: "Suggestion", id: "suggestion-1", organizationId: context.organizationId },
        context: { environment: "local", riskClass: "growth-adoption", external: false, automationMode: "auto" },
      }),
    });

    expect(result).toMatchObject({ outcome: "require_approval", requirement: { requirementId: "growth-auto-review" } });
  });

  it("Growth auto도 active Cedar forbid를 우회하지 않는다", async () => {
    const defaults = createDefaultPolicy("personal");
    const draft = await policies.createDraft(context, {
      commandId: "growth-auto-deny-policy",
      bundle: {
        ...defaults.bundle,
        policies: {
          ...defaults.bundle.policies,
          "deny-growth-adoption": 'forbid(principal, action == Massion::Action::"growth.adopt", resource);',
        },
      },
      requirements: defaults.requirements,
    });
    await policies.activate(context, {
      commandId: "growth-auto-deny-activate",
      policyVersionId: draft.policy_version_id,
    });

    const result = await governance.evaluate(context, {
      commandId: "growth-auto-denied",
      request: request("growth.adopt", {
        resource: { type: "Suggestion", id: "suggestion-1", organizationId: context.organizationId },
        context: { environment: "local", riskClass: "growth-adoption", external: false, automationMode: "auto" },
      }),
    });

    expect(result).toMatchObject({ outcome: "deny", reasons: ["deny-growth-adoption"] });
  });
});
