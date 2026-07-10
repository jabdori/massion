import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import {
  SOFTWARE_ENGINEERING_DELIVERY_MIGRATION,
  SOFTWARE_ENGINEERING_PATH_LEASE_MIGRATION,
  SOFTWARE_ENGINEERING_ROOT_BINDING_MIGRATION,
  SOFTWARE_ENGINEERING_TDD_EVIDENCE_MIGRATION,
} from "./schema.js";

export type EngineeringPathLeaseStatus = "active" | "released" | "expired";

export interface EngineeringPathLease {
  readonly leaseId: string;
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly deliveryId: string;
  readonly pathPrefixes: readonly string[];
  readonly status: EngineeringPathLeaseStatus;
  readonly version: number;
  readonly expiresAt: unknown;
  readonly acquireCommandId: string;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
}

export interface AcquireEngineeringPathLeaseInput {
  readonly commandId: string;
  readonly deliveryId: string;
  readonly repositoryId: string;
  readonly pathPrefixes: readonly string[];
  readonly ttlMs: number;
}

export interface ReleaseEngineeringPathLeaseInput {
  readonly commandId: string;
  readonly leaseId: string;
  readonly deliveryId: string;
}

interface LeaseRecord {
  readonly lease_id: string;
  readonly organization_id: string;
  readonly repository_id: string;
  readonly delivery_id: string;
  readonly path_prefixes: readonly string[];
  readonly status: EngineeringPathLeaseStatus;
  readonly version: number;
  readonly expires_at: unknown;
  readonly acquire_command_id: string;
  readonly acquire_request_hash: string;
  readonly release_command_id?: string;
  readonly release_request_hash?: string;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface ClockRecord {
  readonly clock_key: string;
  readonly version: number;
}

interface DeliveryReferenceRecord {
  readonly repository_id: string;
  readonly status: string;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
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

function datetimeMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") return new Date(value).getTime();
  const serialized = JSON.stringify(value);
  if (!serialized) return Number.NaN;
  const parsed = JSON.parse(serialized) as unknown;
  return typeof parsed === "string" || typeof parsed === "number" ? new Date(parsed).getTime() : Number.NaN;
}

function isAncestorOrSame(left: string, right: string): boolean {
  return left === "." || left === right || right.startsWith(`${left}/`);
}

export function normalizeEngineeringPaths(paths: readonly string[]): string[] {
  if (paths.length === 0) throw new Error("하나 이상의 허용 경로가 필요합니다");
  const normalized = paths.map((candidate) => {
    const path = candidate.normalize("NFC");
    if (
      !path ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.includes("//") ||
      path.split("/").some((segment) => segment === ".." || segment === ".git")
    ) {
      throw new Error(`허용 경로가 안전한 repository 상대 경로가 아닙니다: ${candidate}`);
    }
    const withoutTrailingSlash = path === "." ? path : path.replace(/\/+$/u, "");
    if (
      !withoutTrailingSlash ||
      (withoutTrailingSlash !== "." && withoutTrailingSlash.split("/").some((segment) => segment === "."))
    ) {
      throw new Error(`허용 경로가 모호합니다: ${candidate}`);
    }
    return withoutTrailingSlash;
  });
  const unique = [...new Set(normalized)].sort();
  return unique.filter(
    (candidate, index) => !unique.slice(0, index).some((parent) => isAncestorOrSame(parent, candidate)),
  );
}

export function pathsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((leftPath) =>
    right.some((rightPath) => isAncestorOrSame(leftPath, rightPath) || isAncestorOrSame(rightPath, leftPath)),
  );
}

export class EngineeringPathLeaseStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly now: () => Date,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    options: { readonly now?: () => Date } = {},
  ): Promise<EngineeringPathLeaseStore> {
    await applyMigrations(database, [
      SOFTWARE_ENGINEERING_DELIVERY_MIGRATION,
      SOFTWARE_ENGINEERING_PATH_LEASE_MIGRATION,
      SOFTWARE_ENGINEERING_TDD_EVIDENCE_MIGRATION,
      SOFTWARE_ENGINEERING_ROOT_BINDING_MIGRATION,
    ]);
    return new EngineeringPathLeaseStore(database, organizations, options.now ?? (() => new Date()));
  }

  public async acquire(
    context: TenantContext,
    input: AcquireEngineeringPathLeaseInput,
  ): Promise<{ readonly lease: EngineeringPathLease }> {
    await this.organizations.verifyTenantContext(context);
    if (!input.commandId.trim() || !input.deliveryId.trim() || !input.repositoryId.trim()) {
      throw new Error("Path lease command, delivery와 repository가 필요합니다");
    }
    if (!Number.isInteger(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > 86_400_000) {
      throw new Error("Path lease TTL은 1ms 이상 24시간 이하여야 합니다");
    }
    const pathPrefixes = normalizeEngineeringPaths(input.pathPrefixes);
    const requestHash = sha256(canonicalJson({ ...input, pathPrefixes }));
    const replayed = await this.findByAcquireCommand(this.database, context.organizationId, input.commandId);
    if (replayed) return { lease: this.replayAcquire(replayed, requestHash) };
    await this.verifyDelivery(this.database, context.organizationId, input.deliveryId, input.repositoryId);
    await this.ensureClock(context.organizationId, input.repositoryId);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + input.ttlMs);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.database.transaction(async (transaction) => {
          await this.organizations.verifyTenantContext(context, undefined, transaction);
          const concurrentReplay = await this.findByAcquireCommand(
            transaction,
            context.organizationId,
            input.commandId,
          );
          if (concurrentReplay) return { lease: this.replayAcquire(concurrentReplay, requestHash) };
          await this.verifyDelivery(transaction, context.organizationId, input.deliveryId, input.repositoryId);
          await this.advanceClock(transaction, context.organizationId, input.repositoryId);
          const records = await this.listRecords(transaction, context.organizationId, input.repositoryId);
          for (const record of records) {
            if (record.status === "active" && datetimeMillis(record.expires_at) <= now.getTime()) {
              await transaction.query(
                "UPDATE engineering_path_lease SET status = 'expired', version = $version, updated_at = time::now() WHERE organization_id = $organization_id AND lease_id = $lease_id AND version = $expected_version;",
                {
                  version: record.version + 1,
                  expected_version: record.version,
                  organization_id: context.organizationId,
                  lease_id: record.lease_id,
                },
              );
            }
          }
          const active = records.filter(
            (record) => record.status === "active" && datetimeMillis(record.expires_at) > now.getTime(),
          );
          if (active.some((record) => pathsOverlap(record.path_prefixes, pathPrefixes))) {
            throw new Error("요청한 Engineering path가 기존 active lease와 겹칩니다");
          }
          const [created] = await transaction.query<[LeaseRecord[]]>(
            "CREATE engineering_path_lease CONTENT { lease_id: $lease_id, organization_id: $organization_id, repository_id: $repository_id, delivery_id: $delivery_id, path_prefixes: $path_prefixes, status: 'active', version: 1, expires_at: type::datetime($expires_at), acquire_command_id: $acquire_command_id, acquire_request_hash: $acquire_request_hash, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
            {
              lease_id: randomUUID(),
              organization_id: context.organizationId,
              repository_id: input.repositoryId,
              delivery_id: input.deliveryId,
              path_prefixes: pathPrefixes,
              expires_at: expiresAt.toISOString(),
              acquire_command_id: input.commandId,
              acquire_request_hash: requestHash,
            },
          );
          if (!created[0]) throw new Error("EngineeringPathLease 생성 결과가 없습니다");
          return { lease: this.view(created[0]) };
        });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "Engineering path lease clock 충돌입니다" || attempt === 3) {
          throw error;
        }
      }
    }
    throw new Error("Engineering path lease 획득 재시도 한도를 초과했습니다");
  }

  public async release(
    context: TenantContext,
    input: ReleaseEngineeringPathLeaseInput,
  ): Promise<{ readonly lease: EngineeringPathLease }> {
    await this.organizations.verifyTenantContext(context);
    const requestHash = sha256(canonicalJson(input));
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const record = await this.find(transaction, context.organizationId, input.leaseId);
      if (record.release_command_id) {
        if (record.release_command_id !== input.commandId || record.release_request_hash !== requestHash) {
          throw new Error("같은 path lease release에 다른 명령을 사용할 수 없습니다");
        }
        return { lease: this.view(record) };
      }
      if (record.delivery_id !== input.deliveryId) throw new Error("Path lease의 Delivery 소유 계보가 다릅니다");
      if (record.status !== "active") throw new Error(`active path lease만 해제할 수 있습니다: ${record.status}`);
      const [updated] = await transaction.query<[LeaseRecord[]]>(
        "UPDATE engineering_path_lease SET status = 'released', version = $version, release_command_id = $release_command_id, release_request_hash = $release_request_hash, updated_at = time::now() WHERE organization_id = $organization_id AND lease_id = $lease_id AND version = $expected_version RETURN AFTER;",
        {
          version: record.version + 1,
          release_command_id: input.commandId,
          release_request_hash: requestHash,
          organization_id: context.organizationId,
          lease_id: input.leaseId,
          expected_version: record.version,
        },
      );
      if (!updated[0]) throw new Error("Engineering path lease version 충돌입니다");
      return { lease: this.view(updated[0]) };
    });
  }

  public async list(context: TenantContext, repositoryId: string): Promise<EngineeringPathLease[]> {
    await this.organizations.verifyTenantContext(context);
    return (await this.listRecords(this.database, context.organizationId, repositoryId)).map((record) =>
      this.view(record),
    );
  }

  private async ensureClock(organizationId: string, repositoryId: string): Promise<void> {
    const clockKey = sha256(`${organizationId}:${repositoryId}`);
    const existing = await this.findClock(this.database, clockKey);
    if (existing) return;
    try {
      await this.database.query(
        "CREATE engineering_repository_lease_clock CONTENT { clock_key: $clock_key, organization_id: $organization_id, repository_id: $repository_id, version: 1, updated_at: time::now() };",
        { clock_key: clockKey, organization_id: organizationId, repository_id: repositoryId },
      );
    } catch (error) {
      if (!(await this.findClock(this.database, clockKey))) throw error;
    }
  }

  private async advanceClock(executor: QueryExecutor, organizationId: string, repositoryId: string): Promise<void> {
    const clockKey = sha256(`${organizationId}:${repositoryId}`);
    const current = await this.findClock(executor, clockKey);
    if (!current) throw new Error("Engineering path lease clock을 찾을 수 없습니다");
    const [updated] = await executor.query<[ClockRecord[]]>(
      "UPDATE engineering_repository_lease_clock SET version = $version, updated_at = time::now() WHERE clock_key = $clock_key AND version = $expected_version RETURN AFTER;",
      { clock_key: clockKey, expected_version: current.version, version: current.version + 1 },
    );
    if (!updated[0]) throw new Error("Engineering path lease clock 충돌입니다");
  }

  private async findClock(executor: QueryExecutor, clockKey: string): Promise<ClockRecord | undefined> {
    const [records] = await executor.query<[ClockRecord[]]>(
      "SELECT clock_key, version FROM engineering_repository_lease_clock WHERE clock_key = $clock_key LIMIT 1;",
      { clock_key: clockKey },
    );
    return records[0];
  }

  private async verifyDelivery(
    executor: QueryExecutor,
    organizationId: string,
    deliveryId: string,
    repositoryId: string,
  ): Promise<void> {
    const [records] = await executor.query<[DeliveryReferenceRecord[]]>(
      "SELECT repository_id, status FROM engineering_delivery WHERE organization_id = $organization_id AND delivery_id = $delivery_id LIMIT 1;",
      { organization_id: organizationId, delivery_id: deliveryId },
    );
    const delivery = records[0];
    if (!delivery || delivery.repository_id !== repositoryId) {
      throw new Error("Path lease의 Delivery와 Repository 소유 계보가 다릅니다");
    }
    if (["committed", "failed", "cancelled"].includes(delivery.status)) {
      throw new Error(`terminal Delivery에는 path lease를 획득할 수 없습니다: ${delivery.status}`);
    }
  }

  private async findByAcquireCommand(
    executor: QueryExecutor,
    organizationId: string,
    commandId: string,
  ): Promise<LeaseRecord | undefined> {
    const [records] = await executor.query<[LeaseRecord[]]>(
      "SELECT * OMIT id FROM engineering_path_lease WHERE organization_id = $organization_id AND acquire_command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    return records[0];
  }

  private replayAcquire(record: LeaseRecord, requestHash: string): EngineeringPathLease {
    if (record.acquire_request_hash !== requestHash) {
      throw new Error("같은 command ID에 다른 path lease 명령을 사용할 수 없습니다");
    }
    return this.view(record);
  }

  private async find(executor: QueryExecutor, organizationId: string, leaseId: string): Promise<LeaseRecord> {
    const [records] = await executor.query<[LeaseRecord[]]>(
      "SELECT * OMIT id FROM engineering_path_lease WHERE organization_id = $organization_id AND lease_id = $lease_id LIMIT 1;",
      { organization_id: organizationId, lease_id: leaseId },
    );
    if (!records[0]) throw new Error(`EngineeringPathLease를 찾을 수 없습니다: ${leaseId}`);
    return records[0];
  }

  private async listRecords(
    executor: QueryExecutor,
    organizationId: string,
    repositoryId: string,
  ): Promise<LeaseRecord[]> {
    const [records] = await executor.query<[LeaseRecord[]]>(
      "SELECT * OMIT id FROM engineering_path_lease WHERE organization_id = $organization_id AND repository_id = $repository_id ORDER BY created_at ASC;",
      { organization_id: organizationId, repository_id: repositoryId },
    );
    return records;
  }

  private view(record: LeaseRecord): EngineeringPathLease {
    return {
      leaseId: record.lease_id,
      organizationId: record.organization_id,
      repositoryId: record.repository_id,
      deliveryId: record.delivery_id,
      pathPrefixes: record.path_prefixes,
      status: record.status,
      version: record.version,
      expiresAt: record.expires_at,
      acquireCommandId: record.acquire_command_id,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
    };
  }
}
