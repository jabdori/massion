import { GovernanceApprovalRequiredError } from "@massion/governance";
import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";
import { describe, expect, it } from "vitest";

import { ApplicationCommandRegistry } from "../command-registry.js";
import { ApplicationCommandStore } from "../command-store.js";
import { registerApplicationDomainCommands } from "./domain.js";

describe("Application domain adapters", () => {
  it("실제 Work·Organization public service를 command registry에 연결하고 tenant·revision을 보존한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "domain@example.com", displayName: "Domain" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    const core = await graph.bootstrap(context);
    const works = await WorkService.create(database, organizations, graph);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    registerApplicationDomainCommands(registry, { works, organization: graph });

    const created = await registry.dispatch(context, ["work:write"], {
      schemaVersion: "massion.application.v1",
      commandId: "domain-work-create-command-0001",
      correlationId: "domain-work-create-correlation-0001",
      operation: "work.create",
      payload: {
        text: "Application 경계에서 Work 생성",
        surface: "cli",
        organizationVersionId: core.version.version_id,
      },
    });
    expect(created).toMatchObject({ outcome: "succeeded", resource: { type: "Work", revision: 1 } });
    const workId = (created.data as { workId: string }).workId;
    await expect(
      registry.dispatch(context, ["work:write"], {
        schemaVersion: "massion.application.v1",
        commandId: "domain-work-cancel-command-0001",
        correlationId: "domain-work-cancel-correlation-0001",
        operation: "work.cancel",
        expectedRevision: 1,
        payload: { workId },
      }),
    ).resolves.toMatchObject({ outcome: "succeeded", data: { status: "cancelled" } });

    await expect(
      registry.dispatch(context, ["organization:write"], {
        schemaVersion: "massion.application.v1",
        commandId: "domain-organization-command-0001",
        correlationId: "domain-organization-correlation-0001",
        operation: "organization.command",
        expectedRevision: 1,
        payload: {
          kind: "create",
          handle: "domain-specialist",
          name: "Domain Specialist",
          responsibility: "Application adapter 검증",
          parentHandle: "representative",
          scope: "persistent",
        },
      }),
    ).resolves.toMatchObject({ outcome: "succeeded", resource: { type: "Organization", revision: 2 } });
  });

  it("Extension review는 awaiting-approval로 반환하고 같은 command·artifact로 승인 재개한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "extension-domain@example.com", displayName: "Ext" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    const extension = {
      async install(_context: unknown, input: { installApprovalId?: string }) {
        if (!input.installApprovalId)
          throw new GovernanceApprovalRequiredError("decision-extension", "approval-extension");
        return {
          installationId: "installation-domain",
          versionId: "version-domain",
          packageName: "@massion-ext/domain",
          packageVersion: "1.0.0",
          activationGeneration: 1,
          state: "active",
        };
      },
    };
    registerApplicationDomainCommands(registry, { extension: extension as never });
    const initial = {
      schemaVersion: "massion.application.v1" as const,
      commandId: "domain-extension-install-command-0001",
      correlationId: "domain-extension-install-correlation-0001",
      operation: "extension.install",
      payload: { archiveBase64: Buffer.from("archive").toString("base64") },
    };
    await expect(registry.dispatch(context, ["extension:write"], initial)).resolves.toMatchObject({
      outcome: "awaiting-approval",
      data: { approvalId: "approval-extension" },
    });
    await expect(
      registry.dispatch(context, ["extension:write"], {
        ...initial,
        payload: { ...initial.payload, installApprovalId: "approval-extension" },
      }),
    ).resolves.toMatchObject({
      outcome: "succeeded",
      data: { installationId: "installation-domain", packageName: "@massion-ext/domain" },
    });
  });

  it("active 정책이 allow인 Extension은 사람 승인 없이 바로 succeeded를 반환한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "auto-domain@example.com", displayName: "Auto" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    registerApplicationDomainCommands(registry, {
      extension: {
        async install() {
          return {
            installationId: "installation-auto",
            versionId: "version-auto",
            packageName: "@massion-ext/auto",
            packageVersion: "1.0.0",
            activationGeneration: 1,
            state: "active",
          };
        },
      } as never,
    });
    await expect(
      registry.dispatch(context, ["extension:write"], {
        schemaVersion: "massion.application.v1",
        commandId: "domain-extension-auto-command-0001",
        correlationId: "domain-extension-auto-correlation-0001",
        operation: "extension.install",
        payload: { archiveBase64: Buffer.from("archive").toString("base64") },
      }),
    ).resolves.toMatchObject({ outcome: "succeeded" });
  });

  it("Extension source의 local link와 pack을 공개 Gateway에 위임하고 host path는 반환하지 않는다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "package-domain@example.com", displayName: "Pack" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    registerApplicationDomainCommands(registry, {
      extension: {
        link: async () => ({
          sourcePath: "/private/source",
          sourceDigest: "a".repeat(64),
          trustLevel: "untrusted-local",
          validatedAt: "2026-07-11T00:00:00.000Z",
        }),
        pack: async () => ({
          tarballPath: "/private/output/package.tgz",
          artifactDigest: "b".repeat(64),
          packageName: "@massion-ext/example",
          packageVersion: "1.0.0",
        }),
      } as never,
    });
    const link = await registry.dispatch(context, ["extension:write"], {
      schemaVersion: "massion.application.v1",
      commandId: "domain-extension-link-command-0001",
      correlationId: "domain-extension-link-correlation-0001",
      operation: "extension.link",
      payload: { source: "/workspace/ext", environment: "development" },
    });
    const pack = await registry.dispatch(context, ["extension:write"], {
      schemaVersion: "massion.application.v1",
      commandId: "domain-extension-pack-command-0001",
      correlationId: "domain-extension-pack-correlation-0001",
      operation: "extension.pack",
      payload: { source: "/workspace/ext", destination: "/workspace/dist" },
    });
    expect(link).toMatchObject({ outcome: "succeeded", data: { trustLevel: "untrusted-local" } });
    expect(pack).toMatchObject({ outcome: "succeeded", data: { packageName: "@massion-ext/example" } });
    expect(JSON.stringify([link, pack])).not.toContain("/private/");
  });

  it("Provider·endpoint·model·route candidate를 공개 command로 구성한다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: crypto.randomUUID(),
    });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "router-domain@example.com", displayName: "Router" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    registerApplicationDomainCommands(registry, {
      providers: {
        registerProvider: async () => ({ provider: { provider_id: "openai" } }),
        registerEndpoint: async () => ({ endpoint: { endpoint_id: "endpoint-1", provider_id: "openai" } }),
      },
      router: {
        registerModel: async () => ({ profile: { model_profile_id: "profile-1", model_id: "gpt" } }),
        addCandidate: async () => ({ candidate: { candidate_id: "candidate-1", route_id: "route-1" } }),
      },
    } as never);
    const cases = [
      ["router.provider.register", { providerId: "openai", displayName: "OpenAI", adapterKind: "openai-compatible" }],
      [
        "router.endpoint.register",
        { providerId: "openai", name: "API", baseUrl: "https://api.openai.com/v1", local: false },
      ],
      [
        "router.model.register",
        {
          providerId: "openai",
          endpointId: "endpoint-1",
          modelId: "gpt",
          routeKind: "chat",
          contextWindow: 128000,
          supportsTools: true,
          supportsStructuredOutput: true,
          supportsVision: true,
          supportsStreaming: true,
          equivalenceGroup: "general",
          evalScore: 0.9,
          inputCostMicrosPerMillion: 1,
          outputCostMicrosPerMillion: 1,
          verified: true,
        },
      ],
      ["router.candidate.add", { routeId: "route-1", modelProfileId: "profile-1", priority: 1 }],
    ] as const;
    for (const [operation, payload] of cases) {
      await expect(
        registry.dispatch(context, ["router:write"], {
          schemaVersion: "massion.application.v1",
          commandId: crypto.randomUUID(),
          correlationId: crypto.randomUUID(),
          operation,
          payload,
        }),
      ).resolves.toMatchObject({ outcome: "succeeded" });
    }
  });

  it("Assurance binding 제안과 정책 승인 재개를 공개 command로 제공한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "binding-domain@example.com",
      displayName: "Binding",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    registerApplicationDomainCommands(registry, {
      assuranceBindings: {
        propose: async () => ({ bindingVersionId: "binding-1", revision: 1, status: "draft" }),
        activate: async (_context: unknown, input: { approvalId?: string }) => {
          if (!input.approvalId) throw new GovernanceApprovalRequiredError("decision-1", "approval-1");
          return { bindingVersionId: "binding-1", revision: 2, status: "active" };
        },
      },
    } as never);
    const base = {
      schemaVersion: "massion.application.v1" as const,
      commandId: "binding-propose-command-0001",
      correlationId: "binding-propose-correlation-0001",
      operation: "assurance.binding.propose",
      payload: {
        workId: "work-1",
        planVersionId: "plan-1",
        profileId: "profile",
        profileVersion: "1",
        authorHandle: "assurance",
        requiredCriteria: [],
        bindings: [],
      },
    };
    await expect(registry.dispatch(context, ["assurance:write"], base)).resolves.toMatchObject({
      outcome: "succeeded",
    });
    const activation = {
      ...base,
      commandId: "binding-activate-command-0001",
      operation: "assurance.binding.activate",
      payload: { bindingVersionId: "binding-1", expectedRevision: 1 },
    };
    await expect(registry.dispatch(context, ["assurance:write"], activation)).resolves.toMatchObject({
      outcome: "awaiting-approval",
      data: { approvalId: "approval-1" },
    });
    await expect(
      registry.dispatch(context, ["assurance:write"], {
        ...activation,
        payload: { ...activation.payload, approvalId: "approval-1" },
      }),
    ).resolves.toMatchObject({ outcome: "succeeded", data: { status: "active" } });
  });
});
