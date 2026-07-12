import { createPublicKey, verify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createEnrollmentSignaturePayload } from "@massion/subscriptions";
import { afterEach, describe, expect, it, vi } from "vitest";

import { enrollEdgeConnector } from "./enrollment.js";
import { ProviderReauthenticationRequiredError } from "./profile-health.js";
import { fixtureDirectory } from "./test-fixtures.js";

describe("Edge Connector 일회 등록", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
  });

  it("owner-only token을 Authorization header에만 사용하고 정확한 Ed25519 등록 payload를 전송한다", async () => {
    const fixture = await fixtureDirectory("massion-connector-enrollment-");
    cleanups.push(fixture.cleanup);
    const tokenPath = join(fixture.path, "application.token");
    const identityPath = join(fixture.path, "identities", "codex.json");
    const profileRoot = join(fixture.path, "profile");
    const workspaceRoot = join(fixture.path, "workspace");
    await writeFile(tokenPath, "owner-secret-token\n", { mode: 0o600 });
    await mkdir(profileRoot, { mode: 0o700 });
    await mkdir(workspaceRoot, { mode: 0o700 });
    const enrollment = {
      enrollmentId: "enrollment-12345678",
      enrollmentCode: "one-time-code-secret",
      challengeNonce: "challenge-nonce-12345678",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    let verificationPayload: Record<string, unknown> | undefined;
    let connectionPayload: Record<string, unknown> | undefined;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer owner-secret-token");
      if (url.pathname === "/api/v1/me") {
        return Response.json({
          schemaVersion: "massion.application.v1",
          operation: "identity.me",
          data: {
            userId: "user-owner-12345678",
            organizationId: "organization-12345678",
            membershipId: "membership-12345678",
            role: "owner",
          },
        });
      }
      const command = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (command.operation === "subscription.account.register") {
        connectionPayload = command;
        return Response.json({
          schemaVersion: "massion.application.v1",
          commandId: command.commandId,
          correlationId: command.correlationId,
          operation: command.operation,
          outcome: "succeeded",
          data: {
            accountId: "account-12345678",
            providerId: "openai-codex",
            alias: "개인 Codex",
            scope: "personal",
            connectorId: (command.payload as Record<string, unknown>).connectorId,
            billingKind: "consumer-subscription",
            status: "offline",
            consentVersion: 0,
            version: 1,
          },
        });
      }
      verificationPayload = command;
      return Response.json({
        schemaVersion: "massion.application.v1",
        commandId: verificationPayload.commandId,
        correlationId: verificationPayload.correlationId,
        operation: "subscription.connector.enroll",
        outcome: "succeeded",
        data: { connectorId: (verificationPayload.payload as Record<string, unknown>).connectorId },
      });
    });

    const signal = new AbortController().signal;
    const healthProbe = { verify: vi.fn(async () => ({ authKind: "cli-profile" as const })) };
    const connected = await enrollEdgeConnector({
      baseUrl: "https://massion.example",
      tokenFile: tokenPath,
      identityFile: identityPath,
      enrollment,
      providerId: "openai-codex",
      alias: "개인 Codex",
      authKind: "cli-profile",
      billingKind: "consumer-subscription",
      profileRoot,
      workspaceRoots: [workspaceRoot],
      fetcher,
      healthProbe,
      signal,
    });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(healthProbe.verify).toHaveBeenCalledWith({
      providerId: "openai-codex",
      profileRoot,
      expectedAuthKind: "cli-profile",
      billingKind: "consumer-subscription",
      signal,
    });
    for (const call of fetcher.mock.calls) {
      expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(connected).toMatchObject({
      identity: {
        status: "active",
        organizationId: "organization-12345678",
        ownerUserId: "user-owner-12345678",
        providerId: "openai-codex",
      },
      account: {
        accountId: "account-12345678",
        alias: "개인 Codex",
        status: "offline",
      },
    });
    const command = verificationPayload as {
      schemaVersion: string;
      operation: string;
      payload: Record<string, unknown>;
    };
    expect(command.schemaVersion).toBe("massion.application.v1");
    expect(command.operation).toBe("subscription.connector.enroll");
    expect(command.payload).toMatchObject({
      ...enrollment,
      protocol: "massion.connector.v1",
      version: "1.0.0",
    });
    const capabilities = command.payload.capabilities as string[];
    expect(capabilities).toContain("agent-turn");
    expect(capabilities).toContain("openai-codex");
    expect(capabilities).toContainEqual(expect.stringMatching(/^massion\.workspace-root\.v1\.[A-Za-z0-9_-]{43}$/u));
    expect(JSON.stringify(capabilities)).not.toContain(workspaceRoot);
    expect(
      verify(
        null,
        createEnrollmentSignaturePayload(command.payload as never),
        createPublicKey(String(command.payload.publicKey)),
        Buffer.from(String(command.payload.signature), "base64url"),
      ),
    ).toBe(true);
    const connection = connectionPayload as { operation: string; payload: Record<string, unknown> };
    expect(connection.operation).toBe("subscription.account.register");
    expect(connection.payload).toMatchObject({
      providerId: "openai-codex",
      alias: "개인 Codex",
      connectorId: command.payload.connectorId,
      authKind: "cli-profile",
      billingKind: "consumer-subscription",
    });
    expect(String(connection.payload.profileLocator)).toMatch(/^edge-profile:[a-f0-9]{64}$/u);
    expect(connection.payload.profileLocator).not.toBe(profileRoot);
    const saved = await readFile(identityPath, "utf8");
    expect(saved).not.toContain("owner-secret-token");
    expect(saved).not.toContain("one-time-code-secret");
  });

  it("신규 만료 enrollment와 알 수 없는 필드는 네트워크 전송 전에 거부한다", async () => {
    const fixture = await fixtureDirectory("massion-connector-expired-");
    cleanups.push(fixture.cleanup);
    const tokenPath = join(fixture.path, "application.token");
    const profileRoot = join(fixture.path, "profile");
    const workspaceRoot = join(fixture.path, "workspace");
    await writeFile(tokenPath, "owner-secret-token\n", { mode: 0o600 });
    await mkdir(profileRoot, { mode: 0o700 });
    await mkdir(workspaceRoot, { mode: 0o700 });
    const fetcher = vi.fn<typeof fetch>();
    const healthProbe = { verify: vi.fn(async () => ({ authKind: "cli-profile" as const })) };

    await expect(
      enrollEdgeConnector({
        baseUrl: "https://massion.example",
        tokenFile: tokenPath,
        identityFile: join(fixture.path, "identity.json"),
        enrollment: {
          enrollmentId: "enrollment-12345678",
          enrollmentCode: "one-time-code-secret",
          challengeNonce: "challenge-nonce-12345678",
          expiresAt: new Date(Date.now() - 1).toISOString(),
        },
        providerId: "openai-codex",
        alias: "개인 Codex",
        authKind: "cli-profile",
        billingKind: "consumer-subscription",
        profileRoot,
        workspaceRoots: [workspaceRoot],
        fetcher,
        healthProbe,
      }),
    ).rejects.toThrow(/만료/u);
    expect(healthProbe.verify).not.toHaveBeenCalled();
    await expect(
      enrollEdgeConnector({
        baseUrl: "https://massion.example",
        tokenFile: tokenPath,
        identityFile: join(fixture.path, "unknown-identity.json"),
        enrollment: {
          enrollmentId: "enrollment-12345678",
          enrollmentCode: "one-time-code-secret",
          challengeNonce: "challenge-nonce-12345678",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          unexpected: "rejected",
        },
        providerId: "openai-codex",
        alias: "개인 Codex",
        authKind: "cli-profile",
        billingKind: "consumer-subscription",
        profileRoot,
        workspaceRoots: [workspaceRoot],
        fetcher,
        healthProbe,
      }),
    ).rejects.toThrow(/알 수 없는 필드/u);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("실제 Provider profile 인증 health가 실패하면 Connector를 ready로 등록하지 않는다", async () => {
    const fixture = await fixtureDirectory("massion-connector-health-");
    cleanups.push(fixture.cleanup);
    const tokenPath = join(fixture.path, "application.token");
    const profileRoot = join(fixture.path, "profile");
    const workspaceRoot = join(fixture.path, "workspace");
    await writeFile(tokenPath, "owner-secret-token\n", { mode: 0o600 });
    await mkdir(profileRoot, { mode: 0o700 });
    await mkdir(workspaceRoot, { mode: 0o700 });
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      enrollEdgeConnector({
        baseUrl: "https://massion.example",
        tokenFile: tokenPath,
        identityFile: join(fixture.path, "identity.json"),
        enrollment: {
          enrollmentId: "enrollment-12345678",
          enrollmentCode: "one-time-code-secret",
          challengeNonce: "challenge-nonce-12345678",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        providerId: "anthropic-claude-code",
        alias: "개인 Claude",
        authKind: "cli-profile",
        billingKind: "consumer-subscription",
        profileRoot,
        workspaceRoots: [workspaceRoot],
        fetcher,
        healthProbe: { verify: () => Promise.reject(new ProviderReauthenticationRequiredError()) },
      }),
    ).rejects.toMatchObject({ code: "needs-reauth" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("외부 ACP Provider는 명시적 실행 파일을 먼저 증명하고 동일 계보로 profile health를 확인한다", async () => {
    const fixture = await fixtureDirectory("massion-connector-external-health-");
    cleanups.push(fixture.cleanup);
    const tokenPath = join(fixture.path, "application.token");
    const profileRoot = join(fixture.path, "profile");
    const workspaceRoot = join(fixture.path, "workspace");
    const executable = join(fixture.path, "grok");
    await writeFile(tokenPath, "owner-secret-token\n", { mode: 0o600 });
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await mkdir(profileRoot, { mode: 0o700 });
    await mkdir(workspaceRoot, { mode: 0o700 });
    const runtimeArtifact = { executable, digest: "a".repeat(64), version: "1.2.3" };
    const attestRuntime = vi.fn(async () => runtimeArtifact);
    const healthProbe = { verify: vi.fn(() => Promise.reject(new ProviderReauthenticationRequiredError())) };
    const fetcher = vi.fn<typeof fetch>();

    await expect(
      enrollEdgeConnector({
        baseUrl: "https://massion.example",
        tokenFile: tokenPath,
        identityFile: join(fixture.path, "identity.json"),
        enrollment: {
          enrollmentId: "enrollment-12345678",
          enrollmentCode: "one-time-code-secret",
          challengeNonce: "challenge-nonce-12345678",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        providerId: "xai-grok-build",
        alias: "개인 Grok Build",
        authKind: "cli-profile",
        billingKind: "consumer-subscription",
        profileRoot,
        workspaceRoots: [workspaceRoot],
        runtimeExecutable: executable,
        acceptExperimental: true,
        attestRuntime,
        healthProbe,
        fetcher,
      }),
    ).rejects.toMatchObject({ code: "needs-reauth" });

    expect(attestRuntime).toHaveBeenCalledWith({ providerId: "xai-grok-build", executable });
    expect(healthProbe.verify).toHaveBeenCalledWith({
      providerId: "xai-grok-build",
      profileRoot,
      expectedAuthKind: "cli-profile",
      billingKind: "consumer-subscription",
      runtimeArtifact,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("계정 연결 응답이 끊긴 pending은 enrollment 만료 뒤에도 동일 payload로 재개하고 초기 offline을 허용한다", async () => {
    const fixture = await fixtureDirectory("massion-connector-replay-");
    cleanups.push(fixture.cleanup);
    const tokenPath = join(fixture.path, "application.token");
    const identityPath = join(fixture.path, "identity.json");
    const profileRoot = join(fixture.path, "profile");
    const workspaceRoot = join(fixture.path, "workspace");
    await writeFile(tokenPath, "owner-secret-token\n", { mode: 0o600 });
    await mkdir(profileRoot, { mode: 0o700 });
    await mkdir(workspaceRoot, { mode: 0o700 });
    let now = new Date("2030-01-01T00:00:00.000Z");
    const enrollment = {
      enrollmentId: "enrollment-replay-12345678",
      enrollmentCode: "one-time-code-secret",
      challengeNonce: "challenge-nonce-replay-12345678",
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    };
    const commands: Array<Record<string, unknown>> = [];
    let failAccount = true;
    const fetcher: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname === "/api/v1/me") {
        return Response.json({
          data: {
            userId: "user-owner-12345678",
            organizationId: "organization-12345678",
            membershipId: "membership-12345678",
            role: "owner",
          },
        });
      }
      const command = JSON.parse(String(init?.body)) as Record<string, unknown>;
      commands.push(command);
      const payload = command.payload as Record<string, unknown>;
      if (command.operation === "subscription.account.register") {
        if (failAccount) {
          failAccount = false;
          throw new Error("raw socket failure Bearer secret");
        }
        return Response.json({
          outcome: "succeeded",
          data: {
            accountId: "account-replay-12345678",
            providerId: "openai-codex",
            alias: "개인 Codex",
            scope: "personal",
            connectorId: payload.connectorId,
            billingKind: "consumer-subscription",
            status: "offline",
            version: 1,
          },
        });
      }
      return Response.json({ outcome: "succeeded", data: { connectorId: payload.connectorId } });
    };
    const options = {
      baseUrl: "https://massion.example",
      tokenFile: tokenPath,
      identityFile: identityPath,
      enrollment,
      providerId: "openai-codex" as const,
      alias: "개인 Codex",
      authKind: "cli-profile" as const,
      billingKind: "consumer-subscription" as const,
      profileRoot,
      workspaceRoots: [workspaceRoot],
      fetcher,
      healthProbe: { verify: async () => ({ authKind: "cli-profile" as const }) },
      now: () => now,
    };
    await expect(enrollEdgeConnector(options)).rejects.toThrow(/연결 요청/u);
    now = new Date("2030-01-01T00:02:00.000Z");
    const commandsBeforeMismatch = commands.length;
    await expect(
      enrollEdgeConnector({
        ...options,
        enrollment: { ...enrollment, challengeNonce: "changed-challenge-nonce-12345678" },
      }),
    ).rejects.toThrow(/pending|일치/u);
    expect(commands).toHaveLength(commandsBeforeMismatch);
    await expect(enrollEdgeConnector(options)).resolves.toMatchObject({
      account: { accountId: "account-replay-12345678", status: "offline" },
    });

    const enrollmentCommands = commands.filter((command) => command.operation === "subscription.connector.enroll");
    const accountCommands = commands.filter((command) => command.operation === "subscription.account.register");
    expect(enrollmentCommands).toHaveLength(2);
    expect(accountCommands).toHaveLength(2);
    expect(enrollmentCommands[0]?.commandId).toBe(enrollmentCommands[1]?.commandId);
    expect(enrollmentCommands[0]?.payload).toEqual(enrollmentCommands[1]?.payload);
    expect(accountCommands[0]?.commandId).toBe(accountCommands[1]?.commandId);
    expect(accountCommands[0]?.payload).toEqual(accountCommands[1]?.payload);
  });

  it("HTTP timeout과 외부 중단 signal을 health와 fetch에 전달해 무기한 대기를 막는다", async () => {
    const fixture = await fixtureDirectory("massion-connector-timeout-");
    cleanups.push(fixture.cleanup);
    const tokenPath = join(fixture.path, "application.token");
    const profileRoot = join(fixture.path, "profile");
    const workspaceRoot = join(fixture.path, "workspace");
    await writeFile(tokenPath, "owner-secret-token\n", { mode: 0o600 });
    await mkdir(profileRoot, { mode: 0o700 });
    await mkdir(workspaceRoot, { mode: 0o700 });
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(new Error("raw transport secret")), { once: true });
      });
    });
    const healthProbe = { verify: vi.fn(async () => ({ authKind: "cli-profile" as const })) };

    const result = enrollEdgeConnector({
      baseUrl: "https://massion.example",
      tokenFile: tokenPath,
      identityFile: join(fixture.path, "identity.json"),
      enrollment: {
        enrollmentId: "enrollment-timeout-12345678",
        enrollmentCode: "one-time-code-secret",
        challengeNonce: "challenge-nonce-timeout-12345678",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      providerId: "openai-codex",
      alias: "개인 Codex",
      authKind: "cli-profile",
      billingKind: "consumer-subscription",
      profileRoot,
      workspaceRoots: [workspaceRoot],
      fetcher,
      healthProbe,
      signal: controller.signal,
      requestTimeoutMs: 20,
    });

    let failure: unknown;
    try {
      await result;
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/현재 사용자 조회 요청/u);
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(String((failure as Error).message)).not.toContain("raw transport secret");
    expect(requestSignal?.aborted).toBe(true);
    expect(healthProbe.verify).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
  });
});
