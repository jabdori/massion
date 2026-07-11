import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase } from "@massion/storage";

import { APPLICATION_OUTBOX_MIGRATION } from "./schema.js";

export interface ApplicationOutboxView {
  readonly outboxId: string;
  readonly organizationId: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly aggregateId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly occurredAt: unknown;
  readonly state: "pending" | "projected";
}

interface OutboxRecord {
  readonly outbox_id: string;
  readonly organization_id: string;
  readonly source_kind: string;
  readonly source_id: string;
  readonly aggregate_id?: string;
  readonly correlation_id?: string;
  readonly causation_id?: string;
  readonly occurred_at: unknown;
  readonly state: "pending" | "projected";
}

export class ApplicationOutbox {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
  ): Promise<ApplicationOutbox> {
    await applyMigrations(database, [APPLICATION_OUTBOX_MIGRATION]);
    return new ApplicationOutbox(database, organizations);
  }

  public async listPending(context: TenantContext, limit: number): Promise<readonly ApplicationOutboxView[]> {
    await this.organizations.verifyTenantContext(context);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
      throw new Error("Application outbox limit이 유효하지 않습니다");
    const [records] = await this.database.query<[OutboxRecord[]]>(
      "SELECT * OMIT id FROM application_outbox WHERE organization_id = $organization_id AND state = 'pending' ORDER BY occurred_at ASC, outbox_id ASC LIMIT $limit;",
      { organization_id: context.organizationId, limit },
    );
    return records.map((record) => ({
      outboxId: record.outbox_id,
      organizationId: record.organization_id,
      sourceKind: record.source_kind,
      sourceId: record.source_id,
      ...(record.aggregate_id === undefined ? {} : { aggregateId: record.aggregate_id }),
      ...(record.correlation_id === undefined ? {} : { correlationId: record.correlation_id }),
      ...(record.causation_id === undefined ? {} : { causationId: record.causation_id }),
      occurredAt: record.occurred_at,
      state: record.state,
    }));
  }
}
