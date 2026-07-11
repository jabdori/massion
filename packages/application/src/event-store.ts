import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { APPLICATION_EVENT_SCHEMA_VERSION, type ApplicationEventV1, validateApplicationEvent } from "./contracts.js";
import { APPLICATION_EVENT_MIGRATION } from "./schema.js";

interface EventRecord {
  readonly event_id: string;
  readonly organization_id: string;
  readonly sequence: number;
  readonly event_type: string;
  readonly author_kind: "user" | "agent" | "system";
  readonly author_id: string;
  readonly correlation_id?: string;
  readonly causation_id?: string;
  readonly resource_type?: string;
  readonly resource_id?: string;
  readonly resource_revision?: number;
  readonly occurred_at: unknown;
  readonly payload_json: string;
  readonly payload_hash: string;
}

interface StreamRecord {
  readonly current_sequence: number;
  readonly retention_floor: number;
}

export class ApplicationEventCursorExpiredError extends Error {
  public constructor(public readonly retentionFloor: number) {
    super("Application event cursor가 retention 아래여서 snapshot이 필요합니다");
  }
}

export class ApplicationEventBuffer {
  private readonly values: Array<{ readonly sequence: number; readonly body: string; readonly bytes: number }> = [];
  private bytes = 0;

  public constructor(private readonly limits: { readonly maxEvents: number; readonly maxBytes: number }) {
    if (limits.maxEvents < 1 || limits.maxEvents > 1_000)
      throw new Error("Application event buffer event 상한이 유효하지 않습니다");
    if (limits.maxBytes < 1 || limits.maxBytes > 4 * 1024 * 1024)
      throw new Error("Application event buffer byte 상한이 유효하지 않습니다");
  }

  public enqueue(value: { readonly sequence: number; readonly body: string }): void {
    const bytes = Buffer.byteLength(value.body, "utf8");
    if (this.values.length + 1 > this.limits.maxEvents)
      throw new Error("Application event buffer event 상한을 초과했습니다");
    if (this.bytes + bytes > this.limits.maxBytes) throw new Error("Application event buffer byte 상한을 초과했습니다");
    this.values.push({ ...value, bytes });
    this.bytes += bytes;
  }

  public dequeue(): { readonly sequence: number; readonly body: string } | undefined {
    const value = this.values.shift();
    if (!value) return undefined;
    this.bytes -= value.bytes;
    return { sequence: value.sequence, body: value.body };
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

async function stream(executor: QueryExecutor, organizationId: string): Promise<StreamRecord | undefined> {
  const [records] = await executor.query<[StreamRecord[]]>(
    "SELECT current_sequence, retention_floor FROM application_event_stream WHERE organization_id = $organization_id LIMIT 1;",
    { organization_id: organizationId },
  );
  return records[0];
}

export class ApplicationEventStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
  ): Promise<ApplicationEventStore> {
    await applyMigrations(database, [APPLICATION_EVENT_MIGRATION]);
    return new ApplicationEventStore(database, organizations);
  }

  public async read(
    context: TenantContext,
    input: { readonly after: number; readonly limit: number },
  ): Promise<{
    readonly events: readonly ApplicationEventV1[];
    readonly cursor: number;
    readonly snapshotRequired: false;
  }> {
    await this.organizations.verifyTenantContext(context);
    if (!Number.isSafeInteger(input.after) || input.after < 0)
      throw new Error("Application event cursor가 유효하지 않습니다");
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000)
      throw new Error("Application event limit이 유효하지 않습니다");
    const state = await stream(this.database, context.organizationId);
    const minimumCursor = Math.max(0, (state?.retention_floor ?? 0) - 1);
    if (input.after > 0 && input.after < minimumCursor) {
      throw new ApplicationEventCursorExpiredError(state?.retention_floor ?? 0);
    }
    const effectiveAfter = input.after === 0 ? minimumCursor : input.after;
    const [records] = await this.database.query<[EventRecord[]]>(
      "SELECT * OMIT id, source_kind, source_id FROM application_event WHERE organization_id = $organization_id AND sequence > $after ORDER BY sequence ASC LIMIT $limit;",
      { organization_id: context.organizationId, after: effectiveAfter, limit: input.limit },
    );
    const events = records.map((record) => this.event(record));
    return { events, cursor: events.at(-1)?.sequence ?? input.after, snapshotRequired: false };
  }

  public async appendSystemEvents(context: TenantContext, types: readonly string[]): Promise<void> {
    await this.organizations.verifyTenantContext(context);
    for (const type of types) {
      if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u.test(type)) {
        throw new Error("Application system event type이 유효하지 않습니다");
      }
      await this.database.transaction(async (transaction) => {
        const sequence = await this.nextSequence(transaction, context.organizationId);
        const payloadJson = "{}";
        await transaction.query(
          "CREATE application_event CONTENT { event_id: $event_id, organization_id: $organization_id, sequence: $sequence, source_kind: 'system', source_id: $source_id, event_type: $event_type, author_kind: 'system', author_id: 'application', correlation_id: NONE, causation_id: NONE, resource_type: NONE, resource_id: NONE, resource_revision: NONE, occurred_at: time::now(), payload_json: $payload_json, payload_hash: $payload_hash };",
          {
            event_id: randomUUID(),
            organization_id: context.organizationId,
            sequence,
            source_id: randomUUID(),
            event_type: type,
            payload_json: payloadJson,
            payload_hash: sha256(payloadJson),
          },
        );
      });
    }
  }

  public async advanceRetention(context: TenantContext, floor: number): Promise<void> {
    await this.organizations.verifyTenantContext(context, ["owner", "admin"]);
    const state = await stream(this.database, context.organizationId);
    if (!state || !Number.isSafeInteger(floor) || floor < state.retention_floor || floor > state.current_sequence) {
      throw new Error("Application event retention floor가 유효하지 않습니다");
    }
    await this.database.query(
      "UPDATE application_event_stream SET retention_floor = $retention_floor, updated_at = time::now() WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId, retention_floor: floor },
    );
  }

  private async nextSequence(executor: QueryExecutor, organizationId: string): Promise<number> {
    const current = await stream(executor, organizationId);
    const sequence = (current?.current_sequence ?? 0) + 1;
    if (!current) {
      await executor.query(
        "CREATE application_event_stream CONTENT { organization_id: $organization_id, current_sequence: $sequence, retention_floor: 0, updated_at: time::now() };",
        { organization_id: organizationId, sequence },
      );
    } else {
      await executor.query(
        "UPDATE application_event_stream SET current_sequence = $sequence, updated_at = time::now() WHERE organization_id = $organization_id AND current_sequence = $previous_sequence;",
        { organization_id: organizationId, sequence, previous_sequence: current.current_sequence },
      );
    }
    return sequence;
  }

  private event(record: EventRecord): ApplicationEventV1 {
    if (sha256(record.payload_json) !== record.payload_hash)
      throw new Error("Application event payload hash가 일치하지 않습니다");
    return validateApplicationEvent({
      schemaVersion: APPLICATION_EVENT_SCHEMA_VERSION,
      eventId: record.event_id,
      organizationId: record.organization_id,
      sequence: record.sequence,
      type: record.event_type,
      author: { kind: record.author_kind, id: record.author_id },
      ...(record.correlation_id === undefined ? {} : { correlationId: record.correlation_id }),
      ...(record.causation_id === undefined ? {} : { causationId: record.causation_id }),
      ...(record.resource_type === undefined || record.resource_id === undefined
        ? {}
        : {
            resource: {
              type: record.resource_type,
              id: record.resource_id,
              ...(record.resource_revision === undefined ? {} : { revision: record.resource_revision }),
            },
          }),
      occurredAt: iso(record.occurred_at),
      payload: JSON.parse(record.payload_json) as unknown,
    });
  }
}
