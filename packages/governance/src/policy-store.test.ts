import { beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import type { PolicyBundle } from "./contracts.js";
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
