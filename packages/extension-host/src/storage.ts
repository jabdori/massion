import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { EXTENSION_MIGRATIONS } from "./schema.js";

interface StorageRecord {
  readonly organization_id: string;
  readonly installation_id: string;
  readonly storage_key: string;
  readonly value_json: string;
  readonly value_bytes: number;
  readonly version: number;
  readonly checksum: string;
}

interface StorageEventRecord {
  readonly payload_json: string;
}

export interface ExtensionStorageValue {
  readonly installationId: string;
  readonly key: string;
  readonly value: unknown;
  readonly version: number;
  readonly checksum: string;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function first<T>(
  executor: QueryExecutor,
  query: string,
  bindings: Record<string, unknown>,
): Promise<T | undefined> {
  const [records] = await executor.query<[T[]]>(query, bindings);
  return records[0];
}

export class ExtensionStorageService {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
  ): Promise<ExtensionStorageService> {
    await applyMigrations(database, EXTENSION_MIGRATIONS);
    return new ExtensionStorageService(database, organizations);
  }

  public async put(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly installationId: string;
      readonly versionId: string;
      readonly key: string;
      readonly value: unknown;
      readonly expectedVersion?: number;
      readonly quotaBytes: number;
      readonly maxValueBytes: number;
    },
  ): Promise<ExtensionStorageValue> {
    await this.organizations.verifyTenantContext(context);
    this.validateKey(input.key);
    const valueJson = canonicalJson(input.value);
    const valueBytes = Buffer.byteLength(valueJson, "utf8");
    if (valueBytes > input.maxValueBytes) throw new Error("Extension storage value byte 상한을 초과했습니다");
    const requestHash = sha256(
      canonicalJson({
        expectedVersion: input.expectedVersion ?? null,
        installationId: input.installationId,
        key: input.key,
        maxValueBytes: input.maxValueBytes,
        quotaBytes: input.quotaBytes,
        valueChecksum: sha256(valueJson),
        versionId: input.versionId,
      }),
    );
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      await this.assertInstallation(transaction, context.organizationId, input.installationId, input.versionId);
      const repeated = await first<StorageEventRecord>(
        transaction,
        "SELECT payload_json FROM extension_event WHERE organization_id = $organization_id AND command_id = $command_id AND event_type = 'storage_written' LIMIT 1;",
        { organization_id: context.organizationId, command_id: input.commandId },
      );
      if (repeated) {
        const payload = JSON.parse(repeated.payload_json) as { requestHash: string; result: ExtensionStorageValue };
        if (payload.requestHash !== requestHash)
          throw new Error("같은 commandId에 다른 Extension storage 요청을 사용할 수 없습니다");
        return payload.result;
      }
      const current = await first<StorageRecord>(
        transaction,
        "SELECT * OMIT id FROM extension_storage WHERE organization_id = $organization_id AND installation_id = $installation_id AND storage_key = $storage_key LIMIT 1;",
        {
          organization_id: context.organizationId,
          installation_id: input.installationId,
          storage_key: input.key,
        },
      );
      if (current) {
        if (input.expectedVersion !== current.version)
          throw new Error("Extension storage version precondition이 일치하지 않습니다");
      } else if (input.expectedVersion !== undefined) {
        throw new Error("Extension storage version precondition이 일치하지 않습니다");
      }
      const [all] = await transaction.query<[Array<{ value_bytes: number; storage_key: string }>]>(
        "SELECT value_bytes, storage_key FROM extension_storage WHERE organization_id = $organization_id AND installation_id = $installation_id;",
        { organization_id: context.organizationId, installation_id: input.installationId },
      );
      const used = all.reduce(
        (total, record) => total + (record.storage_key === input.key ? 0 : record.value_bytes),
        0,
      );
      if (used + valueBytes > input.quotaBytes) throw new Error("Extension storage quota를 초과했습니다");
      const version = (current?.version ?? 0) + 1;
      const checksum = sha256(valueJson);
      if (current) {
        await transaction.query(
          "UPDATE extension_storage SET value_json = $value_json, value_bytes = $value_bytes, version = $version, checksum = $checksum, updated_at = time::now() WHERE organization_id = $organization_id AND installation_id = $installation_id AND storage_key = $storage_key AND version = $expected_version;",
          {
            organization_id: context.organizationId,
            installation_id: input.installationId,
            storage_key: input.key,
            value_json: valueJson,
            value_bytes: valueBytes,
            version,
            checksum,
            expected_version: current.version,
          },
        );
      } else {
        await transaction.query(
          "CREATE extension_storage CONTENT { organization_id: $organization_id, installation_id: $installation_id, storage_key: $storage_key, value_json: $value_json, value_bytes: $value_bytes, version: 1, checksum: $checksum, updated_at: time::now() };",
          {
            organization_id: context.organizationId,
            installation_id: input.installationId,
            storage_key: input.key,
            value_json: valueJson,
            value_bytes: valueBytes,
            checksum,
          },
        );
      }
      const result: ExtensionStorageValue = {
        installationId: input.installationId,
        key: input.key,
        value: structuredClone(input.value),
        version,
        checksum,
      };
      const payloadJson = canonicalJson({ requestHash, result });
      await transaction.query(
        "CREATE extension_event CONTENT { event_id: $event_id, organization_id: $organization_id, installation_id: $installation_id, version_id: $version_id, activation_id: NONE, command_id: $command_id, event_type: 'storage_written', payload_json: $payload_json, payload_hash: $payload_hash, created_at: time::now() };",
        {
          event_id: randomUUID(),
          organization_id: context.organizationId,
          installation_id: input.installationId,
          version_id: input.versionId,
          command_id: input.commandId,
          payload_json: payloadJson,
          payload_hash: sha256(payloadJson),
        },
      );
      return result;
    });
  }

  public async get(context: TenantContext, installationId: string, key: string): Promise<ExtensionStorageValue> {
    await this.organizations.verifyTenantContext(context);
    this.validateKey(key);
    await this.assertInstallation(this.database, context.organizationId, installationId);
    const record = await first<StorageRecord>(
      this.database,
      "SELECT * OMIT id FROM extension_storage WHERE organization_id = $organization_id AND installation_id = $installation_id AND storage_key = $storage_key LIMIT 1;",
      { organization_id: context.organizationId, installation_id: installationId, storage_key: key },
    );
    if (!record) throw new Error("Extension storage 값을 찾을 수 없습니다");
    return this.view(record);
  }

  public async list(
    context: TenantContext,
    installationId: string,
    limit = 100,
  ): Promise<readonly ExtensionStorageValue[]> {
    await this.organizations.verifyTenantContext(context);
    await this.assertInstallation(this.database, context.organizationId, installationId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Extension storage list limit이 유효하지 않습니다");
    const [records] = await this.database.query<[StorageRecord[]]>(
      "SELECT * OMIT id FROM extension_storage WHERE organization_id = $organization_id AND installation_id = $installation_id ORDER BY storage_key ASC LIMIT $limit;",
      { organization_id: context.organizationId, installation_id: installationId, limit },
    );
    return records.map((record) => this.view(record));
  }

  private async assertInstallation(
    executor: QueryExecutor,
    organizationId: string,
    installationId: string,
    versionId?: string,
  ): Promise<void> {
    const installation = await first<{ installation_id: string }>(
      executor,
      "SELECT installation_id FROM extension_installation WHERE organization_id = $organization_id AND installation_id = $installation_id LIMIT 1;",
      { organization_id: organizationId, installation_id: installationId },
    );
    if (!installation) throw new Error("Extension installation을 찾을 수 없습니다");
    if (versionId) {
      const version = await first<{ version_id: string }>(
        executor,
        "SELECT version_id FROM extension_version WHERE organization_id = $organization_id AND installation_id = $installation_id AND version_id = $version_id LIMIT 1;",
        { organization_id: organizationId, installation_id: installationId, version_id: versionId },
      );
      if (!version) throw new Error("Extension version을 찾을 수 없습니다");
    }
  }

  private validateKey(key: string): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(key)) throw new Error("Extension storage key가 유효하지 않습니다");
  }

  private view(record: StorageRecord): ExtensionStorageValue {
    if (sha256(record.value_json) !== record.checksum)
      throw new Error("Extension storage checksum이 일치하지 않습니다");
    return {
      installationId: record.installation_id,
      key: record.storage_key,
      value: JSON.parse(record.value_json) as unknown,
      version: record.version,
      checksum: record.checksum,
    };
  }
}
