import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BundledCodexSubscriptionObserver,
  CodexSubscriptionObservationError,
  decodeCodexRateLimitWindows,
  selectCodexGpt56Model,
} from "./codex-subscription-observer.js";
import { prepareSubscriptionProfileRoot } from "./subscription-profile.js";

describe("Codex 소비자 구독 관측", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
  });

  it("account/rateLimits/read의 다중 bucket 사용률을 독립된 남은 할당량 window로 변환한다", () => {
    const windows = decodeCodexRateLimitWindows(
      {
        rateLimits: {
          limitId: "legacy",
          limitName: null,
          primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: 1_783_900_800 },
          secondary: null,
          credits: null,
          individualLimit: null,
          planType: "plus",
          rateLimitReachedType: null,
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            limitName: "Codex",
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_783_900_800 },
            secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_784_505_600 },
            credits: null,
            individualLimit: null,
            planType: "plus",
            rateLimitReachedType: null,
          },
        },
        rateLimitResetCredits: null,
      },
      new Date("2026-07-12T00:00:00.000Z"),
    );

    expect(windows).toEqual([
      {
        kind: "codex:codex:primary",
        remainingRatio: 0.75,
        resetsAt: "2026-07-13T00:00:00.000Z",
        observedAt: "2026-07-12T00:00:00.000Z",
        source: "codex-app-server:account/rateLimits/read",
        confidence: "reported",
      },
      {
        kind: "codex:codex:secondary",
        remainingRatio: 0.6,
        resetsAt: "2026-07-20T00:00:00.000Z",
        observedAt: "2026-07-12T00:00:00.000Z",
        source: "codex-app-server:account/rateLimits/read",
        confidence: "reported",
      },
    ]);
  });

  it("다중 bucket이 없으면 하위 호환 단일 bucket을 사용하고 유효하지 않은 비율은 닫힌 실패로 거부한다", () => {
    expect(
      decodeCodexRateLimitWindows(
        {
          rateLimits: {
            limitId: null,
            primary: { usedPercent: 10, windowDurationMins: null, resetsAt: null },
            secondary: null,
          },
          rateLimitsByLimitId: null,
        },
        new Date("2026-07-12T00:00:00.000Z"),
      ),
    ).toEqual([expect.objectContaining({ kind: "codex:default:primary", remainingRatio: 0.9 })]);

    expect(() =>
      decodeCodexRateLimitWindows({
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 101, windowDurationMins: 300, resetsAt: null },
          secondary: null,
        },
        rateLimitsByLimitId: null,
      }),
    ).toThrow(CodexSubscriptionObservationError);
  });

  it("서버가 할당량 도달을 판정하면 낮은 사용률보다 우선해 소진으로 기록한다", () => {
    expect(
      decodeCodexRateLimitWindows(
        {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_783_900_800 },
            secondary: null,
            credits: { hasCredits: false, unlimited: false, balance: "0" },
            individualLimit: { limit: "100", used: "20", remainingPercent: 80, resetsAt: 1_783_900_800 },
            rateLimitReachedType: "workspace_member_credits_depleted",
          },
          rateLimitsByLimitId: null,
        },
        new Date("2026-07-12T00:00:00.000Z"),
      ),
    ).toEqual([
      expect.objectContaining({ kind: "codex:codex:credits", remainingRatio: 0 }),
      expect.objectContaining({ kind: "codex:codex:individual", remainingRatio: 0.8 }),
      expect.objectContaining({ kind: "codex:codex:primary", remainingRatio: 0.8 }),
    ]);
  });

  it("개인 사용 한도와 credit 소진을 독립 window로 보존하고 알 수 없는 도달 유형은 거부한다", () => {
    expect(
      decodeCodexRateLimitWindows(
        {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null },
            secondary: null,
            credits: { hasCredits: false, unlimited: false, balance: null },
            individualLimit: { limit: "100", used: "75", remainingPercent: 25, resetsAt: 1_783_900_800 },
            rateLimitReachedType: null,
          },
          rateLimitsByLimitId: null,
        },
        new Date("2026-07-12T00:00:00.000Z"),
      ),
    ).toEqual([
      expect.objectContaining({ kind: "codex:codex:credits", remainingRatio: 0 }),
      expect.objectContaining({
        kind: "codex:codex:individual",
        remainingRatio: 0.25,
        resetsAt: "2026-07-13T00:00:00.000Z",
      }),
      expect.objectContaining({ kind: "codex:codex:primary", remainingRatio: 0.9 }),
    ]);

    expect(() =>
      decodeCodexRateLimitWindows({
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null },
          secondary: null,
          credits: null,
          individualLimit: null,
          rateLimitReachedType: "unknown_reached_state",
        },
        rateLimitsByLimitId: null,
      }),
    ).toThrow(CodexSubscriptionObservationError);
  });

  it("고정된 bundled Codex artifact와 계정별 0700 profile에서 유료 계정과 할당량을 한 세션으로 확인한다", async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), "massion-codex-observer-"));
    cleanups.push(async () => await rm(profileRoot, { recursive: true, force: true }));
    const inspectRuntime = vi.fn().mockResolvedValue({
      runtimeId: "codex",
      version: "0.144.1",
      runtimeArtifactDigest: "a".repeat(64),
      command: process.execPath,
      commandArguments: ["/bundled/codex.js"],
    });
    const observe = vi.fn().mockResolvedValue({
      account: { account: { type: "chatgpt", planType: "plus" }, requiresOpenaiAuth: true },
      rateLimits: {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: null },
          secondary: null,
        },
        rateLimitsByLimitId: null,
      },
    });
    const observer = new BundledCodexSubscriptionObserver({
      profileRoot,
      inspectRuntime,
      observe,
      now: () => new Date("2026-07-12T00:00:00.000Z"),
    });

    await expect(
      observer.readQuota({
        organizationId: "organization-12345678",
        accountId: "account-12345678",
      }),
    ).resolves.toEqual([expect.objectContaining({ kind: "codex:codex:primary", remainingRatio: 0.8 })]);

    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeId: "codex", runtimeArtifactDigest: "a".repeat(64) }),
      expect.objectContaining({
        CODEX_HOME: expect.stringMatching(/^[^\0]+$/u),
        HOME: expect.stringMatching(/^[^\0]+$/u),
        NO_COLOR: "1",
      }),
    );
    const environment = vi.mocked(observe).mock.calls[0]?.[1];
    expect(environment?.CODEX_HOME).toBe(environment?.HOME);
    expect(environment?.CODEX_HOME).not.toContain("organization-12345678");
    expect(environment?.CODEX_HOME).not.toContain("account-12345678");
  });

  it.each(["free", "unknown", undefined])("planType=%s 계정은 할당량을 신뢰하지 않는다", async (planType) => {
    const profileRoot = await mkdtemp(join(tmpdir(), "massion-codex-observer-plan-"));
    cleanups.push(async () => await rm(profileRoot, { recursive: true, force: true }));
    const observer = new BundledCodexSubscriptionObserver({
      profileRoot,
      inspectRuntime: vi.fn().mockResolvedValue({
        runtimeId: "codex",
        version: "0.144.1",
        runtimeArtifactDigest: "b".repeat(64),
        command: process.execPath,
        commandArguments: ["/bundled/codex.js"],
      }),
      observe: vi.fn().mockResolvedValue({
        account: {
          account: { type: "chatgpt", ...(planType === undefined ? {} : { planType }) },
          requiresOpenaiAuth: true,
        },
        rateLimits: {},
      }),
    });

    await expect(
      observer.readQuota({ organizationId: "organization-12345678", accountId: "account-12345678" }),
    ).rejects.toMatchObject({ category: "authentication" });
  });

  it("model/list 실제 결과에서는 isDefault를 먼저 선택하고, 기본값이 없으면 Sol→alias→Terra→Luna 순서를 쓴다", () => {
    const model = (id: string, isDefault = false) => ({
      id,
      model: id,
      displayName: id,
      description: `${id} description`,
      hidden: false,
      inputModalities: ["text", "image"],
      isDefault,
    });

    expect(selectCodexGpt56Model([model("gpt-5.6-sol"), model("gpt-5.6-terra", true)])).toMatchObject({
      modelId: "gpt-5.6-terra",
      isDefault: true,
    });
    expect(selectCodexGpt56Model([model("gpt-5.6-luna"), model("gpt-5.6"), model("gpt-5.6-sol")])).toMatchObject({
      modelId: "gpt-5.6-sol",
    });
    expect(selectCodexGpt56Model([model("gpt-5.6-sol"), model("gpt-5.6-luna")], "gpt-5.6-luna")).toMatchObject({
      modelId: "gpt-5.6-luna",
    });
    expect(() => selectCodexGpt56Model([model("gpt-5.6-sol")], "gpt-5.6-terra")).toThrow(/사용|model/iu);
  });

  it("계정별 model/list 관측 결과와 bundled artifact digest를 선택 근거로 반환한다", async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), "massion-codex-observer-model-"));
    cleanups.push(async () => await rm(profileRoot, { recursive: true, force: true }));
    const listModels = vi.fn().mockResolvedValue({
      account: { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: true },
      models: [
        {
          id: "gpt-5.6-sol",
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
          description: "GPT-5.6 Sol",
          hidden: false,
          inputModalities: ["text", "image"],
          isDefault: true,
        },
      ],
    });
    const observer = new BundledCodexSubscriptionObserver({
      profileRoot,
      inspectRuntime: vi.fn().mockResolvedValue({
        runtimeId: "codex",
        version: "0.144.1",
        runtimeArtifactDigest: "c".repeat(64),
        command: process.execPath,
        commandArguments: ["/bundled/codex.js"],
      }),
      observe: vi.fn(),
      listModels,
      now: () => new Date("2026-07-12T00:00:00.000Z"),
    });

    await expect(
      observer.readModel({
        organizationId: "organization-12345678",
        accountId: "account-12345678",
      }),
    ).resolves.toEqual({
      modelId: "gpt-5.6-sol",
      catalogId: "gpt-5.6-sol",
      hidden: false,
      isDefault: true,
      inputModalities: ["text", "image"],
      observedAt: "2026-07-12T00:00:00.000Z",
      runtimeVersion: "0.144.1",
      runtimeArtifactDigest: "c".repeat(64),
    });
    expect(listModels).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeId: "codex" }),
      expect.objectContaining({ CODEX_HOME: expect.any(String) }),
    );
  });

  it("기존 계정 profile에서 app-server account/logout을 호출하고 없는 profile은 새로 만들지 않는다", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "massion-codex-logout-"));
    cleanups.push(async () => await rm(temporaryRoot, { recursive: true, force: true }));
    const profileRoot = await realpath(temporaryRoot);
    const accountProfile = await prepareSubscriptionProfileRoot(
      profileRoot,
      "organization-logout-12345678",
      "account-logout-12345678",
    );
    await writeFile(join(accountProfile, "auth.json"), "private-login-state", { mode: 0o600 });
    const logout = vi.fn().mockResolvedValue(undefined);
    const observer = new BundledCodexSubscriptionObserver({
      profileRoot,
      inspectRuntime: vi.fn().mockResolvedValue({
        runtimeId: "codex",
        version: "0.144.1",
        runtimeArtifactDigest: "d".repeat(64),
        command: process.execPath,
        commandArguments: ["/bundled/codex.js"],
      }),
      logout,
    });

    await expect(
      observer.logout({ organizationId: "organization-logout-12345678", accountId: "account-logout-12345678" }),
    ).resolves.toBe(true);
    await expect(
      observer.logout({ organizationId: "organization-logout-12345678", accountId: "account-missing-12345678" }),
    ).resolves.toBe(false);
    expect(logout).toHaveBeenCalledOnce();
    expect(logout).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeId: "codex" }),
      expect.objectContaining({ CODEX_HOME: accountProfile, HOME: accountProfile }),
    );
  });
});
