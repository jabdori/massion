import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { connectorCliFailureMessage, executeConnectorCli, parseConnectorCli } from "./cli.js";
import {
  ProviderProfileOwnershipError,
  ProviderProfilePathError,
  ProviderProfilePermissionError,
} from "./profile-permissions.js";
import { ProviderReauthenticationRequiredError } from "./profile-health.js";
import { fixtureDirectory } from "./test-fixtures.js";

describe("massion-connector CLI", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
  });

  it("enrollment code·token 값을 argv로 받지 않고 file/stdin 참조만 허용한다", () => {
    expect(() => parseConnectorCli(["enroll", "--token", "secret"])).toThrow(/허용하지|알 수 없는/u);
    expect(() => parseConnectorCli(["enroll", "--enrollment-code", "one-time-secret"])).toThrow(/허용하지|알 수 없는/u);
  });

  it("provider·alias·auth·billing과 하나의 전용 관리 workspace를 사용자 선택 그대로 파싱한다", () => {
    expect(
      parseConnectorCli([
        "enroll",
        "--base-url",
        "https://massion.example",
        "--token-file",
        "/secure/token",
        "--enrollment-file",
        "-",
        "--identity-file",
        "/secure/codex.json",
        "--provider",
        "openai-codex",
        "--alias",
        "개인 Codex",
        "--auth",
        "cli-profile",
        "--billing",
        "consumer-subscription",
        "--profile-root",
        "/profiles/codex-a",
        "--workspace-root",
        "/work/a",
      ]),
    ).toEqual({
      command: "enroll",
      baseUrl: "https://massion.example",
      tokenFile: "/secure/token",
      enrollmentFile: "-",
      identityFile: "/secure/codex.json",
      providerId: "openai-codex",
      alias: "개인 Codex",
      authKind: "cli-profile",
      billingKind: "consumer-subscription",
      profileRoot: "/profiles/codex-a",
      workspaceRoots: ["/work/a"],
    });
    expect(() =>
      parseConnectorCli([
        "enroll",
        "--base-url",
        "https://massion.example",
        "--token-file",
        "/secure/token",
        "--enrollment-file",
        "-",
        "--identity-file",
        "/secure/codex.json",
        "--provider",
        "openai-codex",
        "--alias",
        "개인 Codex",
        "--auth",
        "cli-profile",
        "--billing",
        "consumer-subscription",
        "--profile-root",
        "/profiles/codex-a",
        "--workspace-root",
        "/work/a",
        "--workspace-root",
        "/work/b",
      ]),
    ).toThrow(/정확히 1개|전용/u);
  });

  it("owner-only enrollment 파일을 읽어 account까지 연결하고 secret 없는 결과만 출력한다", async () => {
    const fixture = await fixtureDirectory("massion-connector-cli-");
    cleanups.push(fixture.cleanup);
    const enrollmentFile = join(fixture.path, "enrollment.json");
    const tokenFile = join(fixture.path, "token");
    const identityFile = join(fixture.path, "identity.json");
    const profileRoot = join(fixture.path, "profile");
    const workspaceRoot = join(fixture.path, "workspace");
    await writeFile(
      enrollmentFile,
      JSON.stringify({
        enrollmentId: "enrollment-12345678",
        enrollmentCode: "one-time-code-secret",
        challengeNonce: "challenge-12345678",
        expiresAt: "2030-01-01T00:00:00.000Z",
      }),
      { mode: 0o600 },
    );
    await writeFile(tokenFile, "application-token-secret", { mode: 0o600 });
    await mkdir(profileRoot, { mode: 0o700 });
    await mkdir(workspaceRoot, { mode: 0o700 });
    const enroll = vi.fn().mockResolvedValue({
      identity: { connectorId: "connector-12345678" },
      account: { accountId: "account-12345678", alias: "개인 Codex", status: "offline" },
    });
    const outputs: string[] = [];

    await executeConnectorCli(
      {
        command: "enroll",
        baseUrl: "https://massion.example",
        tokenFile,
        enrollmentFile,
        identityFile,
        providerId: "openai-codex",
        alias: "개인 Codex",
        authKind: "cli-profile",
        billingKind: "consumer-subscription",
        profileRoot,
        workspaceRoots: [workspaceRoot],
      },
      { enroll, output: (line) => outputs.push(line), signal: new AbortController().signal },
    );

    expect(enroll).toHaveBeenCalledWith(
      expect.objectContaining({
        enrollment: expect.objectContaining({ enrollmentCode: "one-time-code-secret" }),
        alias: "개인 Codex",
        authKind: "cli-profile",
        billingKind: "consumer-subscription",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(outputs).toHaveLength(1);
    expect(JSON.parse(outputs[0] ?? "{}")).toMatchObject({ status: "enrolled", accountStatus: "offline" });
    expect(outputs[0]).toContain("connector-12345678");
    expect(outputs[0]).toContain("account-12345678");
    expect(outputs[0]).not.toContain("one-time-code-secret");
    expect(outputs[0]).not.toContain("application-token-secret");
  });

  it("run은 0600 활성 identity를 불러와 전달된 AbortSignal로 장기 연결을 실행한다", async () => {
    const signal = new AbortController().signal;
    const identity = { status: "active", connectorId: "connector-12345678" };
    const loadIdentity = vi.fn().mockResolvedValue(identity);
    const run = vi.fn().mockResolvedValue(undefined);
    await executeConnectorCli(
      { command: "run", identityFile: "/secure/identity.json" },
      { loadIdentity, run, signal, output: vi.fn() },
    );
    expect(loadIdentity).toHaveBeenCalledWith("/secure/identity.json");
    expect(run).toHaveBeenCalledWith(identity, signal);
  });

  it("secure-profile은 별도 명령으로만 profile 권한 migration을 실행한다", async () => {
    expect(parseConnectorCli(["secure-profile", "--profile-root", "/profiles/codex-a"])).toEqual({
      command: "secure-profile",
      profileRoot: "/profiles/codex-a",
    });
    const secureProfile = vi.fn(async () => "/profiles/codex-a");
    const output = vi.fn();

    await executeConnectorCli(
      { command: "secure-profile", profileRoot: "/profiles/codex-a" },
      { secureProfile, output },
    );

    expect(secureProfile).toHaveBeenCalledWith("/profiles/codex-a");
    expect(output).toHaveBeenCalledWith(
      JSON.stringify({ schemaVersion: "massion.edge-connector.cli.v1", status: "profile-secured" }),
    );
  });

  it("검증할 수 없는 auth 선택은 등록 전에 거부한다", () => {
    const base = [
      "enroll",
      "--base-url",
      "https://massion.example",
      "--token-file",
      "/secure/token",
      "--enrollment-file",
      "-",
      "--identity-file",
      "/secure/codex.json",
      "--provider",
      "openai-codex",
      "--alias",
      "개인 Codex",
      "--billing",
      "consumer-subscription",
      "--profile-root",
      "/profiles/codex-a",
      "--workspace-root",
      "/work/a",
    ];
    expect(() => parseConnectorCli(base)).toThrow(/--auth/u);
    expect(() => parseConnectorCli([...base, "--auth", "device-code"])).toThrow(/--auth/u);
  });

  it.each([
    ["google-gemini-cli-enterprise", "enterprise-subscription", "/opt/gemini"],
    ["github-copilot", "organization-subscription", "/opt/copilot"],
    ["xai-grok-build", "consumer-subscription", "/opt/grok"],
  ] as const)(
    "%s는 PATH 탐색 없이 명시적 외부 runtime 실행 파일만 파싱한다",
    (providerId, billingKind, runtimeExecutable) => {
      expect(
        parseConnectorCli([
          "enroll",
          "--base-url",
          "https://massion.example",
          "--token-file",
          "/secure/token",
          "--enrollment-file",
          "-",
          "--identity-file",
          `/secure/${providerId}.json`,
          "--provider",
          providerId,
          "--alias",
          "외부 ACP 계정",
          "--auth",
          "cli-profile",
          "--billing",
          billingKind,
          "--profile-root",
          `/profiles/${providerId}`,
          "--runtime-executable",
          runtimeExecutable,
          "--accept-experimental",
          "true",
          "--workspace-root",
          "/work/a",
        ]),
      ).toMatchObject({
        providerId,
        billingKind,
        runtimeExecutable,
        authKind: "cli-profile",
        acceptExperimental: true,
      });

      expect(() =>
        parseConnectorCli([
          "enroll",
          "--base-url",
          "https://massion.example",
          "--token-file",
          "/secure/token",
          "--enrollment-file",
          "-",
          "--identity-file",
          `/secure/${providerId}.json`,
          "--provider",
          providerId,
          "--alias",
          "외부 ACP 계정",
          "--auth",
          "cli-profile",
          "--billing",
          billingKind,
          "--profile-root",
          `/profiles/${providerId}`,
          "--workspace-root",
          "/work/a",
        ]),
      ).toThrow(/runtime|실행 파일/u);
    },
  );

  it("profile 권한 오류만 안전한 migration 안내로 표시하고 다른 원문 오류는 숨긴다", () => {
    expect(connectorCliFailureMessage(new ProviderProfilePermissionError())).toMatch(/secure-profile.*0700/u);
    expect(connectorCliFailureMessage(new ProviderProfileOwnershipError())).toMatch(/현재 사용자 소유/u);
    expect(connectorCliFailureMessage(new ProviderProfilePathError())).toMatch(/symlink|실제 디렉터리/u);
    expect(connectorCliFailureMessage(new ProviderReauthenticationRequiredError())).toMatch(/needs-reauth|재인증/u);
    expect(connectorCliFailureMessage(new Error("Bearer secret user@example.com"))).toBe(
      "massion-connector: 요청을 안전하게 완료하지 못했습니다",
    );
  });
});
