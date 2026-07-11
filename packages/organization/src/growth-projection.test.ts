import { describe, expect, it } from "vitest";

import { GovernanceService, PolicyStore } from "@massion/governance";
import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase } from "@massion/storage";

import { assertGrowthOrganizationPatch, OrganizationGrowthProjection } from "./growth-projection.js";
import { OrganizationGraphService } from "./organization.js";

describe("Organization Growth projection", () => {
  it("일반 노드 책임 변경 patch를 허용한다", () => {
    expect(() =>
      assertGrowthOrganizationPatch({ handle: "software-development", responsibility: "구현과 검증" }),
    ).not.toThrow();
  });

  it("Core Office 변경과 unchecked patch를 거부한다", () => {
    expect(() => assertGrowthOrganizationPatch({ handle: "governance", responsibility: "승인 생략" })).toThrow(
      "Core Office",
    );
    expect(() => assertGrowthOrganizationPatch({ handle: "team", responsibility: "개발", raw: "query" })).toThrow(
      "patch",
    );
  });

  it("저장된 allow 결정 뒤 기존 graph 검증·영향 분석·version 원장으로 책임 변경을 투영한다", async () => {
    const database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    try {
      const identity = await IdentityService.create(database);
      const organizations = await OrganizationService.create(database);
      const owner = await identity.registerPersonalUser({
        email: "organization-growth@example.com",
        displayName: "Organization Growth",
      });
      const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
      const graph = await OrganizationGraphService.create(database, organizations);
      await graph.bootstrap(context);
      await graph.execute(context, {
        commandId: "create-specialist",
        expectedVersion: 1,
        kind: "create",
        handle: "software-development",
        name: "Software Development",
        responsibility: "구현",
        parentHandle: "delivery-coordination",
        scope: "persistent",
      });
      const policies = await PolicyStore.create(database, organizations);
      const policy = await policies.createDraft(context, {
        commandId: "organization-growth-policy",
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
      await policies.activate(context, {
        commandId: "activate-organization-growth-policy",
        policyVersionId: policy.policy_version_id,
      });
      await GovernanceService.create(database, organizations, policies);
      const decisionId = crypto.randomUUID();
      await database.query(
        "CREATE governance_policy_decision CONTENT { decision_id: $decision_id, organization_id: $organization_id, command_id: 'growth-organization-decision', policy_version_id: $policy_version_id, request_hash: $hash, request_summary_json: '{}', outcome: 'allow', reasons_json: '[]', errors_json: '[]', requirement_json: NONE, request_json: '{}', principal_type: 'Agent', principal_id: 'execution-1', action: 'growth.adopt', resource_type: 'Suggestion', resource_id: 'suggestion-organization', resource_revision: 1, environment: 'local', risk_class: 'growth-adoption', external: false, automation_mode: 'auto', created_at: time::now() };",
        {
          decision_id: decisionId,
          organization_id: context.organizationId,
          policy_version_id: policy.policy_version_id,
          hash: "a".repeat(64),
        },
      );
      const projection = new OrganizationGrowthProjection(graph);
      const result = await database.transaction(
        async (executor) =>
          await projection.apply(
            context,
            {
              commandId: "growth-organization-apply",
              expectedVersion: 2,
              patch: { handle: "software-development", responsibility: "구현과 검증" },
              authorization: { decisionId, suggestionId: "suggestion-organization", targetRevision: 1 },
            },
            executor,
          ),
      );

      expect(result.version.version).toBe(3);
      expect(result.nodes.find((node) => node.handle === "software-development")?.responsibility).toBe("구현과 검증");
      expect(result.impact.nodeHandles).toContain("software-development");
      await expect(
        projection.apply(
          context,
          {
            commandId: "stale",
            expectedVersion: 2,
            patch: { handle: "software-development", responsibility: "stale" },
            authorization: { decisionId, suggestionId: "suggestion-organization", targetRevision: 1 },
          },
          database,
        ),
      ).rejects.toThrow("precondition");
    } finally {
      await database.close();
    }
  });
});
