import { describe, expect, it } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase } from "@massion/storage";

import { GovernanceService } from "./governance-service.js";
import { assertGrowthPolicyPatch, PolicyGrowthProjection } from "./growth-projection.js";
import { PolicyStore } from "./policy-store.js";

describe("Policy Growth projection", () => {
  it("유효한 Cedar policy 교체만 허용한다", () => {
    expect(() =>
      assertGrowthPolicyPatch({
        policyId: "read",
        policyText: 'permit(principal, action == Massion::Action::"GrowthProjectionCheck", resource);',
      }),
    ).not.toThrow();
    expect(() => assertGrowthPolicyPatch({ policyId: "read", policyText: "permit(" })).toThrow("Cedar");
  });

  it("Growth·Governance 보호 action의 자기 권한 확대를 거부한다", () => {
    expect(() =>
      assertGrowthPolicyPatch({
        policyId: "growth",
        policyText: 'permit(principal, action == Massion::Action::"growth.adopt", resource);',
      }),
    ).toThrow("self-amplification");
    expect(() =>
      assertGrowthPolicyPatch({ policyId: "wildcard", policyText: "permit(principal, action, resource);" }),
    ).toThrow("포괄적");
  });

  it("저장된 growth.adopt allow 결정과 active precondition으로 새 Policy version을 원자 투영한다", async () => {
    const database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    try {
      const identity = await IdentityService.create(database);
      const organizations = await OrganizationService.create(database);
      const owner = await identity.registerPersonalUser({
        email: "policy-growth@example.com",
        displayName: "Policy Growth",
      });
      const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
      const policies = await PolicyStore.create(database, organizations);
      const draft = await policies.createDraft(context, {
        commandId: "initial-policy",
        bundle: {
          schema: {
            Massion: {
              entityTypes: { Principal: {}, Resource: {} },
              actions: { Read: { appliesTo: { principalTypes: ["Principal"], resourceTypes: ["Resource"] } } },
            },
          },
          policies: { base: "permit(principal, action, resource);" },
        },
        requirements: [],
      });
      await policies.activate(context, { commandId: "activate-policy", policyVersionId: draft.policy_version_id });
      await GovernanceService.create(database, organizations, policies);
      const decisionId = crypto.randomUUID();
      await database.query(
        "CREATE governance_policy_decision CONTENT { decision_id: $decision_id, organization_id: $organization_id, command_id: 'growth-policy-decision', policy_version_id: $policy_version_id, request_hash: $hash, request_summary_json: '{}', outcome: 'allow', reasons_json: '[]', errors_json: '[]', requirement_json: NONE, request_json: '{}', principal_type: 'Agent', principal_id: 'execution-1', action: 'growth.adopt', resource_type: 'Suggestion', resource_id: 'suggestion-1', resource_revision: 1, environment: 'local', risk_class: 'growth-adoption', external: false, automation_mode: 'auto', created_at: time::now() };",
        {
          decision_id: decisionId,
          organization_id: context.organizationId,
          policy_version_id: draft.policy_version_id,
          hash: "a".repeat(64),
        },
      );
      const projection = new PolicyGrowthProjection(policies);
      const result = await database.transaction(
        async (executor) =>
          await projection.apply(
            context,
            {
              commandId: "growth-policy-apply",
              expectedVersionId: draft.policy_version_id,
              patch: { policyId: "base", policyText: "forbid(principal, action, resource);" },
              authorization: { decisionId, suggestionId: "suggestion-1", targetRevision: 1 },
            },
            executor,
          ),
      );

      expect(result.version.version).toBe(2);
      expect(result.version.status).toBe("active");
      expect((await policies.get(context, draft.policy_version_id)).status).toBe("superseded");
    } finally {
      await database.close();
    }
  });
});
