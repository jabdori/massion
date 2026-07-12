import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { SubscriptionPolicyStore } from "./policy-store.js";

describe("구독 제공자별 계정 선택 정책 정본", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let memberContext: TenantContext;
  let policies: SubscriptionPolicyStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "policy-owner@example.com", displayName: "Owner" });
    const member = await identities.registerPersonalUser({ email: "policy-member@example.com", displayName: "Member" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    await organizations.addMember(context, member.user.user_id, "member");
    memberContext = await organizations.resolveTenantContext(member.user.user_id, owner.organization.organization_id);
    policies = await SubscriptionPolicyStore.create(database, organizations);
  });

  afterEach(async () => database.close());

  it("최초 정책과 후속 version을 append-only로 저장하고 현재 포인터만 교체한다", async () => {
    const first = await policies.configure(context, {
      commandId: randomUUID(),
      providerId: "openai-codex",
      credentialPolicy: "adaptive",
    });
    const second = await policies.configure(context, {
      commandId: randomUUID(),
      providerId: "openai-codex",
      credentialPolicy: "round-robin",
      expectedVersion: 1,
    });

    expect(first).toMatchObject({ providerId: "openai-codex", credentialPolicy: "adaptive", version: 1 });
    expect(second).toMatchObject({ providerId: "openai-codex", credentialPolicy: "round-robin", version: 2 });
    await expect(policies.list(context, "openai-codex")).resolves.toEqual([second]);

    const [versions] = await database.query<
      [Array<{ version: number; credential_policy: string; policy_version_id: string }>]
    >(
      `SELECT version, credential_policy, policy_version_id FROM subscription_routing_policy_version
       WHERE organization_id = $organization_id AND provider_id = 'openai-codex' ORDER BY version ASC;`,
      { organization_id: context.organizationId },
    );
    expect(versions).toEqual([
      expect.objectContaining({ version: 1, credential_policy: "adaptive" }),
      expect.objectContaining({ version: 2, credential_policy: "round-robin" }),
    ]);
    await expect(
      database.query(
        "UPDATE subscription_routing_policy_version SET credential_policy = 'weighted' WHERE policy_version_id = $id;",
        { id: versions[0]?.policy_version_id },
      ),
    ).rejects.toThrow("immutable");
  });

  it("같은 command는 같은 결과를 반환하고 다른 payload·stale version·member 변경을 거부한다", async () => {
    const commandId = randomUUID();
    const input = {
      commandId,
      providerId: "anthropic-claude",
      credentialPolicy: "fill-first" as const,
    };
    const first = await policies.configure(context, input);

    await expect(policies.configure(context, input)).resolves.toEqual(first);
    await expect(policies.configure(context, { ...input, credentialPolicy: "weighted" })).rejects.toThrow(
      "같은 Command ID",
    );
    await expect(
      policies.configure(context, {
        commandId: randomUUID(),
        providerId: input.providerId,
        credentialPolicy: "weighted",
        expectedVersion: 99,
      }),
    ).rejects.toThrow("version");
    await expect(
      policies.configure(memberContext, {
        commandId: randomUUID(),
        providerId: input.providerId,
        credentialPolicy: "weighted",
      }),
    ).rejects.toThrow();
  });

  it("미설정 제공자는 adaptive 기본값을 반환하되 영속 version으로 가장하지 않는다", async () => {
    await expect(policies.resolve(context, "github-copilot")).resolves.toEqual({
      providerId: "github-copilot",
      credentialPolicy: "adaptive",
      version: 0,
      source: "default",
    });
  });
});
