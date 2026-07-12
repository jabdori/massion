import { createHash } from "node:crypto";

import type { TenantContext } from "@massion/identity";
import type { ProviderService, SubscriptionProviderConnectionSpec } from "@massion/router";
import type { MassionDatabase } from "@massion/storage";
import type {
  SubscriptionAccount,
  SubscriptionAccountService,
  SubscriptionAuthKind,
  SubscriptionProviderProtocol,
} from "@massion/subscriptions";

export interface ConnectSubscriptionInput {
  readonly commandId: string;
  readonly providerId: string;
  readonly alias: string;
  readonly connectorId: string;
  readonly profileLocator: string;
  readonly authKind: SubscriptionAuthKind;
  readonly billingKind: string;
  readonly endpointUrl?: string;
  readonly protocol?: SubscriptionProviderProtocol;
  readonly acceptExperimental?: boolean;
  readonly priority?: number;
  readonly weight?: number;
}

export interface ConnectModelSubscriptionInput extends Omit<ConnectSubscriptionInput, "authKind"> {
  readonly authKind: Extract<SubscriptionAuthKind, "api-key" | "subscription-key">;
  readonly secret: string;
}

export interface SubscriptionConnectionBinding {
  readonly providerId: string;
  readonly endpointId: string;
  readonly endpointUrl: string;
  readonly protocol: SubscriptionProviderProtocol;
  readonly executionKind: "model" | "agent-runtime";
  readonly credentialId: string;
}

export interface ConnectedSubscription {
  readonly account: SubscriptionAccount;
  readonly binding: SubscriptionConnectionBinding;
}

export interface DisconnectSubscriptionInput {
  readonly commandId: string;
  readonly accountId: string;
  readonly expectedVersion: number;
}

export interface DisconnectedSubscription {
  readonly account: SubscriptionAccount;
  readonly revokedCredentialCount: number;
}

function requireAllowedConnection(
  connection: SubscriptionProviderConnectionSpec,
  input: ConnectSubscriptionInput,
): void {
  if (connection.availability === "requires-provider-approval") {
    throw new Error("이 구독 Provider는 공식 제공자 승인이 확인된 뒤에만 연결할 수 있습니다");
  }
  if (connection.availability === "experimental" && input.acceptExperimental !== true) {
    throw new Error("실험적 구독 Provider 연결에는 명시적 동의가 필요합니다");
  }
  if (!connection.authKinds.includes(input.authKind)) {
    throw new Error("구독 Provider가 허용하지 않는 인증 방식입니다");
  }
  if (!connection.billingKinds.includes(input.billingKind)) {
    throw new Error("구독 Provider가 허용하지 않는 결제 유형입니다");
  }
}

export class SubscriptionConnectionService {
  public constructor(
    private readonly database: MassionDatabase,
    private readonly accounts: SubscriptionAccountService,
    private readonly providers: ProviderService,
  ) {}

  public async connect(context: TenantContext, input: ConnectSubscriptionInput): Promise<ConnectedSubscription> {
    return await this.database.transaction(async (tx) => {
      const ensured = await this.providers.ensureSubscriptionProvider(
        context,
        {
          commandId: `${input.commandId}:provider`,
          providerId: input.providerId,
          ...(input.endpointUrl === undefined ? {} : { endpointUrl: input.endpointUrl }),
          ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
        },
        tx,
      );
      requireAllowedConnection(ensured.connection, input);
      if (ensured.connection.executionKind !== "agent-runtime") {
        throw new Error("기존 구독 연결 명령은 agent-runtime 실행 종류에만 사용할 수 있습니다");
      }

      const account = await this.accounts.register(
        context,
        {
          commandId: `${input.commandId}:account`,
          providerId: input.providerId,
          alias: input.alias,
          connectorId: input.connectorId,
          profileLocator: input.profileLocator,
          billingKind: input.billingKind,
          requiredExecutionKind: ensured.connection.executionKind,
          requiredCapability: input.providerId,
        },
        tx,
      );
      const labelSuffix = createHash("sha256").update(account.account_id).digest("hex").slice(0, 8);
      const added = await this.providers.addConnectorCredential(
        context,
        {
          commandId: `${input.commandId}:credential`,
          providerId: input.providerId,
          endpointId: ensured.endpoint.endpoint_id,
          label: `${account.alias} · ${labelSuffix}`,
          accountId: account.account_id,
          connectorId: account.connector_id,
          scope: "personal",
          priority: input.priority ?? 1,
          weight: input.weight ?? 1,
        },
        tx,
      );
      return {
        account,
        binding: {
          providerId: input.providerId,
          endpointId: ensured.endpoint.endpoint_id,
          endpointUrl: ensured.connection.endpointUrl,
          protocol: ensured.connection.protocol,
          executionKind: ensured.connection.executionKind,
          credentialId: added.credential.credential_id,
        },
      };
    });
  }

  public async connectModel(
    context: TenantContext,
    input: ConnectModelSubscriptionInput,
  ): Promise<ConnectedSubscription> {
    if (!input.secret.trim()) throw new Error("구독 Credential secret은 비어 있을 수 없습니다");
    return await this.database.transaction(async (tx) => {
      const ensured = await this.providers.ensureSubscriptionProvider(
        context,
        {
          commandId: `${input.commandId}:provider`,
          providerId: input.providerId,
          ...(input.endpointUrl === undefined ? {} : { endpointUrl: input.endpointUrl }),
          ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
        },
        tx,
      );
      requireAllowedConnection(ensured.connection, input);
      if (ensured.connection.executionKind !== "model") {
        throw new Error("model 구독 연결 명령은 model 실행 종류에만 사용할 수 있습니다");
      }
      if (ensured.connection.usageScope === "interactive-coding") {
        throw new Error(
          "대화형 코딩 전용 구독은 전용 interactive 실행 정책이 구현되기 전까지 direct model backend로 사용할 수 없습니다",
        );
      }

      const account = await this.accounts.register(
        context,
        {
          commandId: `${input.commandId}:account`,
          providerId: input.providerId,
          alias: input.alias,
          connectorId: input.connectorId,
          profileLocator: input.profileLocator,
          billingKind: input.billingKind,
          requiredExecutionKind: "model",
          requiredCapability: input.providerId,
        },
        tx,
      );
      const labelSuffix = createHash("sha256").update(account.account_id).digest("hex").slice(0, 8);
      const added = await this.providers.addSubscriptionCredential(
        context,
        {
          commandId: `${input.commandId}:credential`,
          providerId: input.providerId,
          endpointId: ensured.endpoint.endpoint_id,
          label: `${account.alias} · ${labelSuffix}`,
          authKind: input.authKind,
          secret: input.secret,
          accountId: account.account_id,
          connectorId: account.connector_id,
          scope: "personal",
          priority: input.priority ?? 1,
          weight: input.weight ?? 1,
          ...(input.acceptExperimental === undefined ? {} : { acceptExperimental: input.acceptExperimental }),
        },
        tx,
      );
      return {
        account,
        binding: {
          providerId: input.providerId,
          endpointId: ensured.endpoint.endpoint_id,
          endpointUrl: ensured.connection.endpointUrl,
          protocol: ensured.connection.protocol,
          executionKind: ensured.connection.executionKind,
          credentialId: added.credential.credential_id,
        },
      };
    });
  }

  public async disconnect(
    context: TenantContext,
    input: DisconnectSubscriptionInput,
  ): Promise<DisconnectedSubscription> {
    return await this.database.transaction(async (tx) => {
      const account = await this.accounts.disconnect(
        context,
        {
          commandId: `${input.commandId}:account`,
          accountId: input.accountId,
          expectedVersion: input.expectedVersion,
        },
        tx,
      );
      const revoked = await this.providers.revokeSubscriptionAccountCredentials(
        context,
        {
          commandId: `${input.commandId}:credentials`,
          accountId: input.accountId,
        },
        tx,
      );
      return { account, revokedCredentialCount: revoked.credentials.length };
    });
  }
}
