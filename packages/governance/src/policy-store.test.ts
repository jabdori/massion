import { beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import type { ApprovalRequirement, PolicyBundle } from "./contracts.js";
import { createDefaultPolicy } from "./defaults.js";
import { PolicyStore } from "./policy-store.js";

const VALID_BUNDLE: PolicyBundle = {
  schema: {
    Massion: {
      entityTypes: { Principal: {}, Resource: {} },
      actions: { Read: { appliesTo: { principalTypes: ["Principal"], resourceTypes: ["Resource"] } } },
    },
  },
  policies: { allow: `permit(principal, action, resource);` },
};

function legacyDefault(kind: "personal" | "team"): {
  readonly bundle: PolicyBundle;
  readonly requirements: readonly ApprovalRequirement[];
} {
  const current = structuredClone(createDefaultPolicy(kind));
  const namespace = (current.bundle.schema as { Massion: Record<string, Record<string, unknown>> }).Massion;
  delete namespace.actions?.["model.optimization.approve"];
  delete namespace.entityTypes?.OptimizationRecommendation;
  for (const action of Object.values(namespace.actions ?? {})) {
    const appliesTo = (action as { appliesTo?: { resourceTypes?: string[] } }).appliesTo;
    if (appliesTo?.resourceTypes) {
      appliesTo.resourceTypes = appliesTo.resourceTypes.filter((type) => type !== "OptimizationRecommendation");
    }
  }
  return {
    bundle: current.bundle,
    requirements: current.requirements.map((requirement) => ({
      ...requirement,
      actions: requirement.actions.filter((action) => action !== "model.optimization.approve"),
    })),
  };
}

describe("Policy Version Store", () => {
  let database: MassionDatabase;
  let organizations: OrganizationService;
  let context: TenantContext;
  let otherContext: TenantContext;
  let store: PolicyStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "policy@example.com", displayName: "Policy" });
    const other = await identity.registerPersonalUser({ email: "other-policy@example.com", displayName: "Other" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    otherContext = await organizations.resolveTenantContext(other.user.user_id, other.organization.organization_id);
    store = await PolicyStore.create(database, organizations, { authorize: async () => undefined });
  });

  it("immutable draft에 단조 version과 canonical checksum을 부여한다", async () => {
    const first = await store.createDraft(context, {
      commandId: crypto.randomUUID(),
      bundle: VALID_BUNDLE,
      requirements: [],
    });
    const second = await store.createDraft(context, {
      commandId: crypto.randomUUID(),
      bundle: { ...VALID_BUNDLE, policies: { allow: `permit(principal, action, resource);` } },
      requirements: [],
    });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(first.checksum).toBe(second.checksum);
    expect(first.status).toBe("draft");
  });

  it("출시된 managed legacy personal/team canonical checksum을 고정한다", async () => {
    const personal = legacyDefault("personal");
    const personalDraft = await store.createDraft(context, {
      commandId: "legacy-fingerprint-personal",
      bundle: personal.bundle,
      requirements: personal.requirements,
    });
    const created = await organizations.createTeam(context.userId, "Fingerprint Team");
    const teamContext = await organizations.resolveTenantContext(context.userId, created.organization.organization_id);
    const team = legacyDefault("team");
    const teamDraft = await store.createDraft(teamContext, {
      commandId: "legacy-fingerprint-team",
      bundle: team.bundle,
      requirements: team.requirements,
    });

    expect([personalDraft.checksum, teamDraft.checksum]).toEqual([
      "637c72da0469ebd33b81bcc4c0474adcb7790e78b1bdfd1debf89d6faf6be423",
      "fe2b5aa02cf0760b9f6fb26180e541b8f80045b5c73e35e94817e0743ce76c18",
    ]);
  });

  it("startup reconcile은 exact legacy personal default를 새 managed active version으로 올린다", async () => {
    const legacy = legacyDefault("personal");
    const draft = await store.createDraft(context, {
      commandId: "legacy-personal-draft",
      bundle: legacy.bundle,
      requirements: legacy.requirements,
    });
    const active = await store.activate(context, {
      commandId: "legacy-personal-activate",
      policyVersionId: draft.policy_version_id,
    });

    const reconciled = await store.reconcileManagedDefaultsAtStartup();

    expect(reconciled).toEqual([
      expect.objectContaining({
        organizationId: context.organizationId,
        kind: "personal",
        action: "upgraded",
        previousPolicyVersionId: active.policy_version_id,
      }),
    ]);
    expect((await store.get(context, active.policy_version_id)).status).toBe("superseded");
    const upgraded = await store.getActivePolicy(context);
    expect(upgraded?.version).toMatchObject({ version: 2, status: "active" });
    const schema = upgraded?.bundle.schema as {
      readonly Massion?: { readonly actions?: unknown; readonly entityTypes?: unknown };
    };
    expect(schema.Massion?.actions).toHaveProperty("model.optimization.approve");
    expect(schema.Massion?.entityTypes).toHaveProperty("OptimizationRecommendation");
    const [events] = await database.query<[Array<{ event_type: string; policy_version_id: string }>]>(
      "SELECT event_type, policy_version_id FROM governance_policy_event WHERE organization_id = $organization_id AND event_type = 'managed_default_reconciled';",
      { organization_id: context.organizationId },
    );
    expect(events).toEqual([
      { event_type: "managed_default_reconciled", policy_version_id: upgraded?.version.policy_version_id },
    ]);
  });

  it("startup reconcile은 조직 kind와 일치하는 exact legacy team default도 업그레이드한다", async () => {
    const created = await organizations.createTeam(context.userId, "Managed Team");
    const team = await organizations.resolveTenantContext(context.userId, created.organization.organization_id);
    const legacy = legacyDefault("team");
    const draft = await store.createDraft(team, {
      commandId: "legacy-team-draft",
      bundle: legacy.bundle,
      requirements: legacy.requirements,
    });
    await store.activate(team, { commandId: "legacy-team-activate", policyVersionId: draft.policy_version_id });

    await expect(store.reconcileManagedDefaultsAtStartup()).resolves.toEqual([
      expect.objectContaining({ organizationId: team.organizationId, kind: "team", action: "upgraded" }),
    ]);
    const upgraded = await store.getActivePolicy(team);
    expect(upgraded?.requirements[0]?.actions).toContain("work.execute");
    expect(upgraded?.requirements[0]?.actions).toContain("model.optimization.approve");
  });

  it("startup reconcile은 current default와 1-byte custom policy를 절대 변경하지 않는다", async () => {
    const current = createDefaultPolicy("personal");
    const currentDraft = await store.createDraft(context, {
      commandId: "current-default-draft",
      bundle: current.bundle,
      requirements: current.requirements,
    });
    const currentActive = await store.activate(context, {
      commandId: "current-default-activate",
      policyVersionId: currentDraft.policy_version_id,
    });
    const customOrganization = await organizations.createTeam(context.userId, "Custom Team");
    const customContext = await organizations.resolveTenantContext(
      context.userId,
      customOrganization.organization.organization_id,
    );
    const custom = legacyDefault("team");
    const customBundle = {
      ...custom.bundle,
      policies: { ...custom.bundle.policies, tenant: `${custom.bundle.policies.tenant} ` },
    };
    const customDraft = await store.createDraft(customContext, {
      commandId: "custom-default-draft",
      bundle: customBundle,
      requirements: custom.requirements,
    });
    const customActive = await store.activate(customContext, {
      commandId: "custom-default-activate",
      policyVersionId: customDraft.policy_version_id,
    });

    await expect(store.reconcileManagedDefaultsAtStartup()).resolves.toEqual([]);
    expect(await store.getActive(context)).toEqual(currentActive);
    expect(await store.getActive(customContext)).toEqual(customActive);
  });

  it("동시·반복 startup reconcile은 active/version/event를 하나만 만든다", async () => {
    const legacy = legacyDefault("personal");
    const draft = await store.createDraft(context, {
      commandId: "concurrent-legacy-draft",
      bundle: legacy.bundle,
      requirements: legacy.requirements,
    });
    await store.activate(context, {
      commandId: "concurrent-legacy-activate",
      policyVersionId: draft.policy_version_id,
    });

    const concurrentStore = await PolicyStore.create(database, organizations, { authorize: async () => undefined });
    const results = await Promise.all([
      store.reconcileManagedDefaultsAtStartup(),
      concurrentStore.reconcileManagedDefaultsAtStartup(),
    ]);
    expect(results.flat()).toHaveLength(1);
    await expect(store.reconcileManagedDefaultsAtStartup()).resolves.toEqual([]);
    const [versions, active, events] = await database.query<
      [Array<{ version: number }>, Array<{ policy_version_id: string }>, Array<{ event_id: string }>]
    >(
      "SELECT version FROM governance_policy_version WHERE organization_id = $organization_id ORDER BY version ASC; SELECT policy_version_id FROM governance_policy_version WHERE organization_id = $organization_id AND status = 'active'; SELECT event_id FROM governance_policy_event WHERE organization_id = $organization_id AND event_type = 'managed_default_reconciled';",
      { organization_id: context.organizationId },
    );
    expect(versions).toEqual([{ version: 1 }, { version: 2 }]);
    expect(active).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("현재 active precondition으로 새 version을 활성화하고 이전 것을 supersede한다", async () => {
    const first = await store.createDraft(context, {
      commandId: crypto.randomUUID(),
      bundle: VALID_BUNDLE,
      requirements: [],
    });
    const activated = await store.activate(context, {
      commandId: crypto.randomUUID(),
      policyVersionId: first.policy_version_id,
    });
    const second = await store.createDraft(context, {
      commandId: crypto.randomUUID(),
      bundle: VALID_BUNDLE,
      requirements: [],
    });
    const next = await store.activate(context, {
      commandId: crypto.randomUUID(),
      policyVersionId: second.policy_version_id,
      expectedActivePolicyVersionId: activated.policy_version_id,
    });

    expect(next.status).toBe("active");
    expect((await store.get(context, first.policy_version_id)).status).toBe("superseded");
    await expect(
      store.activate(context, {
        commandId: crypto.randomUUID(),
        policyVersionId: first.policy_version_id,
        expectedActivePolicyVersionId: activated.policy_version_id,
      }),
    ).rejects.toThrow("active Policy Version precondition");
  });

  it("command 멱등을 보존하고 같은 command의 다른 요청은 거부한다", async () => {
    const commandId = crypto.randomUUID();
    const first = await store.createDraft(context, { commandId, bundle: VALID_BUNDLE, requirements: [] });
    const repeated = await store.createDraft(context, { commandId, bundle: VALID_BUNDLE, requirements: [] });

    expect(repeated).toEqual(first);
    await expect(
      store.createDraft(context, {
        commandId,
        bundle: { ...VALID_BUNDLE, policies: { deny: `forbid(principal, action, resource);` } },
        requirements: [],
      }),
    ).rejects.toThrow("같은 commandId");
  });

  it("잘못된 Cedar bundle과 다른 조직 조회를 거부한다", async () => {
    await expect(
      store.createDraft(context, {
        commandId: crypto.randomUUID(),
        bundle: { ...VALID_BUNDLE, policies: { broken: "permit(" } },
        requirements: [],
      }),
    ).rejects.toThrow("Cedar Policy Bundle 검증 실패");
    const draft = await store.createDraft(context, {
      commandId: crypto.randomUUID(),
      bundle: VALID_BUNDLE,
      requirements: [],
    });

    await expect(store.get(otherContext, draft.policy_version_id)).rejects.toThrow("Policy Version을 찾을 수 없습니다");
  });

  it("저장된 bundle checksum 변조를 fail-closed로 탐지한다", async () => {
    const first = await store.createDraft(context, {
      commandId: crypto.randomUUID(),
      bundle: VALID_BUNDLE,
      requirements: [],
    });
    await database.query(
      "UPDATE governance_policy_version SET policies_json = $policies WHERE organization_id = $organization_id AND policy_version_id = $policy_version_id;",
      {
        organization_id: context.organizationId,
        policy_version_id: first.policy_version_id,
        policies: JSON.stringify({ deny: "forbid(principal, action, resource);" }),
      },
    );

    await expect(store.get(context, first.policy_version_id)).rejects.toThrow("checksum");
  });

  it("active Policy 중복을 fail-closed로 탐지한다", async () => {
    const first = await store.createDraft(context, {
      commandId: crypto.randomUUID(),
      bundle: VALID_BUNDLE,
      requirements: [],
    });
    const second = await store.createDraft(context, {
      commandId: crypto.randomUUID(),
      bundle: VALID_BUNDLE,
      requirements: [],
    });
    await database.query(
      "UPDATE governance_policy_version SET status = 'active' WHERE organization_id = $organization_id AND policy_version_id IN $policy_version_ids;",
      {
        organization_id: context.organizationId,
        policy_version_ids: [first.policy_version_id, second.policy_version_id],
      },
    );

    await expect(store.getActive(context)).rejects.toThrow("active Policy Version은 하나");
  });
});
