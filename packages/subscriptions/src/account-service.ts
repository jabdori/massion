import { createHash, createHmac, randomUUID } from "node:crypto";

import { type OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { listCodingPlanPresets } from "./coding-plan.js";
import type { SubscriptionAccount, SubscriptionConnector } from "./contracts.js";
import { SUBSCRIPTION_ACCOUNT_POLICY_MIGRATION, SUBSCRIPTION_MIGRATION } from "./schema.js";

interface CommandInput {
  readonly commandId: string;
}

export interface RegisterSubscriptionAccountInput extends CommandInput {
  readonly providerId: string;
  readonly alias: string;
  readonly connectorId: string;
  readonly profileLocator: string;
  readonly billingKind: string;
}

export interface AccountCommandInput extends CommandInput {
  readonly accountId: string;
  readonly expectedVersion: number;
}

export type ShareSubscriptionAccountInput = AccountCommandInput;

export interface SubscriptionSharingAuthorizer {
  authorize(context: TenantContext, account: SubscriptionAccount): Promise<{ readonly policyVersion: string }>;
}

interface SubscriptionAuditEvent {
  readonly event_id: string;
  readonly organization_id: string;
  readonly actor_user_id: string;
  readonly command_id: string;
  readonly event_type: string;
  readonly resource_id: string;
  readonly request_hash: string;
  readonly result_json: string;
  readonly created_at: unknown;
}

const DENY_SHARING: SubscriptionSharingAuthorizer = {
  authorize() {
    return Promise.reject(new Error("관리자 정책에서 구독 계정 공유를 허용하지 않았습니다"));
  },
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireText(value: string, label: string, maximum = 128): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}은(는) 비어 있을 수 없습니다`);
  if (normalized.length > maximum) throw new Error(`${label}은(는) ${String(maximum)}자를 초과할 수 없습니다`);
  return normalized;
}

function forbidsQuotaCircumvention(providerId: string): boolean {
  return listCodingPlanPresets().some(
    (preset) => preset.id === providerId && preset.accountPolicy === "no-quota-circumvention",
  );
}

export class SubscriptionAccountService {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly fingerprintKey: Buffer,
    private readonly sharingAuthorizer: SubscriptionSharingAuthorizer,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    fingerprintKey: Uint8Array,
    sharingAuthorizer: SubscriptionSharingAuthorizer = DENY_SHARING,
  ): Promise<SubscriptionAccountService> {
    if (fingerprintKey.byteLength < 32) throw new Error("계정 fingerprint key는 32바이트 이상이어야 합니다");
    await applyMigrations(database, [SUBSCRIPTION_MIGRATION, SUBSCRIPTION_ACCOUNT_POLICY_MIGRATION]);
    return new SubscriptionAccountService(database, organizations, Buffer.from(fingerprintKey), sharingAuthorizer);
  }

  public async register(context: TenantContext, input: RegisterSubscriptionAccountInput): Promise<SubscriptionAccount> {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(input.providerId)) throw new Error("Provider ID 형식이 유효하지 않습니다");
    const alias = requireText(input.alias, "계정 별칭");
    const connectorId = requireText(input.connectorId, "Connector ID");
    const profileLocator = requireText(input.profileLocator, "외부 계정 식별자", 2048);
    const billingKind = requireText(input.billingKind, "결제 유형");
    const profileFingerprint = createHmac("sha256", this.fingerprintKey)
      .update(`${context.organizationId}\0${input.providerId}\0${profileLocator}`)
      .digest("hex");
    const request = {
      commandId: input.commandId,
      providerId: input.providerId,
      alias,
      connectorId,
      profileFingerprint,
      billingKind,
    };

    return await this.command(context, input.commandId, "subscription_account_registered", request, async (tx) => {
      const connector = await this.requireConnector(tx, context.organizationId, connectorId);
      if (connector.location === "edge" && connector.owner_user_id !== context.userId) {
        throw new Error("다른 사용자의 Edge Connector에는 계정을 등록할 수 없습니다");
      }
      if (connector.status === "revoked" || connector.status === "incompatible") {
        throw new Error("사용할 수 없는 Connector에는 계정을 등록할 수 없습니다");
      }
      const accountId = randomUUID();
      if (forbidsQuotaCircumvention(input.providerId)) {
        const [existingAccounts] = await tx.query<[Array<{ account_id: string }>]>(
          `SELECT account_id FROM subscription_account
           WHERE organization_id = $organization_id AND provider_id = $provider_id AND status != 'revoked' LIMIT 1;`,
          { organization_id: context.organizationId, provider_id: input.providerId },
        );
        if (existingAccounts[0]) {
          throw new Error("제공자 약관상 여러 계정으로 할당량 우회를 구성할 수 없습니다");
        }
        await tx.query(
          `CREATE subscription_provider_account_guard CONTENT {
             organization_id: $organization_id, provider_id: $provider_id, account_id: $account_id,
             policy: 'no-quota-circumvention', created_at: time::now()
           };`,
          { organization_id: context.organizationId, provider_id: input.providerId, account_id: accountId },
        );
      }
      await tx.query(
        `CREATE subscription_account CONTENT {
          account_id: $account_id,
          organization_id: $organization_id,
          owner_user_id: $owner_user_id,
          provider_id: $provider_id,
          alias: $alias,
          scope: 'personal',
          connector_id: $connector_id,
          profile_fingerprint: $profile_fingerprint,
          billing_kind: $billing_kind,
          status: $status,
          consent_version: 0,
          version: 1,
          created_at: time::now(),
          updated_at: time::now()
        };`,
        {
          account_id: accountId,
          organization_id: context.organizationId,
          owner_user_id: context.userId,
          provider_id: input.providerId,
          alias,
          connector_id: connectorId,
          profile_fingerprint: profileFingerprint,
          billing_kind: billingKind,
          status: connector.status === "ready" ? "active" : "offline",
        },
      );
      return await this.requireAccount(tx, context.organizationId, accountId);
    });
  }

  public async share(context: TenantContext, input: ShareSubscriptionAccountInput): Promise<SubscriptionAccount> {
    return await this.command(context, input.commandId, "subscription_account_shared", input, async (tx) => {
      const account = await this.requireOwnedAccount(tx, context, input.accountId);
      this.requireVersion(account, input.expectedVersion);
      if (account.status === "revoked") throw new Error("연결 해제된 계정은 공유할 수 없습니다");
      if (account.scope === "organization") throw new Error("이미 조직에 공유된 계정입니다");
      const authorization = await this.sharingAuthorizer.authorize(context, account);
      const policyVersion = requireText(authorization.policyVersion, "공유 정책 version");
      const consentVersion = account.consent_version + 1;
      await this.insertConsent(tx, context, account, consentVersion, "shared", policyVersion, input.commandId);
      await tx.query(
        `UPDATE subscription_account
         SET scope = 'organization', consent_version = $consent_version, version += 1, updated_at = time::now()
         WHERE organization_id = $organization_id AND account_id = $account_id AND version = $expected_version;`,
        {
          organization_id: context.organizationId,
          account_id: input.accountId,
          expected_version: input.expectedVersion,
          consent_version: consentVersion,
        },
      );
      return await this.requireUpdatedAccount(tx, context.organizationId, input.accountId, input.expectedVersion + 1);
    });
  }

  public async unshare(context: TenantContext, input: AccountCommandInput): Promise<SubscriptionAccount> {
    return await this.command(context, input.commandId, "subscription_account_unshared", input, async (tx) => {
      const account = await this.requireOwnedAccount(tx, context, input.accountId);
      this.requireVersion(account, input.expectedVersion);
      if (account.scope !== "organization") throw new Error("조직에 공유되지 않은 계정입니다");
      const consentVersion = account.consent_version + 1;
      await this.insertConsent(tx, context, account, consentVersion, "unshared", "owner-revocation", input.commandId);
      await tx.query(
        `UPDATE subscription_account
         SET scope = 'personal', consent_version = $consent_version, version += 1, updated_at = time::now()
         WHERE organization_id = $organization_id AND account_id = $account_id AND version = $expected_version;`,
        {
          organization_id: context.organizationId,
          account_id: input.accountId,
          expected_version: input.expectedVersion,
          consent_version: consentVersion,
        },
      );
      return await this.requireUpdatedAccount(tx, context.organizationId, input.accountId, input.expectedVersion + 1);
    });
  }

  public async disconnect(context: TenantContext, input: AccountCommandInput): Promise<SubscriptionAccount> {
    return await this.command(context, input.commandId, "subscription_account_disconnected", input, async (tx) => {
      const account = await this.requireOwnedAccount(tx, context, input.accountId);
      this.requireVersion(account, input.expectedVersion);
      if (account.status === "revoked") throw new Error("이미 연결 해제된 계정입니다");
      let consentVersion = account.consent_version;
      if (account.scope === "organization") {
        consentVersion += 1;
        await this.insertConsent(
          tx,
          context,
          account,
          consentVersion,
          "unshared",
          "account-disconnected",
          input.commandId,
        );
      }
      await tx.query(
        `UPDATE subscription_account
         SET scope = 'personal', status = 'revoked', consent_version = $consent_version,
             version += 1, updated_at = time::now()
         WHERE organization_id = $organization_id AND account_id = $account_id AND version = $expected_version;`,
        {
          organization_id: context.organizationId,
          account_id: input.accountId,
          expected_version: input.expectedVersion,
          consent_version: consentVersion,
        },
      );
      if (forbidsQuotaCircumvention(account.provider_id)) {
        await tx.query(
          `DELETE subscription_provider_account_guard
           WHERE organization_id = $organization_id AND provider_id = $provider_id AND account_id = $account_id;`,
          {
            organization_id: context.organizationId,
            provider_id: account.provider_id,
            account_id: input.accountId,
          },
        );
      }
      return await this.requireUpdatedAccount(tx, context.organizationId, input.accountId, input.expectedVersion + 1);
    });
  }

  public async list(
    context: TenantContext,
    visibility: "mine" | "organization",
  ): Promise<readonly SubscriptionAccount[]> {
    await this.organizations.verifyTenantContext(context);
    if (visibility === "mine") {
      const [accounts] = await this.database.query<[SubscriptionAccount[]]>(
        `SELECT * OMIT id FROM subscription_account
         WHERE organization_id = $organization_id AND owner_user_id = $owner_user_id
         ORDER BY created_at ASC;`,
        { organization_id: context.organizationId, owner_user_id: context.userId },
      );
      return accounts;
    }
    const [accounts] = await this.database.query<[SubscriptionAccount[]]>(
      `SELECT * OMIT id FROM subscription_account
       WHERE organization_id = $organization_id AND (scope = 'organization' OR owner_user_id = $owner_user_id)
       ORDER BY created_at ASC;`,
      { organization_id: context.organizationId, owner_user_id: context.userId },
    );
    return accounts;
  }

  public async requireUsable(
    context: TenantContext,
    accountId: string,
    visibility: "personal" | "organization",
    executor: QueryExecutor = this.database,
  ): Promise<SubscriptionAccount> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    const account = await this.requireAccount(executor, context.organizationId, accountId);
    if (visibility === "organization" && account.scope !== "organization") {
      throw new Error("계정 공유가 철회되어 조직에서 사용할 수 없습니다");
    }
    if (visibility === "personal" && account.owner_user_id !== context.userId) {
      throw new Error("개인 계정은 계정 소유자만 사용할 수 있습니다");
    }
    if (account.status !== "active") throw new Error("활성 상태의 구독 계정만 사용할 수 있습니다");
    const connector = await this.requireConnector(executor, context.organizationId, account.connector_id);
    if (connector.status !== "ready") throw new Error("준비 상태의 Connector가 아닙니다");
    return account;
  }

  private async command(
    context: TenantContext,
    commandId: string,
    eventType: string,
    request: unknown,
    operation: (executor: QueryExecutor) => Promise<SubscriptionAccount>,
  ): Promise<SubscriptionAccount> {
    requireText(commandId, "Command ID");
    const requestHash = sha256(canonicalJson(request));
    await this.organizations.verifyTenantContext(context);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const [events] = await tx.query<[SubscriptionAuditEvent[]]>(
        `SELECT * OMIT id FROM subscription_audit_event
         WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;`,
        { organization_id: context.organizationId, command_id: commandId },
      );
      const existing = events[0];
      if (existing) {
        if (existing.actor_user_id !== context.userId) {
          throw new Error("같은 Command ID를 다른 사용자가 재사용할 수 없습니다");
        }
        if (existing.request_hash !== requestHash) {
          throw new Error("같은 Command ID에 다른 요청을 사용할 수 없습니다");
        }
        return JSON.parse(existing.result_json) as SubscriptionAccount;
      }

      const account = await operation(tx);
      const safeResult = JSON.parse(JSON.stringify(account)) as SubscriptionAccount;
      await tx.query(
        `CREATE subscription_audit_event CONTENT {
          event_id: $event_id,
          organization_id: $organization_id,
          actor_user_id: $actor_user_id,
          command_id: $command_id,
          event_type: $event_type,
          resource_id: $resource_id,
          request_hash: $request_hash,
          result_json: $result_json,
          created_at: time::now()
        };`,
        {
          event_id: randomUUID(),
          organization_id: context.organizationId,
          actor_user_id: context.userId,
          command_id: commandId,
          event_type: eventType,
          resource_id: account.account_id,
          request_hash: requestHash,
          result_json: JSON.stringify(safeResult),
        },
      );
      return safeResult;
    });
  }

  private async requireOwnedAccount(
    executor: QueryExecutor,
    context: TenantContext,
    accountId: string,
  ): Promise<SubscriptionAccount> {
    const account = await this.requireAccount(executor, context.organizationId, requireText(accountId, "계정 ID"));
    if (account.owner_user_id !== context.userId) throw new Error("구독 계정 소유자만 이 작업을 수행할 수 있습니다");
    return account;
  }

  private requireVersion(account: SubscriptionAccount, expectedVersion: number): void {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || account.version !== expectedVersion) {
      throw new Error("구독 계정 version이 일치하지 않습니다");
    }
  }

  private async requireUpdatedAccount(
    executor: QueryExecutor,
    organizationId: string,
    accountId: string,
    expectedVersion: number,
  ): Promise<SubscriptionAccount> {
    const account = await this.requireAccount(executor, organizationId, accountId);
    if (account.version !== expectedVersion) throw new Error("구독 계정 version 갱신이 충돌했습니다");
    return account;
  }

  private async requireAccount(
    executor: QueryExecutor,
    organizationId: string,
    accountId: string,
  ): Promise<SubscriptionAccount> {
    const [accounts] = await executor.query<[SubscriptionAccount[]]>(
      `SELECT * OMIT id FROM subscription_account
       WHERE organization_id = $organization_id AND account_id = $account_id LIMIT 1;`,
      { organization_id: organizationId, account_id: accountId },
    );
    if (!accounts[0]) throw new Error(`구독 계정을 찾을 수 없습니다: ${accountId}`);
    return accounts[0];
  }

  private async requireConnector(
    executor: QueryExecutor,
    organizationId: string,
    connectorId: string,
  ): Promise<SubscriptionConnector> {
    const [connectors] = await executor.query<[SubscriptionConnector[]]>(
      `SELECT * OMIT id FROM subscription_connector
       WHERE organization_id = $organization_id AND connector_id = $connector_id LIMIT 1;`,
      { organization_id: organizationId, connector_id: connectorId },
    );
    if (!connectors[0]) throw new Error(`Connector를 찾을 수 없습니다: ${connectorId}`);
    return connectors[0];
  }

  private async insertConsent(
    executor: QueryExecutor,
    context: TenantContext,
    account: SubscriptionAccount,
    version: number,
    action: "shared" | "unshared",
    policyVersion: string,
    commandId: string,
  ): Promise<void> {
    await executor.query(
      `CREATE subscription_consent CONTENT {
        consent_id: $consent_id,
        organization_id: $organization_id,
        account_id: $account_id,
        owner_user_id: $owner_user_id,
        version: $version,
        action: $action,
        policy_version: $policy_version,
        command_id: $command_id,
        created_at: time::now()
      };`,
      {
        consent_id: randomUUID(),
        organization_id: context.organizationId,
        account_id: account.account_id,
        owner_user_id: context.userId,
        version,
        action,
        policy_version: policyVersion,
        command_id: commandId,
      },
    );
  }
}
