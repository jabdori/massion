import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase } from "@massion/storage";

import { SubscriptionDataDisclosureService, subscriptionDataDisclosure } from "./data-disclosure.js";

describe("구독 제공자 데이터 고지 동의", () => {
  it("개인 Codex 데이터 제어 고지를 명시 동의한 사용자에게만 준비 권한을 부여하고, 동의 기록은 재사용한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "disclosure@example.com", displayName: "Disclosure" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const disclosures = await SubscriptionDataDisclosureService.create(database, organizations);
    const disclosure = subscriptionDataDisclosure("openai-codex");

    await expect(disclosures.requireAcknowledgement(context, disclosure.providerId)).rejects.toThrow(
      "데이터 처리 고지 동의",
    );
    const first = await disclosures.acknowledge(context, {
      commandId: "data-disclosure-command-0001",
      providerId: disclosure.providerId,
      version: disclosure.version,
    });
    const repeated = await disclosures.acknowledge(context, {
      commandId: "data-disclosure-command-0002",
      providerId: disclosure.providerId,
      version: disclosure.version,
    });

    expect(repeated).toEqual(first);
    await expect(disclosures.requireAcknowledgement(context, disclosure.providerId)).resolves.toBeUndefined();
    const [records] = await database.query<
      [Array<{ readonly provider_id: string; readonly disclosure_version: string; readonly command_id: string }>]
    >(
      "SELECT provider_id, disclosure_version, command_id FROM subscription_data_disclosure_acknowledgement WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );
    expect(records).toEqual([
      {
        provider_id: "openai-codex",
        disclosure_version: disclosure.version,
        command_id: "data-disclosure-command-0001",
      },
    ]);
  });

  it("알 수 없거나 이전 고지 버전은 동의로 기록하지 않는다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "disclosure-version@example.com",
      displayName: "Version",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const disclosures = await SubscriptionDataDisclosureService.create(database, organizations);

    await expect(
      disclosures.acknowledge(context, {
        commandId: "data-disclosure-command-0003",
        providerId: "openai-codex",
        version: "obsolete-version",
      }),
    ).rejects.toThrow("고지 버전");
    await expect(
      disclosures.acknowledge(context, {
        commandId: "data-disclosure-command-0004",
        providerId: "unknown-provider",
        version: "unknown",
      }),
    ).rejects.toThrow("고지");
  });
});
