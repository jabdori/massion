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
      approvalMode: "automatic",
    });
    const second = await policies.configure(context, {
      commandId: randomUUID(),
      providerId: "openai-codex",
      credentialPolicy: "round-robin",
      approvalMode: "deny",
      expectedVersion: 1,
    });

    expect(first).toMatchObject({
      providerId: "openai-codex",
      credentialPolicy: "adaptive",
      approvalMode: "automatic",
      version: 1,
    });
    expect(second).toMatchObject({
      providerId: "openai-codex",
      credentialPolicy: "round-robin",
      approvalMode: "deny",
      version: 2,
    });
    await expect(policies.list(context, "openai-codex")).resolves.toEqual([second]);

    const [versions] = await database.query<
      [Array<{ version: number; credential_policy: string; approval_mode: string; policy_version_id: string }>]
    >(
      `SELECT version, credential_policy, approval_mode, policy_version_id FROM subscription_routing_policy_version
       WHERE organization_id = $organization_id AND provider_id = 'openai-codex' ORDER BY version ASC;`,
      { organization_id: context.organizationId },
    );
    expect(versions).toEqual([
      expect.objectContaining({ version: 1, credential_policy: "adaptive", approval_mode: "automatic" }),
      expect.objectContaining({ version: 2, credential_policy: "round-robin", approval_mode: "deny" }),
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
      approvalMode: "review" as const,
    };
    const first = await policies.configure(context, input);

    await expect(policies.configure(context, input)).resolves.toEqual(first);
    await expect(policies.configure(context, { ...input, approvalMode: "automatic" })).rejects.toThrow(
      "같은 Command ID",
    );
    await expect(
      policies.configure(context, {
        commandId: randomUUID(),
        providerId: input.providerId,
        credentialPolicy: "weighted",
        approvalMode: "automatic",
        expectedVersion: 99,
      }),
    ).rejects.toThrow("version");
    await expect(
      policies.configure(memberContext, {
        commandId: randomUUID(),
        providerId: input.providerId,
        credentialPolicy: "weighted",
        approvalMode: "automatic",
      }),
    ).rejects.toThrow();
  });

  it("미설정 Edge ACP 제공자는 지원하지 않는 review 대신 안전한 deny 기본값을 반환한다", async () => {
    await expect(policies.resolve(context, "github-copilot")).resolves.toEqual({
      providerId: "github-copilot",
      credentialPolicy: "adaptive",
      approvalMode: "deny",
      version: 0,
      source: "default",
    });
  });

  it("Codex Provider 정책은 서버 연결에서 지원하는 review를 저장할 수 있다", async () => {
    await expect(
      policies.configure(context, {
        commandId: randomUUID(),
        providerId: "openai-codex",
        credentialPolicy: "adaptive",
        approvalMode: "review",
      }),
    ).resolves.toMatchObject({ providerId: "openai-codex", approvalMode: "review" });
  });

  it("Provider가 공개한 승인 방식만 저장하고 연결 불가 Provider 정책을 거부한다", async () => {
    await expect(
      policies.configure(context, {
        commandId: randomUUID(),
        providerId: "github-copilot",
        credentialPolicy: "adaptive",
        approvalMode: "review",
      }),
    ).rejects.toThrow(/허용되지/u);
    await expect(
      policies.configure(context, {
        commandId: randomUUID(),
        providerId: "github-copilot",
        credentialPolicy: "adaptive",
        approvalMode: "automatic",
      }),
    ).resolves.toMatchObject({ providerId: "github-copilot", approvalMode: "automatic" });
    await expect(
      policies.configure(context, {
        commandId: randomUUID(),
        providerId: "google-antigravity-cli",
        credentialPolicy: "adaptive",
        approvalMode: "deny",
      }),
    ).rejects.toThrow(/연결 표면/u);
  });

  it("이전 client가 승인 방식을 생략해도 현재 명시적 방식을 review로 되돌리지 않는다", async () => {
    await policies.configure(context, {
      commandId: randomUUID(),
      providerId: "openai-codex",
      credentialPolicy: "adaptive",
      approvalMode: "automatic",
    });

    await expect(
      policies.configure(context, {
        commandId: randomUUID(),
        providerId: "openai-codex",
        credentialPolicy: "round-robin",
        expectedVersion: 1,
      }),
    ).resolves.toMatchObject({ approvalMode: "automatic", version: 2 });
  });
});
