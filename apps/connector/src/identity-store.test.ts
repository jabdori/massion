import { chmod, lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConnectorIdentityStore, readOwnerOnlySecret } from "./identity-store.js";
import { fixtureDirectory } from "./test-fixtures.js";

describe("Edge Connector 신원 저장소", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
  });

  it("Ed25519 개인 key를 0600 파일과 0700 상위 디렉터리에만 저장한다", async () => {
    const fixture = await fixtureDirectory("massion-connector-identity-");
    cleanups.push(fixture.cleanup);
    const profileRoot = join(fixture.path, "codex-profile");
    const workspaceRoot = join(fixture.path, "workspace");
    await mkdir(profileRoot, { mode: 0o700 });
    await mkdir(workspaceRoot, { mode: 0o700 });
    const identityPath = join(fixture.path, "identities", "personal.json");

    const pending = await ConnectorIdentityStore.createPending(identityPath, {
      baseUrl: "https://massion.example",
      enrollmentId: "enrollment-12345678",
      connectorId: "connector-12345678",
      commandId: "connector-enroll-command-12345678",
      providerId: "openai-codex",
      accountAlias: "개인 Codex",
      authKind: "cli-profile",
      billingKind: "consumer-subscription",
      enrollmentDigest: "a".repeat(64),
      profileRoot,
      workspaceRoots: [workspaceRoot],
    });

    expect(pending.status).toBe("pending");
    expect(pending.privateKey).toContain("BEGIN PRIVATE KEY");
    expect(pending.publicKey).toContain("BEGIN PUBLIC KEY");
    expect(pending.capabilities).toContain("agent-turn");
    expect(pending.capabilities).toContain("openai-codex");
    expect(pending.capabilities.filter((capability) => capability.startsWith("massion.workspace-root.v1."))).toEqual([
      expect.stringMatching(/^massion\.workspace-root\.v1\.[A-Za-z0-9_-]{43}$/u),
    ]);
    expect(JSON.stringify(pending.capabilities)).not.toContain(workspaceRoot);
    expect(await readdir(workspaceRoot)).toEqual([".massion-managed-workspaces-v1"]);
    expect((await stat(identityPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(fixture.path, "identities"))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(identityPath, "utf8"))).toMatchObject({
      schemaVersion: "massion.edge-connector.identity.v1",
      status: "pending",
      providerId: "openai-codex",
      accountAlias: "개인 Codex",
      authKind: "cli-profile",
      billingKind: "consumer-subscription",
      enrollmentDigest: "a".repeat(64),
    });
    await expect(
      ConnectorIdentityStore.createPending(identityPath, {
        baseUrl: "https://massion.example",
        enrollmentId: "enrollment-12345678",
        connectorId: "other-connector-12345678",
        commandId: "other-command-12345678",
        providerId: "openai-codex",
        accountAlias: "변경한 Codex",
        authKind: "cli-profile",
        billingKind: "consumer-subscription",
        enrollmentDigest: "a".repeat(64),
        profileRoot,
        workspaceRoots: [workspaceRoot],
      }),
    ).rejects.toThrow(/pending|일치/u);
  });

  it("workspace는 비어 있는 owner-only 전용 parent 하나만 등록하고 기존 repository와 복수 root를 거부한다", async () => {
    const fixture = await fixtureDirectory("massion-connector-managed-workspace-");
    cleanups.push(fixture.cleanup);
    const profileRoot = join(fixture.path, "profile");
    const firstRoot = join(fixture.path, "first-workspace");
    const secondRoot = join(fixture.path, "second-workspace");
    const repositoryRoot = join(fixture.path, "existing-repository");
    await Promise.all([
      mkdir(profileRoot, { mode: 0o700 }),
      mkdir(firstRoot, { mode: 0o700 }),
      mkdir(secondRoot, { mode: 0o700 }),
      mkdir(repositoryRoot, { mode: 0o700 }),
    ]);
    await writeFile(join(repositoryRoot, ".gitignore"), "node_modules\n", { mode: 0o600 });
    const base = {
      baseUrl: "https://massion.example",
      enrollmentId: "enrollment-managed-12345678",
      connectorId: "connector-managed-12345678",
      commandId: "command-managed-12345678",
      providerId: "openai-codex" as const,
      accountAlias: "관리 Workspace",
      authKind: "cli-profile" as const,
      billingKind: "consumer-subscription" as const,
      enrollmentDigest: "d".repeat(64),
      profileRoot,
    };

    await expect(
      ConnectorIdentityStore.createPending(join(fixture.path, "multiple.json"), {
        ...base,
        workspaceRoots: [firstRoot, secondRoot],
      }),
    ).rejects.toThrow(/정확히 1개|전용/u);
    await expect(
      ConnectorIdentityStore.createPending(join(fixture.path, "repository.json"), {
        ...base,
        workspaceRoots: [repositoryRoot],
      }),
    ).rejects.toThrow(/비어|전용|marker/u);
  });

  it("0600이 아니거나 symlink인 token 파일은 읽지 않는다", async () => {
    const fixture = await fixtureDirectory("massion-connector-token-");
    cleanups.push(fixture.cleanup);
    const unsafe = join(fixture.path, "unsafe-token");
    await writeFile(unsafe, "secret-token\n", { mode: 0o644 });
    await expect(readOwnerOnlySecret(unsafe, "Application token")).rejects.toThrow(/0600/u);

    const target = join(fixture.path, "target-token");
    const link = join(fixture.path, "token-link");
    await writeFile(target, "secret-token\n", { mode: 0o600 });
    await symlink(target, link);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    await expect(readOwnerOnlySecret(link, "Application token")).rejects.toThrow(/symlink/u);
  });

  it("HTTPS origin, 고정 제공자, 절대 profile·workspace 경로만 허용한다", async () => {
    const fixture = await fixtureDirectory("massion-connector-invalid-");
    cleanups.push(fixture.cleanup);
    await expect(
      ConnectorIdentityStore.createPending(join(tmpdir(), "invalid-identity.json"), {
        baseUrl: "http://massion.example",
        enrollmentId: "enrollment-12345678",
        connectorId: "connector-12345678",
        commandId: "connector-enroll-command-12345678",
        providerId: "google-gemini-cli-enterprise" as "openai-codex",
        accountAlias: "개인 Codex",
        authKind: "cli-profile",
        billingKind: "consumer-subscription",
        enrollmentDigest: "a".repeat(64),
        profileRoot: "relative-profile",
        workspaceRoots: ["relative-workspace"],
      }),
    ).rejects.toThrow(/HTTPS|Provider|절대 경로/u);
  });

  it("활성 신원은 exact schema와 Ed25519 key pair를 다시 검증하고 0600이 아니면 읽지 않는다", async () => {
    const fixture = await fixtureDirectory("massion-connector-active-");
    cleanups.push(fixture.cleanup);
    const profileRoot = join(fixture.path, "profile");
    const workspaceRoot = join(fixture.path, "workspace");
    const identityPath = join(fixture.path, "identity.json");
    await mkdir(profileRoot, { mode: 0o700 });
    await mkdir(workspaceRoot, { mode: 0o700 });
    const pending = await ConnectorIdentityStore.createPending(identityPath, {
      baseUrl: "https://massion.example",
      enrollmentId: "enrollment-12345678",
      connectorId: "connector-12345678",
      commandId: "connector-command-12345678",
      providerId: "anthropic-claude-code",
      accountAlias: "개인 Claude",
      authKind: "cli-profile",
      billingKind: "consumer-subscription",
      enrollmentDigest: "b".repeat(64),
      profileRoot,
      workspaceRoots: [workspaceRoot],
    });
    await new ConnectorIdentityStore(identityPath).activate(pending, {
      organizationId: "organization-12345678",
      userId: "user-owner-12345678",
      membershipId: "membership-12345678",
      role: "owner",
    });

    await expect(new ConnectorIdentityStore(identityPath).loadActive()).resolves.toMatchObject({
      status: "active",
      providerId: "anthropic-claude-code",
    });
    await chmod(identityPath, 0o644);
    await expect(new ConnectorIdentityStore(identityPath).loadActive()).rejects.toThrow(/0600/u);
  });

  it("profile이 0755이면 자동 chmod하지 않고 명시적 secure-profile 안내와 함께 거부한다", async () => {
    const fixture = await fixtureDirectory("massion-connector-profile-mode-");
    cleanups.push(fixture.cleanup);
    const profileRoot = join(fixture.path, "profile");
    const workspaceRoot = join(fixture.path, "workspace");
    await mkdir(profileRoot, { mode: 0o755 });
    await mkdir(workspaceRoot, { mode: 0o700 });

    await expect(
      ConnectorIdentityStore.createPending(join(fixture.path, "identity.json"), {
        baseUrl: "https://massion.example",
        enrollmentId: "enrollment-12345678",
        connectorId: "connector-12345678",
        commandId: "connector-command-12345678",
        providerId: "openai-codex",
        accountAlias: "개인 Codex",
        authKind: "cli-profile",
        billingKind: "consumer-subscription",
        enrollmentDigest: "c".repeat(64),
        profileRoot,
        workspaceRoots: [workspaceRoot],
      }),
    ).rejects.toThrow(/0700|secure-profile/u);
    expect((await stat(profileRoot)).mode & 0o777).toBe(0o755);
  });

  it.each([
    ["google-gemini-cli-enterprise", "enterprise-subscription"],
    ["github-copilot", "consumer-subscription"],
    ["xai-grok-build", "consumer-subscription"],
  ] as const)("%s Edge identity에 검증된 외부 runtime 계보를 포함한다", async (providerId, billingKind) => {
    const fixture = await fixtureDirectory("massion-connector-external-identity-");
    cleanups.push(fixture.cleanup);
    const profileRoot = join(fixture.path, "profile");
    const workspaceRoot = join(fixture.path, "workspace");
    const executable = join(fixture.path, "provider-cli");
    await mkdir(profileRoot, { mode: 0o700 });
    await mkdir(workspaceRoot, { mode: 0o700 });
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

    const pending = await ConnectorIdentityStore.createPending(join(fixture.path, "identity.json"), {
      baseUrl: "https://massion.example",
      enrollmentId: "enrollment-12345678",
      connectorId: "connector-12345678",
      commandId: "connector-command-12345678",
      providerId,
      accountAlias: "외부 ACP 계정",
      authKind: "cli-profile",
      billingKind,
      enrollmentDigest: "d".repeat(64),
      profileRoot,
      workspaceRoots: [workspaceRoot],
      runtimeArtifact: { executable, digest: "e".repeat(64), version: "1.2.3" },
    });

    expect(pending).toMatchObject({
      providerId,
      billingKind,
      runtimeArtifact: { executable, digest: "e".repeat(64), version: "1.2.3" },
    });
    expect(pending.capabilities).toEqual(
      expect.arrayContaining([`massion.runtime-artifact.sha256.${"e".repeat(64)}`, "massion.runtime-version.1.2.3"]),
    );
  });

  it("외부 ACP Provider는 cli-profile과 provider별 billing·runtime artifact가 모두 필요하다", async () => {
    const fixture = await fixtureDirectory("massion-connector-external-contract-");
    cleanups.push(fixture.cleanup);
    const profileRoot = join(fixture.path, "profile");
    const workspaceRoot = join(fixture.path, "workspace");
    await mkdir(profileRoot, { mode: 0o700 });
    await mkdir(workspaceRoot, { mode: 0o700 });
    const base = {
      baseUrl: "https://massion.example",
      enrollmentId: "enrollment-12345678",
      connectorId: "connector-12345678",
      commandId: "connector-command-12345678",
      providerId: "google-gemini-cli-enterprise" as const,
      accountAlias: "Gemini Enterprise",
      authKind: "cli-profile" as const,
      billingKind: "enterprise-subscription" as const,
      enrollmentDigest: "f".repeat(64),
      profileRoot,
      workspaceRoots: [workspaceRoot],
    };

    await expect(
      ConnectorIdentityStore.createPending(join(fixture.path, "missing-runtime.json"), base),
    ).rejects.toThrow(/runtime|실행 파일/u);
    await expect(
      ConnectorIdentityStore.createPending(join(fixture.path, "invalid-billing.json"), {
        ...base,
        billingKind: "consumer-subscription",
        runtimeArtifact: { executable: "/opt/gemini", digest: "a".repeat(64), version: "1.2.3" },
      }),
    ).rejects.toThrow(/결제|billing/u);
  });
});
