import { randomUUID } from "node:crypto";

import { type OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";
import { type SubscriptionAccountService, type SubscriptionScope } from "@massion/subscriptions";

import { ROUTER_REGISTRY_MIGRATION, ROUTER_SUBSCRIPTION_MATERIAL_MIGRATION } from "./schema.js";
import { CredentialVault } from "./vault.js";

export type AdapterKind = "ai-sdk" | "openai-compatible" | "ollama" | "external-gateway";
export type CredentialType = "api_key" | "oauth" | "service_account" | "workload_identity" | "subscription_session";
export type CredentialStatus = "active" | "cooldown" | "disabled" | "revoked";

export interface ModelProvider {
  readonly provider_id: string;
  readonly organization_id: string;
  readonly display_name: string;
  readonly adapter_kind: AdapterKind;
  readonly enabled: boolean;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface ProviderEndpoint {
  readonly endpoint_id: string;
  readonly organization_id: string;
  readonly provider_id: string;
  readonly name: string;
  readonly base_url: string;
  readonly local: boolean;
  readonly gateway_kind?: "litellm" | "portkey" | "omniroute" | "other";
  readonly enabled: boolean;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface ProviderCredential {
  readonly credential_id: string;
  readonly organization_id: string;
  readonly provider_id: string;
  readonly endpoint_id: string;
  readonly label: string;
  readonly credential_type: CredentialType;
  readonly status: CredentialStatus;
  readonly version: number;
  readonly secret_version: number;
  readonly priority: number;
  readonly weight: number;
  readonly request_count: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cost_micros: number;
  readonly quota_limit?: number;
  readonly quota_remaining?: number;
  readonly quota_reset_at?: unknown;
  readonly cooldown_until?: unknown;
  readonly last_selected_sequence: number;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly material_kind?: "encrypted_secret" | "connector_session";
  readonly subscription_account_id?: string;
  readonly subscription_connector_id?: string;
  readonly subscription_scope?: SubscriptionScope;
}

export type CredentialMaterial =
  | { readonly kind: "encrypted_secret"; readonly secret: string; readonly secretVersion: number }
  | { readonly kind: "connector_session"; readonly accountId: string; readonly connectorId: string };

interface CredentialSecretVersion {
  readonly secret_version_id: string;
  readonly organization_id: string;
  readonly credential_id: string;
  readonly version: number;
  readonly algorithm: "aes-256-gcm";
  readonly ciphertext: string;
  readonly iv: string;
  readonly auth_tag: string;
  readonly aad: string;
  readonly created_by: string;
  readonly created_at: unknown;
}

export interface RouterAuditEvent {
  readonly audit_event_id: string;
  readonly organization_id: string;
  readonly command_id: string;
  readonly event_type: string;
  readonly actor_user_id: string;
  readonly request_json: string;
  readonly result_json: string;
  readonly created_at: unknown;
}

interface CommandInput {
  readonly commandId: string;
}

export interface RegisterProviderInput extends CommandInput {
  readonly providerId: string;
  readonly displayName: string;
  readonly adapterKind: AdapterKind;
}

export interface RegisterEndpointInput extends CommandInput {
  readonly providerId: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly local: boolean;
  readonly gatewayKind?: ProviderEndpoint["gateway_kind"];
}

export interface AddCredentialInput extends CommandInput {
  readonly providerId: string;
  readonly endpointId: string;
  readonly label: string;
  readonly credentialType: CredentialType;
  readonly secret: string;
  readonly priority: number;
  readonly weight: number;
}

export interface AddConnectorCredentialInput extends CommandInput {
  readonly providerId: string;
  readonly endpointId: string;
  readonly label: string;
  readonly accountId: string;
  readonly connectorId: string;
  readonly scope: SubscriptionScope;
  readonly priority: number;
  readonly weight: number;
}

export interface ProviderServiceOptions {
  readonly accounts?: SubscriptionAccountService;
}

export interface RotateCredentialInput extends CommandInput {
  readonly credentialId: string;
  readonly expectedVersion: number;
  readonly secret: string;
}

export interface RevokeCredentialInput extends CommandInput {
  readonly credentialId: string;
  readonly expectedVersion: number;
}

export interface UpdateCredentialQuotaInput extends CommandInput {
  readonly credentialId: string;
  readonly expectedVersion: number;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: string;
}

const CREDENTIAL_TYPES = new Set<CredentialType>(["api_key", "oauth", "service_account", "workload_identity"]);
const GATEWAY_KINDS = new Set<NonNullable<ProviderEndpoint["gateway_kind"]>>([
  "litellm",
  "portkey",
  "omniroute",
  "other",
]);

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

export class ProviderService {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly vault: CredentialVault,
    private readonly options: ProviderServiceOptions,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    vault: CredentialVault,
    options: ProviderServiceOptions = {},
  ): Promise<ProviderService> {
    await applyMigrations(database, [ROUTER_REGISTRY_MIGRATION, ROUTER_SUBSCRIPTION_MATERIAL_MIGRATION]);
    return new ProviderService(database, organizations, vault, options);
  }

  public async registerProvider(
    context: TenantContext,
    input: RegisterProviderInput,
  ): Promise<{ provider: ModelProvider; audit: RouterAuditEvent }> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(input.providerId)) throw new Error("Provider ID 형식이 유효하지 않습니다");
    if (!input.displayName.trim()) throw new Error("Provider 표시 이름은 비어 있을 수 없습니다");
    return await this.command(context, input.commandId, "provider_registered", canonicalJson(input), async (tx) => {
      const [providers] = await tx.query<[ModelProvider[]]>(
        "CREATE model_provider CONTENT { provider_id: $provider_id, organization_id: $organization_id, display_name: $display_name, adapter_kind: $adapter_kind, enabled: true, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          provider_id: input.providerId,
          organization_id: context.organizationId,
          display_name: input.displayName.trim(),
          adapter_kind: input.adapterKind,
        },
      );
      if (!providers[0]) throw new Error("Provider 생성 결과가 없습니다");
      return { provider: providers[0] };
    });
  }

  public async registerEndpoint(
    context: TenantContext,
    input: RegisterEndpointInput,
  ): Promise<{ endpoint: ProviderEndpoint; audit: RouterAuditEvent }> {
    const url = new URL(input.baseUrl);
    if (!input.local && url.protocol !== "https:") throw new Error("외부 Provider endpoint는 HTTPS여야 합니다");
    if (input.local && !["http:", "https:"].includes(url.protocol))
      throw new Error("로컬 endpoint URL이 유효하지 않습니다");
    if (input.gatewayKind && !GATEWAY_KINDS.has(input.gatewayKind)) throw new Error("지원하지 않는 Gateway입니다");
    return await this.command(
      context,
      input.commandId,
      "provider_endpoint_registered",
      canonicalJson(input),
      async (tx) => {
        const provider = await this.requireProvider(tx, context.organizationId, input.providerId);
        if (provider.adapter_kind === "external-gateway" && !input.gatewayKind)
          throw new Error("external-gateway Provider에는 gatewayKind가 필요합니다");
        if (provider.adapter_kind !== "external-gateway" && input.gatewayKind)
          throw new Error("gatewayKind는 external-gateway Provider에만 사용할 수 있습니다");
        const [endpoints] = await tx.query<[ProviderEndpoint[]]>(
          "CREATE provider_endpoint CONTENT { endpoint_id: $endpoint_id, organization_id: $organization_id, provider_id: $provider_id, name: $name, base_url: $base_url, local: $local, gateway_kind: $gateway_kind, enabled: true, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
          {
            endpoint_id: randomUUID(),
            organization_id: context.organizationId,
            provider_id: input.providerId,
            name: input.name.trim(),
            base_url: url.toString().replace(/\/$/, ""),
            local: input.local,
            gateway_kind: input.gatewayKind,
          },
        );
        if (!endpoints[0]) throw new Error("Provider Endpoint 생성 결과가 없습니다");
        return { endpoint: endpoints[0] };
      },
    );
  }

  public async listProviders(context: TenantContext): Promise<ModelProvider[]> {
    await this.organizations.verifyTenantContext(context);
    const [providers] = await this.database.query<[ModelProvider[]]>(
      "SELECT * OMIT id FROM model_provider WHERE organization_id = $organization_id ORDER BY display_name ASC, provider_id ASC;",
      { organization_id: context.organizationId },
    );
    return providers;
  }

  public async listEndpoints(context: TenantContext, providerId?: string): Promise<ProviderEndpoint[]> {
    await this.organizations.verifyTenantContext(context);
    const [endpoints] = await this.database.query<[ProviderEndpoint[]]>(
      providerId === undefined
        ? "SELECT * OMIT id FROM provider_endpoint WHERE organization_id = $organization_id ORDER BY provider_id ASC, name ASC, endpoint_id ASC;"
        : "SELECT * OMIT id FROM provider_endpoint WHERE organization_id = $organization_id AND provider_id = $provider_id ORDER BY name ASC, endpoint_id ASC;",
      { organization_id: context.organizationId, provider_id: providerId },
    );
    return endpoints;
  }

  public async addCredential(
    context: TenantContext,
    input: AddCredentialInput,
  ): Promise<{ credential: ProviderCredential; audit: RouterAuditEvent }> {
    if (!CREDENTIAL_TYPES.has(input.credentialType)) throw new Error("지원하지 않는 Credential type입니다");
    if (input.priority < 0 || input.weight < 1) throw new Error("Credential priority와 weight가 유효하지 않습니다");
    const requestJson = canonicalJson({
      ...input,
      secret: "[REDACTED]",
      secretFingerprint: this.vault.fingerprint(input.secret),
    });
    return await this.command(context, input.commandId, "credential_added", requestJson, async (tx) => {
      await this.requireProvider(tx, context.organizationId, input.providerId);
      await this.requireEndpoint(tx, context.organizationId, input.providerId, input.endpointId);
      const credentialId = randomUUID();
      const [credentials] = await tx.query<[ProviderCredential[]]>(
        "CREATE provider_credential CONTENT { credential_id: $credential_id, organization_id: $organization_id, provider_id: $provider_id, endpoint_id: $endpoint_id, label: $label, credential_type: $credential_type, status: 'active', version: 1, secret_version: 1, priority: $priority, weight: $weight, request_count: 0, input_tokens: 0, output_tokens: 0, cost_micros: 0, last_selected_sequence: 0, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          credential_id: credentialId,
          organization_id: context.organizationId,
          provider_id: input.providerId,
          endpoint_id: input.endpointId,
          label: input.label.trim(),
          credential_type: input.credentialType,
          priority: input.priority,
          weight: input.weight,
        },
      );
      const credential = credentials[0];
      if (!credential) throw new Error("Credential 생성 결과가 없습니다");
      await this.insertSecret(tx, context, credential, 1, input.secret);
      return { credential };
    });
  }

  public async addConnectorCredential(
    context: TenantContext,
    input: AddConnectorCredentialInput,
  ): Promise<{ credential: ProviderCredential; audit: RouterAuditEvent }> {
    if (input.priority < 0 || input.weight < 1) throw new Error("Credential priority와 weight가 유효하지 않습니다");
    const accounts = this.options.accounts;
    if (!accounts) throw new Error("구독 계정 서비스가 구성되지 않았습니다");
    return await this.command(
      context,
      input.commandId,
      "connector_credential_added",
      canonicalJson(input),
      async (tx) => {
        await this.requireProvider(tx, context.organizationId, input.providerId);
        await this.requireEndpoint(tx, context.organizationId, input.providerId, input.endpointId);
        const account = await accounts.requireUsable(context, input.accountId, input.scope, tx);
        if (account.provider_id !== input.providerId) throw new Error("구독 계정과 Provider가 일치하지 않습니다");
        if (account.connector_id !== input.connectorId) throw new Error("구독 계정과 Connector가 일치하지 않습니다");
        const [credentials] = await tx.query<[ProviderCredential[]]>(
          `CREATE provider_credential CONTENT {
            credential_id: $credential_id, organization_id: $organization_id, provider_id: $provider_id,
            endpoint_id: $endpoint_id, label: $label, credential_type: 'subscription_session', status: 'active',
            version: 1, secret_version: 0, priority: $priority, weight: $weight, request_count: 0,
            input_tokens: 0, output_tokens: 0, cost_micros: 0, last_selected_sequence: 0,
            material_kind: 'connector_session', subscription_account_id: $subscription_account_id,
            subscription_connector_id: $subscription_connector_id, subscription_scope: $subscription_scope,
            created_at: time::now(), updated_at: time::now()
          } RETURN AFTER;`,
          {
            credential_id: randomUUID(),
            organization_id: context.organizationId,
            provider_id: input.providerId,
            endpoint_id: input.endpointId,
            label: input.label.trim(),
            priority: input.priority,
            weight: input.weight,
            subscription_account_id: input.accountId,
            subscription_connector_id: input.connectorId,
            subscription_scope: input.scope,
          },
        );
        if (!credentials[0]) throw new Error("Connector Credential 생성 결과가 없습니다");
        return { credential: credentials[0] };
      },
    );
  }

  public async rotateCredential(
    context: TenantContext,
    input: RotateCredentialInput,
  ): Promise<{ credential: ProviderCredential; audit: RouterAuditEvent }> {
    const requestJson = canonicalJson({
      ...input,
      secret: "[REDACTED]",
      secretFingerprint: this.vault.fingerprint(input.secret),
    });
    return await this.command(context, input.commandId, "credential_rotated", requestJson, async (tx) => {
      const credential = await this.requireCredential(tx, context.organizationId, input.credentialId);
      if (credential.version !== input.expectedVersion)
        throw new Error(`현재 Credential version은 ${String(credential.version)}입니다`);
      if (credential.status === "revoked") throw new Error("폐기된 Credential은 회전할 수 없습니다");
      const nextSecretVersion = credential.secret_version + 1;
      await this.insertSecret(tx, context, credential, nextSecretVersion, input.secret);
      await tx.query(
        "UPDATE provider_credential SET version = $version, secret_version = $secret_version, status = 'active', cooldown_until = NONE, updated_at = time::now() WHERE organization_id = $organization_id AND credential_id = $credential_id;",
        {
          version: credential.version + 1,
          secret_version: nextSecretVersion,
          organization_id: context.organizationId,
          credential_id: credential.credential_id,
        },
      );
      return {
        credential: {
          ...credential,
          version: credential.version + 1,
          secret_version: nextSecretVersion,
          status: "active",
        },
      };
    });
  }

  public async revokeCredential(
    context: TenantContext,
    input: RevokeCredentialInput,
  ): Promise<{ credential: ProviderCredential; audit: RouterAuditEvent }> {
    return await this.command(context, input.commandId, "credential_revoked", canonicalJson(input), async (tx) => {
      const credential = await this.requireCredential(tx, context.organizationId, input.credentialId);
      if (credential.version !== input.expectedVersion)
        throw new Error(`현재 Credential version은 ${String(credential.version)}입니다`);
      await tx.query(
        "UPDATE provider_credential SET version = $version, status = 'revoked', updated_at = time::now() WHERE organization_id = $organization_id AND credential_id = $credential_id;",
        {
          version: credential.version + 1,
          organization_id: context.organizationId,
          credential_id: credential.credential_id,
        },
      );
      return { credential: { ...credential, version: credential.version + 1, status: "revoked" } };
    });
  }

  public async updateCredentialQuota(
    context: TenantContext,
    input: UpdateCredentialQuotaInput,
  ): Promise<{ credential: ProviderCredential; audit: RouterAuditEvent }> {
    const resetAt = new Date(input.resetAt);
    if (
      !Number.isInteger(input.limit) ||
      !Number.isInteger(input.remaining) ||
      input.limit < 1 ||
      input.remaining < 0 ||
      input.remaining > input.limit ||
      !Number.isFinite(resetAt.getTime())
    ) {
      throw new Error("Credential quota 값이 유효하지 않습니다");
    }
    return await this.command(
      context,
      input.commandId,
      "credential_quota_updated",
      canonicalJson(input),
      async (tx) => {
        const credential = await this.requireCredential(tx, context.organizationId, input.credentialId);
        if (credential.version !== input.expectedVersion)
          throw new Error(`현재 Credential version은 ${String(credential.version)}입니다`);
        if (credential.status === "revoked") throw new Error("폐기된 Credential quota는 갱신할 수 없습니다");
        const [credentials] = await tx.query<[ProviderCredential[]]>(
          "UPDATE provider_credential SET version += 1, quota_limit = $quota_limit, quota_remaining = $quota_remaining, quota_reset_at = $quota_reset_at, status = IF status = 'cooldown' AND cooldown_until <= time::now() { 'active' } ELSE { status }, updated_at = time::now() WHERE organization_id = $organization_id AND credential_id = $credential_id RETURN AFTER;",
          {
            organization_id: context.organizationId,
            credential_id: credential.credential_id,
            quota_limit: input.limit,
            quota_remaining: input.remaining,
            quota_reset_at: resetAt,
          },
        );
        if (!credentials[0]) throw new Error("Credential quota 갱신 결과가 없습니다");
        return { credential: credentials[0] };
      },
    );
  }

  public async listCredentials(context: TenantContext, providerId?: string): Promise<ProviderCredential[]> {
    await this.organizations.verifyTenantContext(context);
    const [credentials] = await this.database.query<[ProviderCredential[]]>(
      "SELECT * OMIT id FROM provider_credential WHERE organization_id = $organization_id AND ($provider_id = NONE OR provider_id = $provider_id) ORDER BY label ASC;",
      { organization_id: context.organizationId, provider_id: providerId },
    );
    return credentials;
  }

  public async getProvider(context: TenantContext, providerId: string): Promise<ModelProvider> {
    await this.organizations.verifyTenantContext(context);
    return await this.requireProvider(this.database, context.organizationId, providerId);
  }

  public async revealSecret(context: TenantContext, credentialId: string): Promise<string> {
    await this.organizations.verifyTenantContext(context);
    const credential = await this.requireCredential(this.database, context.organizationId, credentialId);
    return await this.resolveExecutionSecret(context, credential, this.database);
  }

  public async resolveExecutionSecret(
    context: TenantContext,
    credential: ProviderCredential,
    executor: QueryExecutor,
  ): Promise<string> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    if (credential.organization_id !== context.organizationId || credential.status !== "active") {
      throw new Error("활성 Credential만 실행에 사용할 수 있습니다");
    }
    return await this.resolveExecutionSecretVersion(context, credential, credential.secret_version, executor);
  }

  public async resolveExecutionMaterial(
    context: TenantContext,
    credential: ProviderCredential,
    executor: QueryExecutor,
    secretVersion = credential.secret_version,
  ): Promise<CredentialMaterial> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    if (credential.organization_id !== context.organizationId || credential.status !== "active") {
      throw new Error("활성 Credential만 실행에 사용할 수 있습니다");
    }
    if (credential.material_kind === "connector_session") {
      const accountId = credential.subscription_account_id;
      const connectorId = credential.subscription_connector_id;
      const scope = credential.subscription_scope;
      if (!this.options.accounts || !accountId || !connectorId || !scope) {
        throw new Error("Connector Credential 구성이 불완전합니다");
      }
      const account = await this.options.accounts.requireUsable(context, accountId, scope, executor);
      if (account.connector_id !== connectorId) throw new Error("구독 계정과 Connector binding이 일치하지 않습니다");
      return { kind: "connector_session", accountId, connectorId };
    }
    const secret = await this.resolveExecutionSecretVersion(context, credential, secretVersion, executor);
    return { kind: "encrypted_secret", secret, secretVersion };
  }

  public async resolveExecutionSecretVersion(
    context: TenantContext,
    credential: ProviderCredential,
    secretVersion: number,
    executor: QueryExecutor,
  ): Promise<string> {
    await this.organizations.verifyTenantContext(context, undefined, executor);
    if (credential.organization_id !== context.organizationId || credential.status !== "active") {
      throw new Error("활성 Credential만 실행에 사용할 수 있습니다");
    }
    if (credential.material_kind === "connector_session") {
      throw new Error("Connector session Credential에는 복호화할 secret이 없습니다");
    }
    const secret = await this.requireSecret(executor, context.organizationId, credential, secretVersion);
    return this.vault.decrypt(
      { algorithm: "aes-256-gcm", ciphertext: secret.ciphertext, iv: secret.iv, authTag: secret.auth_tag },
      secret.aad,
    );
  }

  private async command<Payload extends object>(
    context: TenantContext,
    commandId: string,
    eventType: string,
    requestJson: string,
    operation: (executor: QueryExecutor) => Promise<Payload>,
  ): Promise<Payload & { audit: RouterAuditEvent }> {
    await this.organizations.verifyTenantContext(context, ["owner", "admin"]);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, ["owner", "admin"], tx);
      const [existing] = await tx.query<[RouterAuditEvent[]]>(
        "SELECT * OMIT id FROM router_audit_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
        { organization_id: context.organizationId, command_id: commandId },
      );
      if (existing[0]) {
        if (existing[0].request_json !== requestJson)
          throw new Error("같은 commandId에 다른 명령을 사용할 수 없습니다");
        return JSON.parse(existing[0].result_json) as Payload & { audit: RouterAuditEvent };
      }
      const payload = await operation(tx);
      const [events] = await tx.query<[RouterAuditEvent[]]>(
        "CREATE router_audit_event CONTENT { audit_event_id: $audit_event_id, organization_id: $organization_id, command_id: $command_id, event_type: $event_type, actor_user_id: $actor_user_id, request_json: $request_json, result_json: '{}', created_at: time::now() } RETURN AFTER;",
        {
          audit_event_id: randomUUID(),
          organization_id: context.organizationId,
          command_id: commandId,
          event_type: eventType,
          actor_user_id: context.userId,
          request_json: requestJson,
        },
      );
      const audit = events[0];
      if (!audit) throw new Error("Router audit event 생성 결과가 없습니다");
      const result = { ...payload, audit };
      await tx.query(
        "UPDATE router_audit_event SET result_json = $result_json WHERE audit_event_id = $audit_event_id;",
        {
          result_json: JSON.stringify(result),
          audit_event_id: audit.audit_event_id,
        },
      );
      return result;
    });
  }

  private async insertSecret(
    executor: QueryExecutor,
    context: TenantContext,
    credential: ProviderCredential,
    version: number,
    plaintext: string,
  ): Promise<void> {
    const aad = `${context.organizationId}:${credential.provider_id}:${credential.endpoint_id}:${credential.credential_id}:${String(version)}`;
    const encrypted = this.vault.encrypt(plaintext, aad);
    await executor.query(
      "CREATE credential_secret_version CONTENT { secret_version_id: $secret_version_id, organization_id: $organization_id, credential_id: $credential_id, version: $version, algorithm: $algorithm, ciphertext: $ciphertext, iv: $iv, auth_tag: $auth_tag, aad: $aad, created_by: $created_by, created_at: time::now() };",
      {
        secret_version_id: randomUUID(),
        organization_id: context.organizationId,
        credential_id: credential.credential_id,
        version,
        algorithm: encrypted.algorithm,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        auth_tag: encrypted.authTag,
        aad,
        created_by: context.userId,
      },
    );
  }

  private async requireProvider(
    executor: QueryExecutor,
    organizationId: string,
    providerId: string,
  ): Promise<ModelProvider> {
    const [providers] = await executor.query<[ModelProvider[]]>(
      "SELECT * OMIT id FROM model_provider WHERE organization_id = $organization_id AND provider_id = $provider_id AND enabled = true LIMIT 1;",
      { organization_id: organizationId, provider_id: providerId },
    );
    if (!providers[0]) throw new Error(`활성 Provider를 찾을 수 없습니다: ${providerId}`);
    return providers[0];
  }

  private async requireEndpoint(
    executor: QueryExecutor,
    organizationId: string,
    providerId: string,
    endpointId: string,
  ): Promise<ProviderEndpoint> {
    const [endpoints] = await executor.query<[ProviderEndpoint[]]>(
      "SELECT * OMIT id FROM provider_endpoint WHERE organization_id = $organization_id AND provider_id = $provider_id AND endpoint_id = $endpoint_id AND enabled = true LIMIT 1;",
      { organization_id: organizationId, provider_id: providerId, endpoint_id: endpointId },
    );
    if (!endpoints[0]) throw new Error(`활성 Provider Endpoint를 찾을 수 없습니다: ${endpointId}`);
    return endpoints[0];
  }

  private async requireCredential(
    executor: QueryExecutor,
    organizationId: string,
    credentialId: string,
  ): Promise<ProviderCredential> {
    const [credentials] = await executor.query<[ProviderCredential[]]>(
      "SELECT * OMIT id FROM provider_credential WHERE organization_id = $organization_id AND credential_id = $credential_id LIMIT 1;",
      { organization_id: organizationId, credential_id: credentialId },
    );
    if (!credentials[0]) throw new Error(`Credential을 찾을 수 없습니다: ${credentialId}`);
    return credentials[0];
  }

  private async requireSecret(
    executor: QueryExecutor,
    organizationId: string,
    credential: ProviderCredential,
    version = credential.secret_version,
  ): Promise<CredentialSecretVersion> {
    const [secrets] = await executor.query<[CredentialSecretVersion[]]>(
      "SELECT secret_version_id, organization_id, credential_id, version, algorithm, ciphertext, iv, auth_tag, aad, created_by, created_at FROM credential_secret_version WHERE organization_id = $organization_id AND credential_id = $credential_id AND version = $version LIMIT 1;",
      { organization_id: organizationId, credential_id: credential.credential_id, version },
    );
    if (!secrets[0]) throw new Error("Credential secret version을 찾을 수 없습니다");
    return secrets[0];
  }
}
