import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApplicationCommandRegistry } from "./command-registry.js";
import { ApplicationCommandStore } from "./command-store.js";
import {
  registerApplicationIntegrationOperations,
  type ApplicationIntegrationOperations,
} from "./integration-operations.js";
import { ApplicationQueryRegistry } from "./query-registry.js";

describe("Application Integration operations", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let commands: ApplicationCommandRegistry;
  let queries: ApplicationQueryRegistry;
  const connect = vi.fn(async () => ({ installationId: "installation-12345678", revision: 1 }));
  const operations: ApplicationIntegrationOperations = {
    connect,
    async startOAuth(_context, input) {
      return { authorizeUrl: `https://example.invalid/${input.platform}` };
    },
    async bindUser() {
      return { bindingId: "binding-12345678", revision: 1 };
    },
    async bindChannel() {
      return { channelBindingId: "channel-binding-12345678", revision: 1 };
    },
    async list() {
      return [{ platform: "slack", state: "active" }];
    },
    async listDeliveries(_context, limit) {
      return [{ limit, state: "succeeded" }];
    },
  };

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "integration-app@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    commands = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    queries = new ApplicationQueryRegistry();
    connect.mockClear();
    registerApplicationIntegrationOperations(commands, queries, operations);
  });

  afterEach(async () => database.close());

  it("관리 command가 raw credential이 아닌 reference만 Integration port로 전달한다", async () => {
    const result = await commands.dispatch(context, ["extension:write"], {
      schemaVersion: "massion.application.v1",
      commandId: "integration-connect-0001",
      correlationId: "integration-connect-0001",
      operation: "integration.connect",
      payload: {
        platform: "discord",
        externalTenantId: "123456789012345678",
        credentialRef: "credential:discord:primary",
        scopes: ["applications.commands"],
      },
    });
    expect(result).toMatchObject({
      outcome: "succeeded",
      resource: { type: "IntegrationInstallation", id: "installation-12345678", revision: 1 },
    });
    expect(connect).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ commandId: "integration-connect-0001", credentialRef: "credential:discord:primary" }),
    );
  });

  it("scope 없는 설치 변경을 거부하고 read query는 bounded delivery만 반환한다", async () => {
    await expect(
      commands.dispatch(context, ["extension:read"], {
        schemaVersion: "massion.application.v1",
        commandId: "integration-denied-0001",
        correlationId: "integration-denied-0001",
        operation: "integration.connect",
        payload: {
          platform: "slack",
          externalTenantId: "T012ABCDEF",
          credentialRef: "credential:slack:primary",
          scopes: [],
        },
      }),
    ).rejects.toThrow("scope");
    await expect(
      queries.query(context, ["extension:read"], "integration.deliveries", { limit: 25 }),
    ).resolves.toMatchObject({
      data: [{ limit: 25, state: "succeeded" }],
    });
  });
});
