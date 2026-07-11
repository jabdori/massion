import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { RECORDS_DOCUMENTATION_MIGRATION } from "@massion/records";
import { applyMigrations, createDatabase, type MassionDatabase } from "@massion/storage";
import { WORK_CORE_MIGRATION, WORK_RECORDS_LINK_MIGRATION, WORK_RECORDS_MIGRATION } from "@massion/work";

import { GrowthConfigurationStore, type GrowthConfigurationAuthorizer } from "./index.js";
import { GrowthTriggerStore } from "./trigger.js";

describe("completed Records Growth trigger", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let configurations: GrowthConfigurationStore;
  let triggers: GrowthTriggerStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "growth-trigger@example.com", displayName: "Trigger" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    await applyMigrations(database, [
      WORK_CORE_MIGRATION,
      WORK_RECORDS_MIGRATION,
      RECORDS_DOCUMENTATION_MIGRATION,
      WORK_RECORDS_LINK_MIGRATION,
    ]);
    await database.query("REMOVE EVENT work_record_records_projection_invariant ON TABLE work_record;");
    const authorizer: GrowthConfigurationAuthorizer = {
      authorizeConfiguration: async (_context, input) => ({ governanceDecisionId: `decision:${input.commandId}` }),
    };
    configurations = await GrowthConfigurationStore.create(database, organizations, authorizer);
    triggers = await GrowthTriggerStore.create(database, organizations, configurations);
  });

  afterEach(async () => database.close());

  async function insertWorkAndRecord(
    recordsRunId: string,
    status: "finalized" | "completed" = "completed",
    validRecord = true,
  ) {
    const workId = `work-${recordsRunId}`;
    const requestId = `request-${recordsRunId}`;
    const workRecordId = `record-${recordsRunId}`;
    await database.query(
      "CREATE work_request CONTENT { request_id: $request_id, organization_id: $organization_id, requester_user_id: $user_id, text: '완료 작업', surface: 'test', created_at: time::now() }; CREATE work CONTENT { work_id: $work_id, organization_id: $organization_id, request_id: $request_id, status: 'completed', revision: 12, organization_version_id: 'organization-version-1', artifact_version_ids: [], created_at: time::now(), updated_at: time::now() };",
      { request_id: requestId, organization_id: context.organizationId, user_id: context.userId, work_id: workId },
    );
    await database.query(
      "CREATE records_run CONTENT { records_run_id: $records_run_id, organization_id: $organization_id, work_id: $work_id, target_work_revision: 10, verification_id: 'verification-1', assurance_run_id: 'assurance-run-1', snapshot_hash: $hash, renderer_version: 'renderer-v1', status: $status, version: 1, attempt: 1, command_id: $command_id, request_hash: $hash, active_guard_key: IF $status = 'finalized' { $active_guard_key } ELSE { NONE }, created_by_user_id: $user_id, started_at: time::now(), completed_at: IF $status = 'completed' { time::now() } ELSE { NONE }, updated_at: time::now() };",
      {
        records_run_id: recordsRunId,
        organization_id: context.organizationId,
        work_id: workId,
        hash: "a".repeat(64),
        status,
        command_id: `records-${recordsRunId}`,
        active_guard_key: `active:${recordsRunId}`,
        user_id: context.userId,
      },
    );
    await database.query(
      "CREATE work_record CONTENT { work_record_id: $work_record_id, organization_id: $organization_id, work_id: $work_id, version: 1, recorded_work_revision: 11, summary: '완료', event_start_sequence: 1, event_end_sequence: 10, decision_message_ids: [], artifact_version_ids: [], verification_ids: ['verification-1'], finalized: true, finalized_by: $user_id, finalized_at: time::now(), records_run_id: $records_run_id, records_snapshot_hash: $hash, document_ids: [], schema_version: $schema_version };",
      {
        work_record_id: workRecordId,
        organization_id: context.organizationId,
        work_id: workId,
        user_id: context.userId,
        records_run_id: recordsRunId,
        hash: "a".repeat(64),
        schema_version: validRecord ? "massion.work-record.v1" : undefined,
      },
    );
    return { workId, workRecordId };
  }

  it("기존 completed record를 한 번만 backfill하고 동시 claim 하나만 허용한다", async () => {
    await insertWorkAndRecord("records-run-backfill");

    expect(await triggers.backfill(context)).toEqual({ created: 1, existing: 0 });
    expect(await triggers.backfill(context)).toEqual({ created: 0, existing: 1 });
    const claimed = await Promise.all([
      triggers.claim(context, { workerId: "worker-a", leaseMs: 60_000 }),
      triggers.claim(context, { workerId: "worker-b", leaseMs: 60_000 }),
    ]);
    expect(claimed.filter((result) => result.outcome === "claimed")).toHaveLength(1);
    expect(claimed.filter((result) => result.outcome === "none")).toHaveLength(1);
  });

  it("records_run completed 전이에 같은 transaction trigger를 생성한다", async () => {
    await insertWorkAndRecord("records-run-event", "finalized");

    await database.query(
      "UPDATE records_run SET status = 'completed', version += 1, active_guard_key = NONE, completed_at = time::now(), updated_at = time::now() WHERE organization_id = $organization_id AND records_run_id = 'records-run-event';",
      { organization_id: context.organizationId },
    );

    expect(await triggers.backfill(context)).toEqual({ created: 0, existing: 1 });
  });

  it("Reflection disabled 설정이면 trigger를 skip하고 version을 남긴다", async () => {
    await configurations.configure(context, {
      commandId: "disable-reflection",
      subject: { type: "organization" },
      reflectionEnabled: false,
      adoptionMode: "review",
      expectedVersion: 1,
    });
    await insertWorkAndRecord("records-run-disabled");
    await triggers.backfill(context);

    const result = await triggers.claim(context, { workerId: "worker-a", leaseMs: 60_000 });
    expect(result).toMatchObject({ outcome: "skipped", reason: "reflection-disabled" });
  });

  it("completed가 아닌 run과 legacy WorkRecord는 backfill하지 않는다", async () => {
    await insertWorkAndRecord("records-run-finalized", "finalized");
    await insertWorkAndRecord("records-run-legacy", "completed", false);

    expect(await triggers.backfill(context)).toEqual({ created: 0, existing: 0 });
  });
});
