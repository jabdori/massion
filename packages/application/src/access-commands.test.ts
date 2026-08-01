import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase } from "@massion/storage";
import { describe, expect, it } from "vitest";

import { registerApplicationAccessCommands } from "./access-commands.js";
import { ApplicationCommandRegistry } from "./command-registry.js";
import { ApplicationCommandStore } from "./command-store.js";

describe("Application access commands", () => {
  it("Membership 변경에 revision 조건을 강제한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "access-owner@example.com", displayName: "Owner" });
    const member = await identities.registerPersonalUser({ email: "access-member@example.com", displayName: "Member" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const membership = await organizations.addMember(context, member.user.user_id, "member");
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    registerApplicationAccessCommands(registry, { organizations });

    await expect(
      registry.dispatch(context, ["identity:write"], {
        schemaVersion: "massion.application.v1",
        commandId: "membership-role-command-0001",
        correlationId: "membership-role-correlation-0001",
        operation: "identity.membership.role",
        expectedRevision: membership.revision,
        payload: { membershipId: membership.membership_id, role: "admin" },
      }),
    ).resolves.toMatchObject({ resource: { type: "Membership", revision: 1 }, data: { role: "admin" } });
  });
});
