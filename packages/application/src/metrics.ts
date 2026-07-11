import { randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase } from "@massion/storage";

import { APPLICATION_METRIC_MIGRATION } from "./schema.js";

export type ApplicationMetricName =
  | "application_request_total"
  | "application_request_duration_ms"
  | "application_command_total"
  | "application_event_projection_total"
  | "application_event_lag_ms"
  | "application_stream_total"
  | "application_stream_backpressure_total"
  | "application_run_total"
  | "cli_command_total";

const DIMENSIONS: Readonly<Record<ApplicationMetricName, readonly string[]>> = {
  application_request_total: ["operationClass", "result"],
  application_request_duration_ms: ["operationClass", "result"],
  application_command_total: ["operationClass", "result"],
  application_event_projection_total: ["sourceClass", "result"],
  application_event_lag_ms: ["sourceClass", "result"],
  application_stream_total: ["result"],
  application_stream_backpressure_total: ["result"],
  application_run_total: ["stage", "result"],
  cli_command_total: ["commandClass", "result"],
};
const VALUE = /^[a-z][a-z0-9-]{0,31}$/u;

function canonicalJson(value: Readonly<Record<string, string>>): string {
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${JSON.stringify(child)}`)
    .join(",")}}`;
}

export class ApplicationMetricStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
  ): Promise<ApplicationMetricStore> {
    await applyMigrations(database, [APPLICATION_METRIC_MIGRATION]);
    return new ApplicationMetricStore(database, organizations);
  }

  public async recordOnce(
    context: TenantContext,
    idempotencyKey: string,
    input: {
      readonly name: ApplicationMetricName;
      readonly value: number;
      readonly dimensions: Readonly<Record<string, string>>;
    },
  ): Promise<void> {
    await this.organizations.verifyTenantContext(context);
    if (!idempotencyKey.trim() || idempotencyKey.length > 200)
      throw new Error("Application metric key가 유효하지 않습니다");
    if (!Number.isFinite(input.value) || input.value < 0) throw new Error("Application metric 값이 유효하지 않습니다");
    const allowed = DIMENSIONS[input.name];
    const keys = Object.keys(input.dimensions).sort();
    if (keys.length !== allowed.length || !allowed.every((key) => keys.includes(key))) {
      throw new Error("Application metric dimension이 유효하지 않습니다");
    }
    if (Object.values(input.dimensions).some((value) => !VALUE.test(value))) {
      throw new Error("Application metric dimension 값이 유효하지 않습니다");
    }
    await this.database
      .query(
        "CREATE application_metric CONTENT { metric_id: $metric_id, organization_id: $organization_id, idempotency_key: $idempotency_key, name: $name, value: $value, dimensions_json: $dimensions_json, created_at: time::now() };",
        {
          metric_id: randomUUID(),
          organization_id: context.organizationId,
          idempotency_key: idempotencyKey,
          name: input.name,
          value: input.value,
          dimensions_json: canonicalJson(input.dimensions),
        },
      )
      .catch(async (error: unknown) => {
        const [existing] = await this.database.query<[Array<{ name: string; value: number; dimensions_json: string }>]>(
          "SELECT name, value, dimensions_json FROM application_metric WHERE organization_id = $organization_id AND idempotency_key = $idempotency_key LIMIT 1;",
          { organization_id: context.organizationId, idempotency_key: idempotencyKey },
        );
        const record = existing[0];
        if (
          !record ||
          record.name !== input.name ||
          record.value !== input.value ||
          record.dimensions_json !== canonicalJson(input.dimensions)
        ) {
          throw error;
        }
      });
  }

  public async aggregate(
    context: TenantContext,
    name: ApplicationMetricName,
  ): Promise<readonly { dimensions: Readonly<Record<string, string>>; value: number }[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[Array<{ dimensions_json: string; total: number }>]>(
      "SELECT dimensions_json, math::sum(value) AS total FROM application_metric WHERE organization_id = $organization_id AND name = $name GROUP BY dimensions_json ORDER BY dimensions_json ASC;",
      { organization_id: context.organizationId, name },
    );
    return records.map((record) => ({
      dimensions: JSON.parse(record.dimensions_json) as Readonly<Record<string, string>>,
      value: record.total,
    }));
  }
}
