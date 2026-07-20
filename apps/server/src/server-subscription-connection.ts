import { createHash } from "node:crypto";

import type {
  ConnectedSubscription,
  ConnectModelSubscriptionInput,
  DisconnectedSubscription,
  DisconnectSubscriptionInput,
  SubscriptionConnectionService,
} from "@massion/application";
import type { TenantContext } from "@massion/identity";
import type {
  ServerConnectorProvisioningService,
  ServerConnectorView,
  SubscriptionAccountService,
  SubscriptionAuthKind,
  SubscriptionConnector,
} from "@massion/subscriptions";
import {
  codingPlanPreset,
  ServerConnectorAuthenticationRequiredError,
  ServerConnectorPaidSubscriptionRequiredError,
  ServerConnectorQuotaObservationUnavailableError,
} from "@massion/subscriptions";

import {
  existingSubscriptionProfileRoot,
  forgetSubscriptionProfileRoot,
  subscriptionProfileHandle,
} from "./subscription-profile.js";
import type { AssembledBuiltinModelRoutes, BuiltinModelRouteAssembler } from "./server-model-route-assembler.js";
import {
  CodexSubscriptionObservationError,
  type BundledCodexSubscriptionObserver,
} from "./codex-subscription-observer.js";
import type { MiniMaxSubscriptionVerifier } from "./minimax-subscription-verifier.js";
import type { SubscriptionQuotaSynchronizationService } from "./subscription-quota-sync.js";
import type { ZaiCodingPlanSubscriptionVerifier } from "./zai-coding-plan-subscription-verifier.js";

export interface PrepareServerSubscriptionInput {
  readonly commandId: string;
  readonly providerId: string;
  readonly alias: string;
  readonly authKind: SubscriptionAuthKind;
  readonly billingKind: string;
  readonly priority?: number;
  readonly weight?: number;
}

export interface PreparedServerSubscription extends ConnectedSubscription {
  readonly connector: ServerConnectorView;
  readonly profileHandle: string;
}

export type AttestedServerSubscription = ServerConnectorView & {
  readonly modelRuntime?: AssembledBuiltinModelRoutes;
  /** 이번 health command가 직접 완료한 Codex quota 관측의 공개 증거입니다. */
  readonly quotaObservation?: {
    readonly source: "direct";
    readonly attestedAt: string;
  };
};

export type ConnectServerModelSubscriptionInput = Omit<ConnectModelSubscriptionInput, "connectorId" | "profileLocator">;

export interface ConnectedServerModelSubscription extends ConnectedSubscription {
  readonly connector: ServerConnectorView;
  readonly modelRuntime: AssembledBuiltinModelRoutes;
}

export interface ServerSubscriptionLifecycleOptions {
  readonly profileRoot: string;
  readonly connectors: {
    get(context: TenantContext, connectorId: string): Promise<SubscriptionConnector>;
  };
  readonly logout: (
    providerId: string,
    input: {
      readonly organizationId: string;
      readonly accountId: string;
      readonly profileRoot: string;
    },
  ) => Promise<void>;
}

interface ServerRuntimeContract {
  readonly runtimeId: "codex" | "claude";
  readonly authKinds: ReadonlySet<SubscriptionAuthKind>;
}

const SERVER_RUNTIMES: Readonly<Record<string, ServerRuntimeContract>> = {
  "openai-codex": { runtimeId: "codex", authKinds: new Set(["device-code", "cli-profile"]) },
  "anthropic-claude-code": { runtimeId: "claude", authKinds: new Set(["cli-profile"]) },
};

function connectorId(context: TenantContext, input: PrepareServerSubscriptionInput): string {
  const digest = createHash("sha256")
    .update("massion-server-connector-v1\0")
    .update(context.organizationId)
    .update("\0")
    .update(context.userId)
    .update("\0")
    .update(input.commandId)
    .update("\0")
    .update(input.providerId)
    .digest("hex");
  return `server-${digest.slice(0, 40)}`;
}

type ServerModelRuntime =
  | {
      readonly runtimeId: "openai-model";
      readonly endpointUrl: string;
      readonly protocol: "openai";
      readonly requiredModelId: "MiniMax-M2.7";
      readonly verifier: "minimax";
    }
  | {
      readonly runtimeId: "openai-model";
      readonly endpointUrl: string;
      readonly protocol: "openai";
      readonly requiredModelId: "glm-5.2";
      readonly verifier: "zai-coding-plan";
    };

function modelRuntime(input: ConnectServerModelSubscriptionInput): ServerModelRuntime {
  const preset = codingPlanPreset(input.providerId);
  if (preset.availability === "requires-provider-approval") {
    throw new Error("이 구독 Provider는 공식 제공자 승인이 확인된 뒤에만 연결할 수 있습니다");
  }
  if (preset.usageScope === "interactive-coding") {
    throw new Error("대화형 코딩 전용 model plan은 서버 내장 direct model runtime에서 지원하지 않습니다");
  }
  if (input.providerId === "minimax-token-plan") {
    if (input.authKind !== "subscription-key" || !preset.authKinds.includes(input.authKind)) {
      throw new Error("MiniMax Token Plan 구독 키 인증 방식이 유효하지 않습니다");
    }
    if (input.billingKind !== "token-plan" || !preset.billingKinds.includes(input.billingKind)) {
      throw new Error("현재 서버 내장 MiniMax 연결은 Token Plan 결제 유형만 지원합니다");
    }
    const route = preset.routes.find(
      (candidate) => candidate.protocol === "openai" && candidate.baseUrl === "https://api.minimax.io/v1",
    );
    if (
      !route ||
      (input.protocol !== undefined && input.protocol !== "openai") ||
      (input.endpointUrl !== undefined && input.endpointUrl !== route.baseUrl)
    ) {
      throw new Error("MiniMax 서버 연결은 공식 OpenAI 호환 openai-model 경로만 지원합니다");
    }
    return {
      runtimeId: "openai-model",
      endpointUrl: route.baseUrl,
      protocol: "openai",
      requiredModelId: "MiniMax-M2.7",
      verifier: "minimax",
    };
  }
  if (input.providerId === "zai-coding-plan") {
    if (input.authKind !== "api-key" || !preset.authKinds.includes(input.authKind)) {
      throw new Error("Z.AI Coding Plan API key 인증 방식이 유효하지 않습니다");
    }
    if (input.billingKind !== "coding-plan" || !preset.billingKinds.includes(input.billingKind)) {
      throw new Error("Z.AI Coding Plan 연결은 Coding Plan 결제 유형만 지원합니다");
    }
    const route = preset.routes.find(
      (candidate) => candidate.protocol === "openai" && candidate.baseUrl === "https://api.z.ai/api/coding/paas/v4",
    );
    if (
      !route ||
      (input.protocol !== undefined && input.protocol !== "openai") ||
      (input.endpointUrl !== undefined && input.endpointUrl !== route.baseUrl)
    ) {
      throw new Error("Z.AI 서버 연결은 공식 OpenAI 호환 Coding Plan 경로만 지원합니다");
    }
    return {
      runtimeId: "openai-model",
      endpointUrl: route.baseUrl,
      protocol: "openai",
      requiredModelId: "glm-5.2",
      verifier: "zai-coding-plan",
    };
  }
  throw new Error("현재 서버 내장 direct model runtime은 MiniMax Token Plan 또는 Z.AI Coding Plan만 지원합니다");
}

function modelSecret(value: string): string {
  if (!value.trim() || Buffer.byteLength(value, "utf8") > 16 * 1024 || /[\0\r\n]/u.test(value)) {
    throw new Error("구독 Credential secret이 유효하지 않습니다");
  }
  return value;
}

export class ServerSubscriptionConnectionService {
  public constructor(
    private readonly connectors: Pick<
      ServerConnectorProvisioningService,
      "provision" | "attestHealth" | "markOffline" | "markReauthenticationRequired" | "revoke"
    >,
    private readonly connections: Pick<SubscriptionConnectionService, "connect" | "connectModel" | "disconnect">,
    private readonly accounts?: Pick<SubscriptionAccountService, "requireBindable" | "requireUsable">,
    private readonly modelRoutes?: Pick<BuiltinModelRouteAssembler, "assemble" | "assembleCodex">,
    private readonly codexObserver?: Pick<BundledCodexSubscriptionObserver, "readModel">,
    private readonly lifecycle?: ServerSubscriptionLifecycleOptions,
    private readonly miniMaxVerifier?: Pick<MiniMaxSubscriptionVerifier, "verify">,
    private readonly codexQuotaSynchronization?: Pick<SubscriptionQuotaSynchronizationService, "refreshCodexAccount">,
    private readonly zaiCodingPlanVerifier?: Pick<ZaiCodingPlanSubscriptionVerifier, "verify">,
  ) {}

  public async disconnect(
    context: TenantContext,
    input: DisconnectSubscriptionInput,
  ): Promise<DisconnectedSubscription> {
    const disconnected = await this.connections.disconnect(context, input);
    const lifecycle = this.lifecycle;
    if (!lifecycle) return disconnected;
    const connector = await lifecycle.connectors.get(context, disconnected.account.connector_id);
    if (
      connector.connector_id !== disconnected.account.connector_id ||
      connector.organization_id !== context.organizationId
    ) {
      throw new Error("연결 해제할 Connector 계보가 일치하지 않습니다");
    }
    if (connector.trust_origin !== "server-managed" || connector.location !== "server") return disconnected;
    const profileRoot = await existingSubscriptionProfileRoot(
      lifecycle.profileRoot,
      context.organizationId,
      disconnected.account.account_id,
    );
    if (profileRoot) {
      await lifecycle.logout(disconnected.account.provider_id, {
        organizationId: context.organizationId,
        accountId: disconnected.account.account_id,
        profileRoot,
      });
    }
    await this.connectors.revoke(context, {
      commandId: `${input.commandId}:connector-revoke`,
      connectorId: disconnected.account.connector_id,
    });
    await forgetSubscriptionProfileRoot(lifecycle.profileRoot, context.organizationId, disconnected.account.account_id);
    return disconnected;
  }

  public async connectModel(
    context: TenantContext,
    input: ConnectServerModelSubscriptionInput,
  ): Promise<ConnectedServerModelSubscription> {
    const secret = modelSecret(input.secret);
    const runtime = modelRuntime(input);
    if (!this.accounts) throw new Error("서버 model 구독 계정 조회 서비스가 구성되지 않았습니다");
    if (!this.modelRoutes) throw new Error("서버 내장 Core model route 조립기가 구성되지 않았습니다");
    const observed =
      runtime.verifier === "minimax"
        ? await this.verifyMiniMax(runtime.endpointUrl, secret, runtime.requiredModelId)
        : await this.verifyZaiCodingPlan(runtime.endpointUrl, secret, runtime.requiredModelId);
    const selectedConnectorId = connectorId(context, input);
    const connector = await this.connectors.provision(context, {
      commandId: `${input.commandId}:connector`,
      connectorId: selectedConnectorId,
      providerId: input.providerId,
      executionKind: "model",
      runtimeId: runtime.runtimeId,
    });
    let compensationVersion: number | undefined;
    try {
      if (
        connector.connectorId !== selectedConnectorId ||
        connector.providerId !== input.providerId ||
        connector.executionKind !== "model" ||
        connector.runtimeId !== runtime.runtimeId ||
        connector.status !== "offline"
      ) {
        throw new Error("서버 model Connector 준비 계보가 일치하지 않습니다");
      }
      const connected = await this.connections.connectModel(context, {
        ...input,
        commandId: `${input.commandId}:account`,
        connectorId: selectedConnectorId,
        profileLocator: `massion-server-model:${selectedConnectorId}`,
        secret,
        endpointUrl: runtime.endpointUrl,
        protocol: runtime.protocol,
      });
      if (
        connected.account.provider_id !== input.providerId ||
        connected.account.connector_id !== selectedConnectorId ||
        connected.account.status !== "offline" ||
        connected.binding.executionKind !== "model" ||
        connected.binding.protocol !== runtime.protocol ||
        connected.binding.endpointUrl !== runtime.endpointUrl
      ) {
        throw new Error("서버 model 구독 계정 준비 계보가 일치하지 않습니다");
      }
      const preparedAccount = await this.accounts.requireBindable(context, connected.account.account_id, "personal");
      if (
        preparedAccount.provider_id !== input.providerId ||
        preparedAccount.connector_id !== selectedConnectorId ||
        preparedAccount.status !== "offline"
      ) {
        throw new Error("서버 model 구독 계정 재개 계보가 일치하지 않습니다");
      }
      compensationVersion = preparedAccount.version;
      const readyConnector = await this.connectors.attestHealth(context, {
        commandId: `${input.commandId}:attest:v${String(preparedAccount.version)}`,
        connectorId: selectedConnectorId,
      });
      if (
        readyConnector.connectorId !== selectedConnectorId ||
        readyConnector.providerId !== input.providerId ||
        readyConnector.executionKind !== "model" ||
        readyConnector.runtimeId !== runtime.runtimeId ||
        readyConnector.status !== "ready"
      ) {
        throw new Error("서버 model Connector 건강 증명 계보가 일치하지 않습니다");
      }
      const account = await this.accounts.requireUsable(context, connected.account.account_id, "personal");
      compensationVersion = account.version;
      if (
        account.provider_id !== input.providerId ||
        account.connector_id !== selectedConnectorId ||
        account.status !== "active"
      ) {
        throw new Error("서버 model 구독 계정 활성화 계보가 일치하지 않습니다");
      }
      const modelRuntime = await this.modelRoutes.assemble(context, {
        commandId: `${input.commandId}:routes`,
        providerId: input.providerId,
        endpointId: connected.binding.endpointId,
        accountId: account.account_id,
        observed,
      });
      return { ...connected, account, connector: readyConnector, modelRuntime };
    } catch {
      await this.connectors
        .markOffline(context, {
          commandId: `${input.commandId}:compensate-offline:v${String(compensationVersion ?? "connector")}`,
          connectorId: selectedConnectorId,
        })
        .catch(() => undefined);
      throw new Error("서버 model 구독 연결을 완료하지 못했습니다");
    }
  }

  private async verifyMiniMax(
    endpointUrl: string,
    secret: string,
    requiredModelId: "MiniMax-M2.7",
  ): Promise<import("./minimax-subscription-verifier.js").ObservedMiniMaxSubscriptionModel> {
    if (!this.miniMaxVerifier) throw new Error("MiniMax 구독 Credential 실인증 서비스가 구성되지 않았습니다");
    return await this.miniMaxVerifier.verify({ endpointUrl, secret, requiredModelId });
  }

  private async verifyZaiCodingPlan(
    endpointUrl: string,
    secret: string,
    requiredModelId: "glm-5.2",
  ): Promise<import("./zai-coding-plan-subscription-verifier.js").ObservedZaiCodingPlanModel> {
    if (!this.zaiCodingPlanVerifier) throw new Error("Z.AI Coding Plan Credential 실인증 서비스가 구성되지 않았습니다");
    return await this.zaiCodingPlanVerifier.verify({ endpointUrl, secret, requiredModelId });
  }

  public async prepare(
    context: TenantContext,
    input: PrepareServerSubscriptionInput,
  ): Promise<PreparedServerSubscription> {
    const runtime = SERVER_RUNTIMES[input.providerId];
    if (!runtime) throw new Error("서버 관리형 소비자 구독은 Codex와 Claude만 지원합니다");
    if (input.billingKind !== "consumer-subscription") {
      throw new Error("서버 관리형 연결은 소비자 구독 계정만 지원합니다");
    }
    if (!runtime.authKinds.has(input.authKind)) {
      throw new Error("선택한 Provider의 소비자 구독 인증 방식이 유효하지 않습니다");
    }
    const selectedConnectorId = connectorId(context, input);
    const connector = await this.connectors.provision(context, {
      commandId: `${input.commandId}:connector`,
      connectorId: selectedConnectorId,
      providerId: input.providerId,
      executionKind: "agent-runtime",
      runtimeId: runtime.runtimeId,
    });
    if (connector.connectorId !== selectedConnectorId || connector.status !== "offline") {
      throw new Error("서버 Connector 준비 계보가 일치하지 않습니다");
    }
    try {
      const connected = await this.connections.connect(context, {
        commandId: `${input.commandId}:account`,
        providerId: input.providerId,
        alias: input.alias,
        connectorId: selectedConnectorId,
        profileLocator: `massion-server:${selectedConnectorId}`,
        authKind: input.authKind,
        billingKind: input.billingKind,
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.weight === undefined ? {} : { weight: input.weight }),
      });
      if (connected.account.connector_id !== selectedConnectorId || connected.account.status !== "offline") {
        throw new Error("서버 구독 계정 준비 계보가 일치하지 않습니다");
      }
      return {
        ...connected,
        connector,
        profileHandle: subscriptionProfileHandle(context.organizationId, connected.account.account_id),
      };
    } catch (error) {
      await this.connectors
        .markOffline(context, {
          commandId: `${input.commandId}:compensate-offline`,
          connectorId: selectedConnectorId,
        })
        .catch(() => undefined);
      throw error;
    }
  }

  public async attest(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly connectorId: string;
      readonly accountId?: string;
      readonly modelId?: string;
    },
  ): Promise<AttestedServerSubscription> {
    const preparedAccount =
      input.accountId && this.accounts
        ? await this.accounts.requireBindable(context, input.accountId, "personal")
        : undefined;
    const connector = await this.connectors.attestHealth(context, {
      commandId: preparedAccount ? `${input.commandId}:health:v${String(preparedAccount.version)}` : input.commandId,
      connectorId: input.connectorId,
    });
    if (connector.providerId !== "openai-codex") return connector;
    let compensationVersion = preparedAccount?.version;
    let quotaReauthenticationTransitioned = false;
    try {
      if (!input.accountId) throw new Error("Codex 구독 계정 ID가 필요합니다");
      if (!this.accounts || !this.modelRoutes || !this.codexObserver) {
        throw new Error("Codex Model route 조립 서비스가 구성되지 않았습니다");
      }
      const quotaSynchronization = this.codexQuotaSynchronization;
      if (!quotaSynchronization) {
        throw new Error("Codex 직접 quota 동기화 서비스가 구성되지 않았습니다");
      }
      const account = await this.accounts.requireUsable(context, input.accountId, "personal");
      compensationVersion = account.version;
      if (
        account.provider_id !== "openai-codex" ||
        account.connector_id !== connector.connectorId ||
        account.status !== "active"
      ) {
        throw new Error("Codex 구독 계정과 건강 증명 Connector 계보가 일치하지 않습니다");
      }
      const quotaRefresh = await quotaSynchronization.refreshCodexAccount({
        organizationId: context.organizationId,
        accountId: account.account_id,
        requireFresh: true,
      });
      if (quotaRefresh.status === "reauthentication-required") {
        quotaReauthenticationTransitioned = quotaRefresh.transitionApplied;
        throw new ServerConnectorAuthenticationRequiredError("openai-codex", connector.connectorId);
      }
      if (quotaRefresh.status !== "refreshed") {
        throw new ServerConnectorQuotaObservationUnavailableError();
      }
      const observed = await this.codexObserver.readModel({
        organizationId: context.organizationId,
        accountId: account.account_id,
        ...(input.modelId === undefined ? {} : { requestedModelId: input.modelId }),
      });
      const modelRuntime = await this.modelRoutes.assembleCodex(context, {
        commandId: `${input.commandId}:routes`,
        accountId: account.account_id,
        observed,
      });
      return {
        ...connector,
        modelRuntime,
        quotaObservation: { source: "direct", attestedAt: new Date().toISOString() },
      };
    } catch (error) {
      if (error instanceof ServerConnectorQuotaObservationUnavailableError) throw error;
      const paidSubscriptionRequired =
        error instanceof ServerConnectorPaidSubscriptionRequiredError
          ? error
          : error instanceof CodexSubscriptionObservationError && error.category === "subscription"
            ? new ServerConnectorPaidSubscriptionRequiredError("openai-codex", connector.connectorId)
            : undefined;
      if (paidSubscriptionRequired && paidSubscriptionRequired.connectorId === input.connectorId) {
        await this.connectors
          .markOffline(context, {
            commandId: `${input.commandId}:model-compensate:v${String(compensationVersion ?? "connector")}`,
            connectorId: input.connectorId,
          })
          .catch(() => undefined);
        throw paidSubscriptionRequired;
      }
      const authenticationRequired =
        error instanceof ServerConnectorAuthenticationRequiredError
          ? error
          : error instanceof CodexSubscriptionObservationError && error.category === "authentication"
            ? new ServerConnectorAuthenticationRequiredError("openai-codex", connector.connectorId)
            : undefined;
      if (authenticationRequired && authenticationRequired.connectorId === input.connectorId) {
        if (!quotaReauthenticationTransitioned) {
          await this.connectors.markReauthenticationRequired(context, {
            commandId: `${input.commandId}:reauth`,
            connectorId: input.connectorId,
          });
        }
        throw authenticationRequired;
      }
      await this.connectors
        .markOffline(context, {
          commandId: `${input.commandId}:model-compensate:v${String(compensationVersion ?? "connector")}`,
          connectorId: input.connectorId,
        })
        .catch(() => undefined);
      throw new Error("Codex GPT-5.6 Model route 조립을 완료하지 못했습니다", { cause: error });
    }
  }

  public async offline(
    context: TenantContext,
    input: { readonly commandId: string; readonly connectorId: string },
  ): Promise<ServerConnectorView> {
    return await this.connectors.markOffline(context, input);
  }
}
