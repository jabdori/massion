import { delimiter, dirname } from "node:path";

import {
  codexFileCredentialStoreArguments,
  inspectBundledSubscriptionRuntime,
  managedCodexCredentialState,
  type BundledSubscriptionRuntimeArtifact,
} from "@massion/runtime";
import { isPaidCodexPlanType, type QuotaWindow } from "@massion/subscriptions";

import { withCodexAppServer } from "./codex-app-server.js";
import { existingSubscriptionProfileRoot, prepareSubscriptionProfileRoot } from "./subscription-profile.js";

type JsonRecord = Record<string, unknown>;
type CodexRateLimitReachedType =
  | "rate_limit_reached"
  | "workspace_owner_credits_depleted"
  | "workspace_member_credits_depleted"
  | "workspace_owner_usage_limit_reached"
  | "workspace_member_usage_limit_reached";

const CODEX_RATE_LIMIT_REACHED_TYPES = new Set<CodexRateLimitReachedType>([
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);

export type CodexSubscriptionObservationFailure = "authentication" | "subscription" | "runtime" | "schema" | "upstream";

export class CodexSubscriptionObservationError extends Error {
  public constructor(public readonly category: CodexSubscriptionObservationFailure) {
    super(
      category === "authentication"
        ? "Codex 유료 소비자 구독 인증을 갱신해야 합니다"
        : category === "subscription"
          ? "Codex 유료 소비자 구독을 확인할 수 없습니다"
          : category === "runtime"
            ? "Codex bundled runtime 계보를 확인할 수 없습니다"
            : category === "schema"
              ? "Codex 구독 관측 응답 형식을 확인할 수 없습니다"
              : "Codex app-server가 구독 관측 요청을 완료하지 못했습니다",
    );
    this.name = "CodexSubscriptionObservationError";
  }
}

export interface CodexSubscriptionObservation {
  readonly account: unknown;
  readonly rateLimits: unknown;
}

export interface CodexModelListObservation {
  readonly account: unknown;
  readonly models: readonly unknown[];
}

export type CodexSubscriptionModelList = (
  artifact: BundledSubscriptionRuntimeArtifact,
  environment: Readonly<Record<string, string>>,
) => Promise<CodexModelListObservation>;

export type CodexSubscriptionLogout = (
  artifact: BundledSubscriptionRuntimeArtifact,
  environment: Readonly<Record<string, string>>,
) => Promise<void>;

export const CODEX_GPT_56_MODEL_IDS = ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const;
export type CodexGpt56ModelId = (typeof CODEX_GPT_56_MODEL_IDS)[number];

export interface CodexGpt56ModelSelection {
  readonly modelId: CodexGpt56ModelId;
  readonly catalogId: string;
  readonly hidden: false;
  readonly isDefault: boolean;
  readonly inputModalities: readonly string[];
}

export interface ObservedCodexGpt56Model extends CodexGpt56ModelSelection {
  readonly observedAt: string;
  readonly runtimeVersion: string;
  readonly runtimeArtifactDigest: string;
}

export type CodexSubscriptionObserve = (
  artifact: BundledSubscriptionRuntimeArtifact,
  environment: Readonly<Record<string, string>>,
) => Promise<CodexSubscriptionObservation>;

export interface BundledCodexSubscriptionObserverOptions {
  readonly profileRoot: string;
  readonly inspectRuntime?: (runtimeId: "codex") => Promise<BundledSubscriptionRuntimeArtifact>;
  readonly observe?: CodexSubscriptionObserve;
  readonly listModels?: CodexSubscriptionModelList;
  readonly logout?: CodexSubscriptionLogout;
  readonly now?: () => Date;
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function safeLimitId(value: unknown, fallback: string): string {
  const selected = value === null || value === undefined ? fallback : value;
  if (typeof selected !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(selected)) {
    throw new CodexSubscriptionObservationError("schema");
  }
  return selected;
}

function resetAt(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new CodexSubscriptionObservationError("schema");
  const reset = new Date(Number(value) * 1_000);
  if (!Number.isFinite(reset.getTime())) throw new CodexSubscriptionObservationError("schema");
  return reset.toISOString();
}

function quotaWindow(
  value: unknown,
  limitId: string,
  role: "primary" | "secondary",
  observedAt: string,
  exhausted: boolean,
): QuotaWindow | undefined {
  if (value === null || value === undefined) return undefined;
  const window = record(value);
  if (!window) throw new CodexSubscriptionObservationError("schema");
  const usedPercent = window.usedPercent;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
    throw new CodexSubscriptionObservationError("schema");
  }
  const duration = window.windowDurationMins;
  if (duration !== null && duration !== undefined && (!Number.isSafeInteger(duration) || Number(duration) <= 0)) {
    throw new CodexSubscriptionObservationError("schema");
  }
  const resetsAt = resetAt(window.resetsAt);
  return {
    kind: `codex:${limitId}:${role}`,
    remainingRatio: exhausted ? 0 : (100 - usedPercent) / 100,
    ...(resetsAt === undefined ? {} : { resetsAt }),
    observedAt,
    source: "codex-app-server:account/rateLimits/read",
    confidence: "reported",
  };
}

function reachedType(snapshot: JsonRecord): CodexRateLimitReachedType | undefined {
  const value = snapshot.rateLimitReachedType;
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" || !CODEX_RATE_LIMIT_REACHED_TYPES.has(value as CodexRateLimitReachedType)) {
    throw new CodexSubscriptionObservationError("schema");
  }
  return value as CodexRateLimitReachedType;
}

function individualWindow(
  value: unknown,
  limitId: string,
  observedAt: string,
  exhausted: boolean,
): QuotaWindow | undefined {
  if (value === null || value === undefined) return undefined;
  const limit = record(value);
  if (!limit) throw new CodexSubscriptionObservationError("schema");
  if (
    typeof limit.limit !== "string" ||
    !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(limit.limit) ||
    typeof limit.used !== "string" ||
    !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(limit.used) ||
    typeof limit.remainingPercent !== "number" ||
    !Number.isFinite(limit.remainingPercent) ||
    limit.remainingPercent < 0 ||
    limit.remainingPercent > 100
  ) {
    throw new CodexSubscriptionObservationError("schema");
  }
  const resetsAt = resetAt(limit.resetsAt);
  return {
    kind: `codex:${limitId}:individual`,
    remainingRatio: exhausted ? 0 : limit.remainingPercent / 100,
    ...(resetsAt === undefined ? {} : { resetsAt }),
    observedAt,
    source: "codex-app-server:account/rateLimits/read",
    confidence: "reported",
  };
}

function creditsWindow(
  value: unknown,
  limitId: string,
  observedAt: string,
  exhausted: boolean,
): QuotaWindow | undefined {
  if (value === null || value === undefined) return undefined;
  const credits = record(value);
  if (
    !credits ||
    typeof credits.hasCredits !== "boolean" ||
    typeof credits.unlimited !== "boolean" ||
    (credits.balance !== null &&
      credits.balance !== undefined &&
      (typeof credits.balance !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(credits.balance)))
  ) {
    throw new CodexSubscriptionObservationError("schema");
  }
  // 추가 credit 잔액은 개인 구독의 기본 사용 창과 독립적입니다.
  // 제공자가 실제 credit 소진을 명시한 경우에만 route 차단 quota로 기록합니다.
  if (!exhausted) return undefined;
  return {
    kind: `codex:${limitId}:credits`,
    remainingRatio: 0,
    observedAt,
    source: "codex-app-server:account/rateLimits/read",
    confidence: "reported",
  };
}

function snapshots(value: JsonRecord): readonly { readonly id: string; readonly snapshot: JsonRecord }[] {
  const byLimitId = value.rateLimitsByLimitId;
  if (byLimitId !== null && byLimitId !== undefined) {
    const map = record(byLimitId);
    if (!map) throw new CodexSubscriptionObservationError("schema");
    const entries = Object.entries(map);
    if (entries.length > 0) {
      return entries.map(([key, raw]) => {
        const snapshot = record(raw);
        if (!snapshot) throw new CodexSubscriptionObservationError("schema");
        const id = safeLimitId(key, "default");
        if (snapshot.limitId !== null && snapshot.limitId !== undefined && snapshot.limitId !== id) {
          throw new CodexSubscriptionObservationError("schema");
        }
        return { id, snapshot };
      });
    }
  }
  const snapshot = record(value.rateLimits);
  if (!snapshot) throw new CodexSubscriptionObservationError("schema");
  return [{ id: safeLimitId(snapshot.limitId, "default"), snapshot }];
}

export function decodeCodexRateLimitWindows(value: unknown, now = new Date()): readonly QuotaWindow[] {
  if (!Number.isFinite(now.getTime())) throw new CodexSubscriptionObservationError("schema");
  const response = record(value);
  if (!response) throw new CodexSubscriptionObservationError("schema");
  const observedAt = now.toISOString();
  const windows = snapshots(response)
    .flatMap(({ id, snapshot }) => {
      const reached = reachedType(snapshot);
      const creditsReached = reached?.endsWith("credits_depleted") ?? false;
      const individualReached = reached?.endsWith("usage_limit_reached") ?? false;
      const rateLimitReached = reached === "rate_limit_reached";
      const selected = [
        quotaWindow(snapshot.primary, id, "primary", observedAt, rateLimitReached),
        quotaWindow(snapshot.secondary, id, "secondary", observedAt, rateLimitReached),
        creditsWindow(snapshot.credits, id, observedAt, creditsReached),
        individualWindow(snapshot.individualLimit, id, observedAt, individualReached),
      ];
      const reachedHasWindow =
        (rateLimitReached && (selected[0] !== undefined || selected[1] !== undefined)) ||
        (creditsReached && selected[2] !== undefined) ||
        (individualReached && selected[3] !== undefined);
      return reached && !reachedHasWindow
        ? [
            ...selected,
            {
              kind: `codex:${id}:reached`,
              remainingRatio: 0,
              observedAt,
              source: "codex-app-server:account/rateLimits/read",
              confidence: "reported" as const,
            },
          ]
        : selected;
    })
    .filter((window): window is QuotaWindow => window !== undefined)
    .sort((left, right) => left.kind.localeCompare(right.kind));
  if (windows.length === 0) throw new CodexSubscriptionObservationError("schema");
  const kinds = new Set(windows.map((window) => window.kind));
  if (kinds.size !== windows.length) throw new CodexSubscriptionObservationError("schema");
  return windows;
}

function verifyPaidAccount(value: unknown): void {
  const response = record(value);
  if (!response || typeof response.requiresOpenaiAuth !== "boolean") {
    throw new CodexSubscriptionObservationError("schema");
  }
  if (!response.requiresOpenaiAuth) {
    throw new CodexSubscriptionObservationError("subscription");
  }
  if (response.account === null) {
    throw new CodexSubscriptionObservationError("authentication");
  }
  const account = record(response.account);
  if (!account || typeof account.type !== "string") {
    throw new CodexSubscriptionObservationError("schema");
  }
  if (account.type !== "chatgpt") {
    throw new CodexSubscriptionObservationError("subscription");
  }
  if (typeof account.planType !== "string" || !isPaidCodexPlanType(account.planType)) {
    throw new CodexSubscriptionObservationError("subscription");
  }
}

function codexModelId(value: unknown): value is CodexGpt56ModelId {
  return typeof value === "string" && (CODEX_GPT_56_MODEL_IDS as readonly string[]).includes(value);
}

export function selectCodexGpt56Model(values: readonly unknown[], requestedModelId?: string): CodexGpt56ModelSelection {
  if (values.length > 4_096) throw new CodexSubscriptionObservationError("schema");
  const available = values.flatMap((value) => {
    const model = record(value);
    if (!model || !codexModelId(model.model)) return [];
    const modalities: unknown = model.inputModalities;
    if (
      typeof model.id !== "string" ||
      !model.id.trim() ||
      model.id.length > 256 ||
      model.hidden !== false ||
      typeof model.isDefault !== "boolean" ||
      !Array.isArray(modalities) ||
      (modalities as unknown[]).some(
        (modality) => typeof modality !== "string" || !modality || modality.length > 64 || /[\0\r\n]/u.test(modality),
      )
    ) {
      throw new CodexSubscriptionObservationError("schema");
    }
    return [
      {
        modelId: model.model,
        catalogId: model.id,
        hidden: false as const,
        isDefault: model.isDefault,
        inputModalities: (modalities as string[]).slice(),
      },
    ];
  });
  if (new Set(available.map((model) => model.modelId)).size !== available.length) {
    throw new CodexSubscriptionObservationError("schema");
  }
  if (requestedModelId !== undefined) {
    if (!codexModelId(requestedModelId)) throw new Error("요청한 GPT-5.6 model ID가 지원 범위에 없습니다");
    const requested = available.find((model) => model.modelId === requestedModelId);
    if (!requested) throw new Error("요청한 GPT-5.6 model은 현재 Codex 계정에서 사용할 수 없습니다");
    return requested;
  }
  const defaults = available.filter((model) => model.isDefault);
  if (defaults.length > 1) throw new CodexSubscriptionObservationError("schema");
  if (defaults[0]) return defaults[0];
  const priority: readonly CodexGpt56ModelId[] = ["gpt-5.6-sol", "gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"];
  for (const modelId of priority) {
    const selected = available.find((model) => model.modelId === modelId);
    if (selected) return selected;
  }
  throw new Error("현재 Codex 계정에서 사용할 수 있는 GPT-5.6 model이 없습니다");
}

function runtimePath(): string {
  return process.platform === "win32"
    ? dirname(process.execPath)
    : `${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin`;
}

async function defaultObserve(
  artifact: BundledSubscriptionRuntimeArtifact,
  environment: Readonly<Record<string, string>>,
): Promise<CodexSubscriptionObservation> {
  return await withCodexAppServer(
    artifact.command,
    codexFileCredentialStoreArguments(artifact.commandArguments),
    environment,
    async (session) => {
      const account = await session.request("account/read", { refreshToken: true });
      const rateLimits = await session.request("account/rateLimits/read", {});
      return { account, rateLimits };
    },
    { timeoutMs: 15_000, maximumOutputBytes: 256 * 1024 },
  );
}

async function defaultListModels(
  artifact: BundledSubscriptionRuntimeArtifact,
  environment: Readonly<Record<string, string>>,
): Promise<CodexModelListObservation> {
  return await withCodexAppServer(
    artifact.command,
    codexFileCredentialStoreArguments(artifact.commandArguments),
    environment,
    async (session) => {
      const account = await session.request("account/read", { refreshToken: true });
      const models: unknown[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < 32; pageIndex += 1) {
        const raw = await session.request("model/list", {
          limit: 100,
          includeHidden: false,
          ...(cursor === undefined ? {} : { cursor }),
        });
        const page = record(raw);
        const data: unknown = page?.data;
        if (!page || !Array.isArray(data)) throw new CodexSubscriptionObservationError("schema");
        models.push(...(data as unknown[]));
        if (models.length > 4_096) throw new CodexSubscriptionObservationError("schema");
        if (page.nextCursor === null) return { account, models };
        if (
          typeof page.nextCursor !== "string" ||
          !page.nextCursor ||
          page.nextCursor.length > 1_024 ||
          cursors.has(page.nextCursor)
        ) {
          throw new CodexSubscriptionObservationError("schema");
        }
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      throw new CodexSubscriptionObservationError("schema");
    },
    { timeoutMs: 15_000, maximumOutputBytes: 1024 * 1024 },
  );
}

async function defaultLogout(
  artifact: BundledSubscriptionRuntimeArtifact,
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  await withCodexAppServer(
    artifact.command,
    codexFileCredentialStoreArguments(artifact.commandArguments),
    environment,
    async (session) => {
      await session.request("account/logout");
    },
    { timeoutMs: 15_000, maximumOutputBytes: 256 * 1024 },
  );
}

function codexEnvironment(profileRoot: string): Readonly<Record<string, string>> {
  return {
    CODEX_HOME: profileRoot,
    HOME: profileRoot,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
    PATH: runtimePath(),
  };
}

export class BundledCodexSubscriptionObserver {
  private readonly inspectRuntime: NonNullable<BundledCodexSubscriptionObserverOptions["inspectRuntime"]>;
  private readonly observe: CodexSubscriptionObserve;
  private readonly listModels: CodexSubscriptionModelList;
  private readonly logoutAccount: CodexSubscriptionLogout;
  private readonly now: () => Date;
  private artifactPromise: Promise<BundledSubscriptionRuntimeArtifact> | undefined;

  public constructor(private readonly options: BundledCodexSubscriptionObserverOptions) {
    this.inspectRuntime = options.inspectRuntime ?? inspectBundledSubscriptionRuntime;
    this.observe = options.observe ?? defaultObserve;
    this.listModels = options.listModels ?? defaultListModels;
    this.logoutAccount = options.logout ?? defaultLogout;
    this.now = options.now ?? (() => new Date());
  }

  public async readQuota(input: {
    readonly organizationId: string;
    readonly accountId: string;
  }): Promise<readonly QuotaWindow[]> {
    const profileRoot = await prepareSubscriptionProfileRoot(
      this.options.profileRoot,
      input.organizationId,
      input.accountId,
    );
    await this.requireAuthenticatedProfile(profileRoot);
    const artifact = await this.artifact();
    let observation: CodexSubscriptionObservation;
    try {
      observation = await this.observe(artifact, codexEnvironment(profileRoot));
    } catch (error) {
      if (error instanceof CodexSubscriptionObservationError) throw error;
      throw new CodexSubscriptionObservationError("upstream");
    }
    verifyPaidAccount(observation.account);
    return decodeCodexRateLimitWindows(observation.rateLimits, this.now());
  }

  public async readModel(input: {
    readonly organizationId: string;
    readonly accountId: string;
    readonly requestedModelId?: string;
  }): Promise<ObservedCodexGpt56Model> {
    const profileRoot = await prepareSubscriptionProfileRoot(
      this.options.profileRoot,
      input.organizationId,
      input.accountId,
    );
    await this.requireAuthenticatedProfile(profileRoot);
    const artifact = await this.artifact();
    let observation: CodexModelListObservation;
    try {
      observation = await this.listModels(artifact, codexEnvironment(profileRoot));
    } catch (error) {
      if (error instanceof CodexSubscriptionObservationError) throw error;
      throw new CodexSubscriptionObservationError("upstream");
    }
    verifyPaidAccount(observation.account);
    const selected = selectCodexGpt56Model(observation.models, input.requestedModelId);
    const now = this.now();
    if (!Number.isFinite(now.getTime())) throw new CodexSubscriptionObservationError("schema");
    return {
      ...selected,
      observedAt: now.toISOString(),
      runtimeVersion: artifact.version,
      runtimeArtifactDigest: artifact.runtimeArtifactDigest,
    };
  }

  public async logout(input: { readonly organizationId: string; readonly accountId: string }): Promise<boolean> {
    const profileRoot = await existingSubscriptionProfileRoot(
      this.options.profileRoot,
      input.organizationId,
      input.accountId,
    );
    if (!profileRoot) return false;
    try {
      if ((await managedCodexCredentialState(profileRoot)) !== "present") return false;
    } catch {
      // 안전하지 않은 profile에는 원격 logout을 시도하지 않습니다.
      return false;
    }
    const artifact = await this.artifact();
    try {
      await this.logoutAccount(artifact, codexEnvironment(profileRoot));
      return true;
    } catch (error) {
      if (error instanceof CodexSubscriptionObservationError) throw error;
      throw new CodexSubscriptionObservationError("upstream");
    }
  }

  private async artifact(): Promise<BundledSubscriptionRuntimeArtifact> {
    const existing = this.artifactPromise;
    if (existing) return await existing;
    const inspected = this.inspectRuntime("codex").then((artifact) => {
      if (
        artifact.runtimeId !== "codex" ||
        !artifact.version.trim() ||
        !/^[a-f0-9]{64}$/u.test(artifact.runtimeArtifactDigest) ||
        !artifact.command.trim()
      ) {
        throw new CodexSubscriptionObservationError("runtime");
      }
      return artifact;
    });
    this.artifactPromise = inspected;
    try {
      return await inspected;
    } catch (error) {
      if (this.artifactPromise === inspected) this.artifactPromise = undefined;
      if (error instanceof CodexSubscriptionObservationError) throw error;
      throw new CodexSubscriptionObservationError("runtime");
    }
  }

  private async requireAuthenticatedProfile(profileRoot: string): Promise<void> {
    try {
      if ((await managedCodexCredentialState(profileRoot)) === "missing") {
        throw new CodexSubscriptionObservationError("authentication");
      }
    } catch (error) {
      if (error instanceof CodexSubscriptionObservationError) throw error;
      throw new CodexSubscriptionObservationError("runtime");
    }
  }
}
