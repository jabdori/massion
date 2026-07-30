import { PolicyStore } from "@massion/governance";
import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApplicationAccessTokenService } from "./auth.js";
import { LocalApplicationBootstrap } from "./bootstrap.js";

describe("LocalApplicationBootstrap", () => {
  let database: MassionDatabase;
  let bootstrap: LocalApplicationBootstrap;
  let identities: IdentityService;
  let organizations: OrganizationService;
  let graph: OrganizationGraphService;
  let policies: PolicyStore;
  let tokens: ApplicationAccessTokenService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    identities = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    graph = await OrganizationGraphService.create(database, organizations);
    policies = await PolicyStore.create(database, organizations);
    tokens = await ApplicationAccessTokenService.create(database, organizations, {
      keyId: "bootstrap-hmac-v1",
      key: Buffer.alloc(32, 9),
    });
    bootstrap = new LocalApplicationBootstrap(identities, organizations, graph, policies, tokens);
  });

  afterEach(async () => {
    await database.close();
  });

  it("loopback trusted bootstrap이 프로필 입력 없이 로컬 설치 조직·Core Office·기본 정책·첫 token을 생성한다", async () => {
    const result = await bootstrap.initialize({
      commandId: "local-bootstrap-command-0001",
      remoteAddress: "127.0.0.1",
    });
    expect(result.registration.organization.kind).toBe("personal");
    expect(result.coreOffice.nodes).toHaveLength(8);
    expect(result.policy.status).toBe("active");
    expect(result.access.token).toMatch(/^mat_/u);

    const replayed = await bootstrap.initialize({
      commandId: "local-bootstrap-command-0001",
      remoteAddress: "127.0.0.1",
    });
    expect(replayed.registration.organization.organization_id).toBe(result.registration.organization.organization_id);
    expect(replayed.coreOffice.version.version).toBe(1);
    expect(replayed.policy.policy_version_id).toBe(result.policy.policy_version_id);
    expect(replayed.access).not.toHaveProperty("token");
  });

  it("growth가 연결된 onboarding은 활성 PromptDefinitionVersion 시드를 위해 growth.start를 호출한다", async () => {
    // growth 패키지가 실제 시드 동작을 검증하므로 여기서는 onboarding 연결(wiring)만 확인합니다.
    const calls: { readonly organizationId: string }[] = [];
    const growth = {
      async start(context: { organizationId: string }) {
        calls.push({ organizationId: context.organizationId });
        return { action: "initialize" as const };
      },
    };
    const wiredBootstrap = new LocalApplicationBootstrap(identities, organizations, graph, policies, tokens, growth);

    const result = await wiredBootstrap.initialize({
      commandId: "local-bootstrap-growth-command-0001",
      remoteAddress: "127.0.0.1",
    });

    expect(calls).toEqual([{ organizationId: result.registration.organization.organization_id }]);
  });

  it("비loopback bootstrap을 초기 mutation 전에 거부한다", async () => {
    await expect(
      bootstrap.initialize({
        commandId: "remote-bootstrap-command-0001",
        remoteAddress: "203.0.113.8",
      }),
    ).rejects.toThrow("loopback");
  });
});
