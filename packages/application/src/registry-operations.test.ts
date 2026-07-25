import { IdentityService, OrganizationService } from "@massion/identity";
import { GovernanceApprovalRequiredError } from "@massion/governance";
import { createDatabase } from "@massion/storage";
import { describe, expect, it, vi } from "vitest";

import { ApplicationCommandRegistry } from "./command-registry.js";
import { ApplicationCommandStore } from "./command-store.js";
import { ApplicationQueryRegistry } from "./query-registry.js";
import { registerApplicationRegistryOperations } from "./registry-operations.js";

describe("Application Registry operations", () => {
  it("검색은 모든 member, 설치는 owner/admin, recall은 owner만 허용한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "registry-app@example.com", displayName: "Owner" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const commands = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    const queries = new ApplicationQueryRegistry();
    const operations = {
      search: vi.fn(async () => ({ items: [{ packageName: "@massion-ext/slack" }] })),
      info: vi.fn(async () => ({ packageName: "@massion-ext/slack" })),
      inventory: vi.fn(async () => []),
      install: vi.fn(async () => ({
        installationId: "installation-1",
        packageName: "@massion-ext/slack",
        packageVersion: "1.0.0",
      })),
      recall: vi.fn(async () => ({ recallId: "recall-1", versionId: "version-1" })),
    };
    registerApplicationRegistryOperations(commands, queries, operations);
    await expect(
      queries.query(context, ["extension:read"], "registry.search", { query: "slack", limit: 20 }),
    ).resolves.toMatchObject({ data: { items: expect.any(Array) } });
    await expect(
      commands.dispatch(context, ["extension:write"], {
        schemaVersion: "massion.application.v1",
        commandId: "registry-install-command-1",
        correlationId: "registry-install-correlation-1",
        operation: "registry.install",
        payload: { versionId: "version-1", environment: "production", riskClass: "medium", executionId: "execution-1" },
      }),
    ).resolves.toMatchObject({ outcome: "succeeded" });
    expect(operations.install).toHaveBeenCalledOnce();
  });

  it("레지스트리 설치는 승인 대기를 보존하고 같은 명령으로 승인 재개한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "registry-approval@example.com",
      displayName: "Owner",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const commands = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    const queries = new ApplicationQueryRegistry();
    const operations = {
      search: async () => ({ items: [] }),
      info: async () => ({}),
      inventory: async () => [],
      install: async (_context: unknown, input: { readonly installApprovalId?: string }) => {
        if (!input.installApprovalId)
          throw new GovernanceApprovalRequiredError("decision-registry", "approval-registry");
        return {
          installationId: "installation-registry",
          packageName: "@massion-ext/registry",
          packageVersion: "1.0.0",
        };
      },
      recall: async () => ({ recallId: "recall-1", versionId: "version-1" }),
    };
    registerApplicationRegistryOperations(commands, queries, operations);
    const command = {
      schemaVersion: "massion.application.v1" as const,
      commandId: "registry-approval-command-0001",
      correlationId: "registry-approval-correlation-0001",
      operation: "registry.install",
      payload: { versionId: "version-1", environment: "production", riskClass: "medium", executionId: "execution-1" },
    };
    await expect(commands.dispatch(context, ["extension:write"], command)).resolves.toMatchObject({
      outcome: "awaiting-approval",
      data: { approvalId: "approval-registry" },
    });
    await expect(
      commands.dispatch(context, ["extension:write"], {
        ...command,
        payload: { ...command.payload, installApprovalId: "approval-registry" },
      }),
    ).resolves.toMatchObject({ outcome: "succeeded", data: { installationId: "installation-registry" } });
  });
});
