import { randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase } from "@massion/storage";

import { normalizePackageIdentity } from "./contracts.js";
import { REGISTRY_MIGRATIONS } from "./schema.js";

interface EventRecord {
  event_id: string;
  source_id: string;
  event_type: string;
  outcome: string;
  package_name: string;
  package_version: string;
  created_at: string | Date;
}

export class RegistryTelemetryStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}
  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
  ): Promise<RegistryTelemetryStore> {
    await applyMigrations(database, REGISTRY_MIGRATIONS);
    return new RegistryTelemetryStore(database, organizations);
  }

  public async record(
    context: TenantContext,
    input: {
      readonly sourceId: string;
      readonly eventType: string;
      readonly outcome: string;
      readonly packageName: string;
      readonly packageVersion: string;
      readonly metricName: string;
      readonly value?: number;
    },
  ): Promise<void> {
    await this.organizations.verifyTenantContext(context);
    normalizePackageIdentity(input.packageName, input.packageVersion);
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(input.sourceId) ||
      !/^registry\.[a-z][a-z0-9.-]{1,96}$/u.test(input.eventType) ||
      !/^registry_[a-z0-9_]{1,96}$/u.test(input.metricName) ||
      !/^[a-z][a-z0-9-]{1,31}$/u.test(input.outcome) ||
      !Number.isFinite(input.value ?? 1) ||
      (input.value ?? 1) < 0
    )
      throw new Error("Registry telemetry input이 유효하지 않습니다");
    await this.database.transaction(async (tx) => {
      const [existing] = await tx.query<[EventRecord[]]>(
        "SELECT * OMIT id FROM registry_event WHERE organization_id=$organization_id AND source_id=$source_id AND event_type=$event_type LIMIT 1;",
        { organization_id: context.organizationId, source_id: input.sourceId, event_type: input.eventType },
      );
      if (existing.length > 0) return;
      await tx.query(
        "CREATE registry_event CONTENT { event_id:$event_id, organization_id:$organization_id, source_id:$source_id, event_type:$event_type, outcome:$outcome, package_name:$package_name, package_version:$package_version, created_at:time::now() }; CREATE registry_metric CONTENT { metric_id:$metric_id, organization_id:$organization_id, source_id:$source_id, metric_name:$metric_name, outcome:$outcome, value:$value, created_at:time::now() };",
        {
          event_id: randomUUID(),
          metric_id: randomUUID(),
          organization_id: context.organizationId,
          source_id: input.sourceId,
          event_type: input.eventType,
          outcome: input.outcome,
          package_name: input.packageName,
          package_version: input.packageVersion,
          metric_name: input.metricName,
          value: input.value ?? 1,
        },
      );
    });
  }

  public async list(context: TenantContext): Promise<readonly unknown[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[EventRecord[]]>(
      "SELECT * OMIT id FROM registry_event WHERE organization_id=$organization_id ORDER BY created_at DESC LIMIT 1000;",
      { organization_id: context.organizationId },
    );
    return records.map((record) => ({
      eventId: record.event_id,
      sourceId: record.source_id,
      eventType: record.event_type,
      outcome: record.outcome,
      packageName: record.package_name,
      packageVersion: record.package_version,
      createdAt: new Date(record.created_at).toISOString(),
    }));
  }
}
