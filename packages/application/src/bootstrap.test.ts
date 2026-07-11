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

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const graph = await OrganizationGraphService.create(database, organizations);
    const policies = await PolicyStore.create(database, organizations);
    const tokens = await ApplicationAccessTokenService.create(database, organizations, {
      keyId: "bootstrap-hmac-v1",
      key: Buffer.alloc(32, 9),
    });
    bootstrap = new LocalApplicationBootstrap(identities, organizations, graph, policies, tokens);
  });

  afterEach(async () => {
    await database.close();
  });

  it("loopback trusted bootstrap이 개인 조직·Core Office·기본 정책·첫 token을 생성한다", async () => {
    const result = await bootstrap.initialize({
      commandId: "local-bootstrap-command-0001",
      remoteAddress: "127.0.0.1",
      trustedLocal: true,
      email: "owner@example.com",
      displayName: "Owner",
    });
    expect(result.registration.organization.kind).toBe("personal");
    expect(result.coreOffice.nodes).toHaveLength(8);
    expect(result.policy.status).toBe("active");
    expect(result.access.token).toMatch(/^mat_/u);

    const replayed = await bootstrap.initialize({
      commandId: "local-bootstrap-command-0001",
      remoteAddress: "127.0.0.1",
      trustedLocal: true,
      email: "owner@example.com",
      displayName: "Owner",
    });
    expect(replayed.registration.organization.organization_id).toBe(result.registration.organization.organization_id);
    expect(replayed.coreOffice.version.version).toBe(1);
    expect(replayed.policy.policy_version_id).toBe(result.policy.policy_version_id);
    expect(replayed.access).not.toHaveProperty("token");
  });

  it("remote·untrusted·비loopback bootstrap을 초기 mutation 전에 거부한다", async () => {
    await expect(
      bootstrap.initialize({
        commandId: "remote-bootstrap-command-0001",
        remoteAddress: "203.0.113.8",
        trustedLocal: true,
        email: "remote@example.com",
        displayName: "Remote",
      }),
    ).rejects.toThrow("loopback");
    await expect(
      bootstrap.initialize({
        commandId: "untrusted-bootstrap-command-0001",
        remoteAddress: "::1",
        trustedLocal: false,
        email: "untrusted@example.com",
        displayName: "Untrusted",
      }),
    ).rejects.toThrow("trusted local");
  });
});
