import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PinnedProviderProfileHealthProbe, ProviderReauthenticationRequiredError } from "./profile-health.js";
import { fixtureDirectory } from "./test-fixtures.js";

describe("고정 Provider profile 인증 health", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
  });

  it("Codex와 Claude의 공식 status가 증명한 인증 방식만 사용자 선택과 일치시킨다", async () => {
    const fixture = await fixtureDirectory("massion-profile-health-");
    cleanups.push(fixture.cleanup);
    const profileRoot = join(fixture.path, "profile");
    await mkdir(profileRoot, { mode: 0o700 });
    const codexAccount = vi.fn(async () => ({
      account: { type: "chatgpt", planType: "plus" },
      requiresOpenaiAuth: true,
    }));
    const claudeStatus = vi.fn(async () => ({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }));
    const probe = new PinnedProviderProfileHealthProbe({ codexAccount, claudeStatus });
    const signal = new AbortController().signal;

    await expect(
      probe.verify({
        providerId: "openai-codex",
        profileRoot,
        expectedAuthKind: "cli-profile",
        billingKind: "consumer-subscription",
        signal,
      }),
    ).resolves.toEqual({ authKind: "cli-profile" });
    await expect(
      probe.verify({
        providerId: "anthropic-claude-code",
        profileRoot,
        expectedAuthKind: "api-key",
        billingKind: "api-usage",
        signal,
      }),
    ).resolves.toEqual({ authKind: "api-key" });

    expect(codexAccount).toHaveBeenCalledWith(profileRoot, signal);
    expect(claudeStatus).toHaveBeenCalledWith(profileRoot, signal);
  });

  it.each(["free", "unknown", undefined])(
    "Codex 소비자 구독은 유료로 증명되지 않은 planType=%s를 needs-reauth로 거부한다",
    async (planType) => {
      const fixture = await fixtureDirectory("massion-profile-health-paid-plan-");
      cleanups.push(fixture.cleanup);
      const profileRoot = join(fixture.path, "profile");
      await mkdir(profileRoot, { mode: 0o700 });
      const probe = new PinnedProviderProfileHealthProbe({
        codexAccount: async () => ({
          account: { type: "chatgpt", ...(planType === undefined ? {} : { planType }) },
          requiresOpenaiAuth: true,
        }),
      });

      await expect(
        probe.verify({
          providerId: "openai-codex",
          profileRoot,
          expectedAuthKind: "cli-profile",
          billingKind: "consumer-subscription",
        }),
      ).rejects.toMatchObject({ code: "needs-reauth" });
    },
  );

  it("Codex API 사용 계정은 ChatGPT planType 대신 apiKey 계보를 검증한다", async () => {
    const fixture = await fixtureDirectory("massion-profile-health-api-key-");
    cleanups.push(fixture.cleanup);
    const profileRoot = join(fixture.path, "profile");
    await mkdir(profileRoot, { mode: 0o700 });
    const probe = new PinnedProviderProfileHealthProbe({
      codexAccount: async () => ({ account: { type: "apiKey" }, requiresOpenaiAuth: true }),
    });

    await expect(
      probe.verify({
        providerId: "openai-codex",
        profileRoot,
        expectedAuthKind: "api-key",
        billingKind: "api-usage",
      }),
    ).resolves.toEqual({ authKind: "api-key" });
  });

  it("로그아웃·제3자 Provider·사용자 선택과 다른 인증 방식은 needs-reauth로 거부한다", async () => {
    const fixture = await fixtureDirectory("massion-profile-health-reauth-");
    cleanups.push(fixture.cleanup);
    const profileRoot = join(fixture.path, "profile");
    await mkdir(profileRoot, { mode: 0o700 });
    const cases = [
      new PinnedProviderProfileHealthProbe({
        codexAccount: async () => ({ account: { type: "apiKey" }, requiresOpenaiAuth: true }),
      }),
      new PinnedProviderProfileHealthProbe({
        claudeStatus: async () => ({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }),
      }),
      new PinnedProviderProfileHealthProbe({
        claudeStatus: async () => ({ loggedIn: true, authMethod: "claude.ai", apiProvider: "bedrock" }),
      }),
    ];

    for (const [index, probe] of cases.entries()) {
      const providerId = index === 0 ? "openai-codex" : "anthropic-claude-code";
      await expect(
        probe.verify({
          providerId,
          profileRoot,
          expectedAuthKind: "cli-profile",
          billingKind: "consumer-subscription",
        }),
      ).rejects.toMatchObject({
        name: "ProviderReauthenticationRequiredError",
        code: "needs-reauth",
      });
    }
    expect(new ProviderReauthenticationRequiredError()).toMatchObject({ code: "needs-reauth" });
  });

  it("symlink과 0700이 아닌 profile은 Provider status 실행 전에 fail-closed로 거부한다", async () => {
    const fixture = await fixtureDirectory("massion-profile-health-invalid-");
    cleanups.push(fixture.cleanup);
    const profileRoot = join(fixture.path, "profile");
    const link = join(fixture.path, "profile-link");
    await mkdir(profileRoot, { mode: 0o700 });
    await symlink(profileRoot, link);
    const codexAccount = vi.fn(async () => ({ account: { type: "chatgpt" }, requiresOpenaiAuth: true }));
    const probe = new PinnedProviderProfileHealthProbe({ codexAccount });

    await expect(
      probe.verify({
        providerId: "openai-codex",
        profileRoot: link,
        expectedAuthKind: "cli-profile",
        billingKind: "consumer-subscription",
      }),
    ).rejects.toThrow(/안전|symlink/u);
    await chmod(profileRoot, 0o755);
    await expect(
      probe.verify({
        providerId: "openai-codex",
        profileRoot,
        expectedAuthKind: "cli-profile",
        billingKind: "consumer-subscription",
      }),
    ).rejects.toThrow(/0700|secure-profile/u);
    expect(codexAccount).not.toHaveBeenCalled();
  });

  it("bundled Codex app-server account/read는 비어 있는 profile을 needs-reauth로 판정한다", async () => {
    const fixture = await fixtureDirectory("massion-profile-health-codex-rpc-");
    cleanups.push(fixture.cleanup);
    const profileRoot = join(fixture.path, "profile");
    await mkdir(profileRoot, { mode: 0o700 });

    await expect(
      new PinnedProviderProfileHealthProbe().verify({
        providerId: "openai-codex",
        profileRoot,
        expectedAuthKind: "cli-profile",
        billingKind: "consumer-subscription",
      }),
    ).rejects.toMatchObject({ code: "needs-reauth" });
  }, 15_000);

  it.each([
    ["google-gemini-cli-enterprise", "enterprise-subscription"],
    ["github-copilot", "consumer-subscription"],
    ["xai-grok-build", "consumer-subscription"],
  ] as const)(
    "%s는 증명된 실행 파일로 ACP session을 열어 cached profile health를 확인한다",
    async (providerId, billingKind) => {
      const fixture = await fixtureDirectory("massion-profile-health-acp-");
      cleanups.push(fixture.cleanup);
      const profileRoot = join(fixture.path, "profile");
      const executable = join(fixture.path, "provider-cli");
      await mkdir(profileRoot, { mode: 0o700 });
      await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const runtimeArtifact = { executable, digest: "a".repeat(64), version: "1.2.3" };
      const acpSession = vi.fn(async () => undefined);
      const probe = new PinnedProviderProfileHealthProbe({ acpSession });

      await expect(
        probe.verify({
          providerId,
          profileRoot,
          expectedAuthKind: "cli-profile",
          billingKind,
          runtimeArtifact,
        }),
      ).resolves.toEqual({ authKind: "cli-profile" });
      expect(acpSession).toHaveBeenCalledWith({ providerId, profileRoot, runtimeArtifact, signal: undefined });
    },
  );

  it("외부 ACP health는 ambient API key와 runtime 계보 없는 실행을 거부한다", async () => {
    const fixture = await fixtureDirectory("massion-profile-health-acp-invalid-");
    cleanups.push(fixture.cleanup);
    const profileRoot = join(fixture.path, "profile");
    await mkdir(profileRoot, { mode: 0o700 });
    const acpSession = vi.fn(async () => undefined);
    const probe = new PinnedProviderProfileHealthProbe({ acpSession });

    await expect(
      probe.verify({
        providerId: "xai-grok-build",
        profileRoot,
        expectedAuthKind: "api-key",
        billingKind: "api-usage",
      }),
    ).rejects.toMatchObject({ code: "needs-reauth" });
    expect(acpSession).not.toHaveBeenCalled();
  });
});
