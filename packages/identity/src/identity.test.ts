import { describe, expect, it } from "vitest";

import { createDatabase } from "@massion/storage";

import { IdentityService } from "./identity.js";

describe("개인 Identity bootstrap", () => {
  it("사용자와 1인 personal organization, owner Membership을 원자 생성한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: "identity_first" });
    const service = await IdentityService.create(database);

    const result = await service.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });

    expect(result.user.email).toBe("owner@example.com");
    expect(result.organization.kind).toBe("personal");
    expect(result.membership.role).toBe("owner");
    expect(result.membership.user_id).toBe(result.user.user_id);
    expect(result.membership.organization_id).toBe(result.organization.organization_id);
  });

  it("정규화한 같은 email 재등록은 같은 Identity와 personal organization을 반환한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: "identity_same" });
    const service = await IdentityService.create(database);
    const first = await service.registerPersonalUser({ email: " owner@example.com ", displayName: "Owner" });

    const second = await service.registerPersonalUser({ email: "OWNER@EXAMPLE.COM", displayName: "Changed" });

    expect(second.user.user_id).toBe(first.user.user_id);
    expect(second.organization.organization_id).toBe(first.organization.organization_id);
    expect(await service.listOrganizations(first.user.user_id)).toHaveLength(1);
  });

  it("잘못된 email과 빈 표시 이름을 거부한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: "identity_invalid" });
    const service = await IdentityService.create(database);

    await expect(service.registerPersonalUser({ email: "invalid", displayName: "Owner" })).rejects.toThrow(
      "유효하지 않은 email",
    );
    await expect(service.registerPersonalUser({ email: "owner@example.com", displayName: " " })).rejects.toThrow(
      "표시 이름은 비어 있을 수 없습니다",
    );
  });

  it("동시에 같은 email을 등록해도 personal organization을 하나만 만든다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: "identity_concurrent",
    });
    const service = await IdentityService.create(database);

    const [first, second] = await Promise.all([
      service.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" }),
      service.registerPersonalUser({ email: "OWNER@example.com", displayName: "Owner" }),
    ]);

    expect(second.user.user_id).toBe(first.user.user_id);
    expect(second.organization.organization_id).toBe(first.organization.organization_id);
    expect(await service.listOrganizations(first.user.user_id)).toHaveLength(1);
  });
});
