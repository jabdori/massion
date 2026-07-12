import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { type ApplicationCommandResultV1, type ApplicationCommandV1, validateApplicationResult } from "./contracts.js";
import type { ApplicationErrorV1 } from "./errors.js";
import { APPLICATION_COMMAND_MIGRATION } from "./schema.js";

type CommandState = "running" | "succeeded" | "accepted" | "awaiting-approval" | "blocked" | "failed";

interface CommandRecord {
  readonly command_record_id: string;
  readonly organization_id: string;
  readonly actor_user_id: string;
  readonly command_id: string;
  readonly correlation_id: string;
  readonly operation: string;
  readonly request_hash: string;
  readonly state: CommandState;
  readonly result_json?: string;
  readonly result_hash?: string;
  readonly error_json?: string;
  readonly error_hash?: string;
  readonly lease_generation: number;
  readonly lease_expires_at?: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface ApplicationCommandClock {
  readonly now: Date;
}

export type BeginApplicationCommandResult =
  | {
      readonly outcome: "claimed";
      readonly commandRecordId: string;
      readonly leaseGeneration: number;
      readonly recovered: boolean;
    }
  | { readonly outcome: "in-progress"; readonly commandRecordId: string; readonly leaseGeneration: number }
  | { readonly outcome: "replayed"; readonly result: ApplicationCommandResultV1 }
  | { readonly outcome: "failed"; readonly error: ApplicationErrorV1 };

export interface ApplicationCommandRecordView {
  readonly commandRecordId: string;
  readonly organizationId: string;
  readonly commandId: string;
  readonly correlationId: string;
  readonly operation: string;
  readonly state: CommandState;
  readonly leaseGeneration: number;
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

async function first<T>(
  executor: QueryExecutor,
  query: string,
  bindings: Record<string, unknown>,
): Promise<T | undefined> {
  const [records] = await executor.query<[T[]]>(query, bindings);
  return records[0];
}

function dateMillis(value: unknown): number {
  const parsed = value instanceof Date ? value : new Date(String(value));
  const result = parsed.getTime();
  if (Number.isNaN(result)) throw new Error("Application command lease datetime이 유효하지 않습니다");
  return result;
}

function parseResult(record: CommandRecord): ApplicationCommandResultV1 {
  if (!record.result_json || !record.result_hash || sha256(record.result_json) !== record.result_hash) {
    throw new Error("Application command result 계보가 유효하지 않습니다");
  }
  return validateApplicationResult(JSON.parse(record.result_json) as unknown);
}

function parseError(record: CommandRecord): ApplicationErrorV1 {
  if (!record.error_json || !record.error_hash || sha256(record.error_json) !== record.error_hash) {
    throw new Error("Application command error 계보가 유효하지 않습니다");
  }
  return JSON.parse(record.error_json) as ApplicationErrorV1;
}

export class ApplicationCommandStore {
  private readonly clock: ApplicationCommandClock;

  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly leaseMs: number,
    clock?: ApplicationCommandClock,
  ) {
    this.clock = clock ?? {
      get now() {
        return new Date();
      },
    };
  }

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    input: { readonly leaseMs?: number; readonly clock?: ApplicationCommandClock } = {},
  ): Promise<ApplicationCommandStore> {
    const leaseMs = input.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
      throw new Error("Application command lease 범위가 유효하지 않습니다");
    }
    await applyMigrations(database, [APPLICATION_COMMAND_MIGRATION]);
    return new ApplicationCommandStore(database, organizations, leaseMs, input.clock);
  }

  public async begin(
    context: TenantContext,
    command: ApplicationCommandV1,
    options: { readonly resumeAwaitingApproval?: boolean; readonly retryFailedCommand?: boolean } = {},
  ): Promise<BeginApplicationCommandResult> {
    await this.organizations.verifyTenantContext(context);
    const requestHash = sha256(canonicalJson(command));
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const existing = await first<CommandRecord>(
        transaction,
        "SELECT * OMIT id FROM application_command WHERE organization_id = $organization_id AND operation = $operation AND command_id = $command_id LIMIT 1;",
        { organization_id: context.organizationId, operation: command.operation, command_id: command.commandId },
      );
      if (existing) {
        if (existing.actor_user_id !== context.userId) {
          throw new Error("Application command는 원래 요청 사용자만 replay하거나 재개할 수 있습니다");
        }
        if (existing.request_hash !== requestHash) {
          throw new Error("같은 commandId에 다른 Application command payload를 사용할 수 없습니다");
        }
        if (existing.state === "failed") {
          if (!options.retryFailedCommand) return { outcome: "failed", error: parseError(existing) };
          const generation = existing.lease_generation + 1;
          const expiresAt = new Date(this.clock.now.getTime() + this.leaseMs).toISOString();
          await transaction.query(
            "UPDATE application_command SET state = 'running', error_json = NONE, error_hash = NONE, lease_generation = $lease_generation, lease_expires_at = <datetime>$lease_expires_at, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND command_record_id = $command_record_id AND state = 'failed' AND lease_generation = $previous_generation;",
            {
              organization_id: context.organizationId,
              command_record_id: existing.command_record_id,
              previous_generation: existing.lease_generation,
              lease_generation: generation,
              lease_expires_at: expiresAt,
              updated_at: this.clock.now.toISOString(),
            },
          );
          const reclaimed = await this.find(transaction, context.organizationId, existing.command_record_id);
          if (reclaimed.state !== "running" || reclaimed.lease_generation !== generation) {
            throw new Error("Application command 실패 재개 동시성 충돌입니다");
          }
          await this.event(
            transaction,
            context.organizationId,
            existing.command_record_id,
            generation,
            "reclaimed",
            requestHash,
          );
          return {
            outcome: "claimed",
            commandRecordId: existing.command_record_id,
            leaseGeneration: generation,
            recovered: true,
          };
        }
        if (existing.state === "awaiting-approval" && options.resumeAwaitingApproval) {
          const generation = existing.lease_generation + 1;
          const expiresAt = new Date(this.clock.now.getTime() + this.leaseMs).toISOString();
          await transaction.query(
            "UPDATE application_command SET state = 'running', lease_generation = $lease_generation, lease_expires_at = <datetime>$lease_expires_at, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND command_record_id = $command_record_id AND state = 'awaiting-approval' AND lease_generation = $previous_generation;",
            {
              organization_id: context.organizationId,
              command_record_id: existing.command_record_id,
              previous_generation: existing.lease_generation,
              lease_generation: generation,
              lease_expires_at: expiresAt,
              updated_at: this.clock.now.toISOString(),
            },
          );
          await this.event(
            transaction,
            context.organizationId,
            existing.command_record_id,
            generation,
            "reclaimed",
            requestHash,
          );
          return {
            outcome: "claimed",
            commandRecordId: existing.command_record_id,
            leaseGeneration: generation,
            recovered: false,
          };
        }
        if (existing.state !== "running") return { outcome: "replayed", result: parseResult(existing) };
        if (
          existing.lease_expires_at !== undefined &&
          dateMillis(existing.lease_expires_at) > this.clock.now.getTime()
        ) {
          return {
            outcome: "in-progress",
            commandRecordId: existing.command_record_id,
            leaseGeneration: existing.lease_generation,
          };
        }
        const generation = existing.lease_generation + 1;
        const expiresAt = new Date(this.clock.now.getTime() + this.leaseMs).toISOString();
        await transaction.query(
          "UPDATE application_command SET lease_generation = $lease_generation, lease_expires_at = <datetime>$lease_expires_at, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND command_record_id = $command_record_id AND state = 'running' AND lease_generation = $previous_generation;",
          {
            organization_id: context.organizationId,
            command_record_id: existing.command_record_id,
            previous_generation: existing.lease_generation,
            lease_generation: generation,
            lease_expires_at: expiresAt,
            updated_at: this.clock.now.toISOString(),
          },
        );
        const reclaimed = await this.find(transaction, context.organizationId, existing.command_record_id);
        if (reclaimed.state !== "running" || reclaimed.lease_generation !== generation) {
          throw new Error("Application command lease 회수 동시성 충돌입니다");
        }
        await this.event(
          transaction,
          context.organizationId,
          existing.command_record_id,
          generation,
          "reclaimed",
          requestHash,
        );
        return {
          outcome: "claimed",
          commandRecordId: existing.command_record_id,
          leaseGeneration: generation,
          recovered: true,
        };
      }
      const commandRecordId = randomUUID();
      const expiresAt = new Date(this.clock.now.getTime() + this.leaseMs).toISOString();
      await transaction.query(
        "CREATE application_command CONTENT { command_record_id: $command_record_id, organization_id: $organization_id, actor_user_id: $actor_user_id, command_id: $command_id, correlation_id: $correlation_id, operation: $operation, request_hash: $request_hash, state: 'running', result_json: NONE, result_hash: NONE, error_json: NONE, error_hash: NONE, lease_generation: 1, lease_expires_at: <datetime>$lease_expires_at, created_at: <datetime>$created_at, updated_at: <datetime>$created_at };",
        {
          command_record_id: commandRecordId,
          organization_id: context.organizationId,
          actor_user_id: context.userId,
          command_id: command.commandId,
          correlation_id: command.correlationId,
          operation: command.operation,
          request_hash: requestHash,
          lease_expires_at: expiresAt,
          created_at: this.clock.now.toISOString(),
        },
      );
      await this.event(transaction, context.organizationId, commandRecordId, 1, "claimed", requestHash);
      return { outcome: "claimed", commandRecordId, leaseGeneration: 1, recovered: false };
    });
  }

  public async complete(
    context: TenantContext,
    commandRecordId: string,
    leaseGeneration: number,
    result: ApplicationCommandResultV1,
  ): Promise<void> {
    const validated = validateApplicationResult(result);
    await this.organizations.verifyTenantContext(context);
    await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const record = await this.find(transaction, context.organizationId, commandRecordId);
      if (record.state !== "running" || record.lease_generation !== leaseGeneration) {
        throw new Error("Application command lease generation이 일치하지 않습니다");
      }
      if (
        validated.commandId !== record.command_id ||
        validated.correlationId !== record.correlation_id ||
        validated.operation !== record.operation
      ) {
        throw new Error("Application command result identity가 요청과 일치하지 않습니다");
      }
      const resultJson = canonicalJson(validated);
      const resultHash = sha256(resultJson);
      await transaction.query(
        "UPDATE application_command SET state = $state, result_json = $result_json, result_hash = $result_hash, lease_expires_at = NONE, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND command_record_id = $command_record_id AND state = 'running' AND lease_generation = $lease_generation;",
        {
          organization_id: context.organizationId,
          command_record_id: commandRecordId,
          lease_generation: leaseGeneration,
          state: validated.outcome,
          result_json: resultJson,
          result_hash: resultHash,
          updated_at: this.clock.now.toISOString(),
        },
      );
      const updated = await this.find(transaction, context.organizationId, commandRecordId);
      if (updated.state !== validated.outcome || updated.result_hash !== resultHash) {
        throw new Error("Application command 완료 동시성 충돌입니다");
      }
      await this.event(transaction, context.organizationId, commandRecordId, leaseGeneration, "completed", resultHash);
    });
  }

  public async fail(
    context: TenantContext,
    commandRecordId: string,
    leaseGeneration: number,
    error: ApplicationErrorV1,
  ): Promise<void> {
    await this.organizations.verifyTenantContext(context);
    const errorJson = canonicalJson(error);
    const errorHash = sha256(errorJson);
    await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const record = await this.find(transaction, context.organizationId, commandRecordId);
      if (record.state !== "running" || record.lease_generation !== leaseGeneration) {
        throw new Error("Application command lease generation이 일치하지 않습니다");
      }
      await transaction.query(
        "UPDATE application_command SET state = 'failed', error_json = $error_json, error_hash = $error_hash, lease_expires_at = NONE, updated_at = <datetime>$updated_at WHERE organization_id = $organization_id AND command_record_id = $command_record_id AND state = 'running' AND lease_generation = $lease_generation;",
        {
          organization_id: context.organizationId,
          command_record_id: commandRecordId,
          lease_generation: leaseGeneration,
          error_json: errorJson,
          error_hash: errorHash,
          updated_at: this.clock.now.toISOString(),
        },
      );
      await this.event(transaction, context.organizationId, commandRecordId, leaseGeneration, "failed", errorHash);
    });
  }

  public async get(context: TenantContext, commandRecordId: string): Promise<ApplicationCommandRecordView> {
    await this.organizations.verifyTenantContext(context);
    return this.view(await this.find(this.database, context.organizationId, commandRecordId));
  }

  private async find(executor: QueryExecutor, organizationId: string, commandRecordId: string): Promise<CommandRecord> {
    const record = await first<CommandRecord>(
      executor,
      "SELECT * OMIT id FROM application_command WHERE organization_id = $organization_id AND command_record_id = $command_record_id LIMIT 1;",
      { organization_id: organizationId, command_record_id: commandRecordId },
    );
    if (!record) throw new Error("Application command를 찾을 수 없습니다");
    return record;
  }

  private async event(
    executor: QueryExecutor,
    organizationId: string,
    commandRecordId: string,
    leaseGeneration: number,
    eventType: "claimed" | "reclaimed" | "completed" | "failed",
    detailHash: string,
  ): Promise<void> {
    await executor.query(
      "CREATE application_command_event CONTENT { event_id: $event_id, organization_id: $organization_id, command_record_id: $command_record_id, lease_generation: $lease_generation, event_type: $event_type, detail_hash: $detail_hash, created_at: <datetime>$created_at };",
      {
        event_id: randomUUID(),
        organization_id: organizationId,
        command_record_id: commandRecordId,
        lease_generation: leaseGeneration,
        event_type: eventType,
        detail_hash: detailHash,
        created_at: this.clock.now.toISOString(),
      },
    );
  }

  private view(record: CommandRecord): ApplicationCommandRecordView {
    return {
      commandRecordId: record.command_record_id,
      organizationId: record.organization_id,
      commandId: record.command_id,
      correlationId: record.correlation_id,
      operation: record.operation,
      state: record.state,
      leaseGeneration: record.lease_generation,
    };
  }
}
