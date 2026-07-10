import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import type { MassionDatabase, QueryExecutor } from "@massion/storage";

import { RecordsMetricStore } from "./metrics.js";
import { RecordsComplianceAuditor } from "./compliance.js";
import {
  RecordsRecovery,
  type RecordsRecoveryDependencies,
  type RecordsRecoveryResult,
  type RecordsRecoveryStage,
  type RecordsRecoveryState,
} from "./recovery.js";
import { RecordsRunStore } from "./run-store.js";
import { RecordsService } from "./service.js";

interface RecoveryEventRecord {
  readonly records_run_id: string;
  readonly request_hash: string;
  readonly payload_json: string;
}

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

function recoveryHash(recordsRunId: string): string {
  return createHash("sha256")
    .update(canonicalJson({ operation: "records_recovery", recordsRunId }))
    .digest("hex");
}

class DatabaseRecordsRecoveryReadiness {
  public constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly runs: RecordsRunStore,
  ) {}

  public async inspect(context: TenantContext, recordsRunId: string): Promise<RecordsRecoveryState> {
    await this.organizations.verifyTenantContext(context);
    const run = await this.runs.get(context, recordsRunId);
    const parameters = {
      organization_id: context.organizationId,
      work_id: run.workId,
      records_run_id: recordsRunId,
    };
    const [assessments] = await this.database.query<[{ kind: string; outcome: string }[]]>(
      "SELECT kind, outcome FROM documentation_impact_assessment WHERE organization_id = $organization_id AND work_id = $work_id AND records_run_id = $records_run_id;",
      parameters,
    );
    const [documents] = await this.database.query<[{ document_id: string }[]]>(
      "SELECT document_id FROM records_document WHERE organization_id = $organization_id AND work_id = $work_id AND records_run_id = $records_run_id;",
      parameters,
    );
    const [records] = await this.database.query<[{ work_record_id: string }[]]>(
      "SELECT work_record_id FROM work_record WHERE organization_id = $organization_id AND work_id = $work_id AND records_run_id = $records_run_id AND finalized = true;",
      parameters,
    );
    const [works] = await this.database.query<[{ status: string }[]]>(
      "SELECT status FROM work WHERE organization_id = $organization_id AND work_id = $work_id LIMIT 1;",
      parameters,
    );
    if (!works[0]) throw new Error("Records recovery 대상 Work를 찾을 수 없습니다");
    return {
      status: run.status,
      assessmentCount: assessments.length,
      requiredDocumentCount: assessments.filter(
        (assessment) => assessment.kind !== "work-record" && assessment.outcome === "required",
      ).length,
      renderedDocumentCount: documents.length,
      workRecordExists: records.length === 1,
      workCompleted: works[0].status === "completed",
    };
  }
}

class DatabaseRecordsRecoveryLedger {
  public constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public async replay(
    context: TenantContext,
    input: { readonly commandId: string; readonly recordsRunId: string },
  ): Promise<{ readonly stage: RecordsRecoveryStage; readonly result: RecordsRecoveryResult } | undefined> {
    await this.organizations.verifyTenantContext(context);
    const event = await this.find(this.database, context.organizationId, input.commandId);
    if (!event) return undefined;
    if (event.records_run_id !== input.recordsRunId || event.request_hash !== recoveryHash(input.recordsRunId)) {
      throw new Error("같은 command ID에 다른 Records recovery 명령을 사용할 수 없습니다");
    }
    return JSON.parse(event.payload_json) as {
      readonly stage: RecordsRecoveryStage;
      readonly result: RecordsRecoveryResult;
    };
  }

  public async record(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly recordsRunId: string;
      readonly stage: RecordsRecoveryStage;
      readonly result: RecordsRecoveryResult;
    },
  ): Promise<void> {
    await this.organizations.verifyTenantContext(context);
    const hash = recoveryHash(input.recordsRunId);
    await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const existing = await this.find(transaction, context.organizationId, input.commandId);
      const payload = canonicalJson({ stage: input.stage, result: input.result });
      if (existing) {
        if (
          existing.records_run_id !== input.recordsRunId ||
          existing.request_hash !== hash ||
          existing.payload_json !== payload
        ) {
          throw new Error("같은 command ID에 다른 Records recovery 결과를 기록할 수 없습니다");
        }
        return;
      }
      const [runs] = await transaction.query<[{ work_id: string }[]]>(
        "SELECT work_id FROM records_run WHERE organization_id = $organization_id AND records_run_id = $records_run_id LIMIT 1;",
        { organization_id: context.organizationId, records_run_id: input.recordsRunId },
      );
      if (!runs[0]) throw new Error("Records recovery run을 찾을 수 없습니다");
      const [events] = await transaction.query<[{ sequence: number }[]]>(
        "SELECT sequence FROM records_event WHERE organization_id = $organization_id AND records_run_id = $records_run_id;",
        { organization_id: context.organizationId, records_run_id: input.recordsRunId },
      );
      await transaction.query(
        "CREATE records_event CONTENT { event_id: $event_id, organization_id: $organization_id, work_id: $work_id, records_run_id: $records_run_id, command_id: $command_id, sequence: $sequence, event_type: 'records_run_recovered', request_hash: $request_hash, payload_json: $payload_json, actor_user_id: $actor_user_id, created_at: time::now() };",
        {
          event_id: randomUUID(),
          organization_id: context.organizationId,
          work_id: runs[0].work_id,
          records_run_id: input.recordsRunId,
          command_id: input.commandId,
          sequence: events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1,
          request_hash: hash,
          payload_json: payload,
          actor_user_id: context.userId,
        },
      );
    });
  }

  private async find(
    executor: QueryExecutor,
    organizationId: string,
    commandId: string,
  ): Promise<RecoveryEventRecord | undefined> {
    const [events] = await executor.query<[RecoveryEventRecord[]]>(
      "SELECT records_run_id, request_hash, payload_json FROM records_event WHERE organization_id = $organization_id AND command_id = $command_id AND event_type = 'records_run_recovered' LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    return events[0];
  }
}

export class RecordsBootstrap {
  private constructor(
    public readonly service: RecordsService,
    public readonly recovery: RecordsRecovery,
    public readonly metrics: RecordsMetricStore,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    options: { readonly continuation: RecordsRecoveryDependencies["continuation"] },
  ): Promise<RecordsBootstrap> {
    await new RecordsComplianceAuditor(database).assertDatabaseCompliance();
    const service = await RecordsService.create(database, organizations);
    const runs = await RecordsRunStore.create(database, organizations);
    const metrics = await RecordsMetricStore.create(database, organizations);
    const recovery = new RecordsRecovery({
      gateway: { get: runs.get.bind(runs) },
      readiness: new DatabaseRecordsRecoveryReadiness(database, organizations, runs),
      continuation: options.continuation,
      ledger: new DatabaseRecordsRecoveryLedger(database, organizations),
      metrics,
    });
    return new RecordsBootstrap(service, recovery, metrics);
  }
}
