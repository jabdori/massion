import { createHash } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase } from "@massion/storage";

import type { GrowthConfigurationGateway } from "./contracts.js";
import { GROWTH_REFLECTION_MIGRATION } from "./schema.js";

export interface GrowthTrigger {
  readonly trigger_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly records_run_id: string;
  readonly work_record_id: string;
  readonly verification_id: string;
  readonly assurance_run_id: string;
  readonly requester_user_id: string;
  readonly status: "pending" | "claimed" | "completed" | "skipped" | "blocked";
  readonly configuration_version_id?: string;
  readonly worker_id?: string;
  readonly lease_expires_at?: unknown;
  readonly skip_reason?: string;
}

interface CompletedRun {
  readonly organization_id: string;
  readonly work_id: string;
  readonly records_run_id: string;
  readonly verification_id: string;
  readonly assurance_run_id: string;
}

function triggerId(organizationId: string, recordsRunId: string): string {
  return createHash("sha256").update(`${organizationId}|${recordsRunId}`).digest("hex");
}

export type ClaimGrowthTriggerResult =
  | { readonly outcome: "claimed"; readonly trigger: GrowthTrigger }
  | { readonly outcome: "skipped"; readonly trigger: GrowthTrigger; readonly reason: "reflection-disabled" }
  | { readonly outcome: "none" };

export class GrowthTriggerStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly configurations: GrowthConfigurationGateway,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    configurations: GrowthConfigurationGateway,
  ): Promise<GrowthTriggerStore> {
    await applyMigrations(database, [GROWTH_REFLECTION_MIGRATION]);
    return new GrowthTriggerStore(database, organizations, configurations);
  }

  public async backfill(context: TenantContext): Promise<{ created: number; existing: number }> {
    await this.organizations.verifyTenantContext(context);
    const [runs] = await this.database.query<[CompletedRun[]]>(
      "SELECT organization_id, work_id, records_run_id, verification_id, assurance_run_id FROM records_run WHERE organization_id = $organization_id AND status = 'completed' ORDER BY records_run_id ASC;",
      { organization_id: context.organizationId },
    );
    let created = 0;
    let existing = 0;
    for (const run of runs) {
      const [found] = await this.database.query<[GrowthTrigger[]]>(
        "SELECT * FROM growth_trigger WHERE organization_id = $organization_id AND records_run_id = $records_run_id LIMIT 1;",
        { organization_id: context.organizationId, records_run_id: run.records_run_id },
      );
      if (found[0]) {
        existing += 1;
        continue;
      }
      const [records] = await this.database.query<[Array<{ work_record_id: string }>]>(
        "SELECT work_record_id FROM work_record WHERE organization_id = $organization_id AND work_id = $work_id AND records_run_id = $records_run_id AND finalized = true AND schema_version = 'massion.work-record.v1' LIMIT 1;",
        { organization_id: context.organizationId, work_id: run.work_id, records_run_id: run.records_run_id },
      );
      const [requests] = await this.database.query<[Array<{ requester_user_id: string }>]>(
        "SELECT requester_user_id FROM work_request WHERE organization_id = $organization_id AND request_id IN (SELECT VALUE request_id FROM work WHERE organization_id = $organization_id AND work_id = $work_id AND status = 'completed') LIMIT 1;",
        { organization_id: context.organizationId, work_id: run.work_id },
      );
      if (!records[0] || !requests[0]) continue;
      await this.database.query(
        "CREATE growth_trigger CONTENT { trigger_id: $trigger_id, organization_id: $organization_id, work_id: $work_id, records_run_id: $records_run_id, work_record_id: $work_record_id, verification_id: $verification_id, assurance_run_id: $assurance_run_id, requester_user_id: $requester_user_id, status: 'pending', created_at: time::now(), updated_at: time::now() };",
        {
          trigger_id: triggerId(context.organizationId, run.records_run_id),
          organization_id: context.organizationId,
          work_id: run.work_id,
          records_run_id: run.records_run_id,
          work_record_id: records[0].work_record_id,
          verification_id: run.verification_id,
          assurance_run_id: run.assurance_run_id,
          requester_user_id: requests[0].requester_user_id,
        },
      );
      created += 1;
    }
    return { created, existing };
  }

  public async claim(
    context: TenantContext,
    input: { readonly workerId: string; readonly leaseMs: number },
  ): Promise<ClaimGrowthTriggerResult> {
    await this.organizations.verifyTenantContext(context);
    if (!input.workerId.trim() || input.leaseMs < 1 || input.leaseMs > 3_600_000) {
      throw new Error("Growth trigger worker와 lease가 유효하지 않습니다");
    }
    const [pending] = await this.database.query<[GrowthTrigger[]]>(
      "SELECT * FROM growth_trigger WHERE organization_id = $organization_id AND status = 'pending' ORDER BY created_at ASC LIMIT 1;",
      { organization_id: context.organizationId },
    );
    const candidate = pending[0];
    if (!candidate) return { outcome: "none" };
    const configuration = await this.configurations.resolve(context, candidate.requester_user_id);
    if (!configuration.reflectionEnabled) {
      const skipped = await this.database.transaction(async (transaction) => {
        const [updated] = await transaction.query<[GrowthTrigger[]]>(
          "UPDATE growth_trigger SET status = 'skipped', configuration_version_id = $configuration_version_id, skip_reason = 'reflection-disabled', updated_at = time::now() WHERE organization_id = $organization_id AND trigger_id = $trigger_id AND status = 'pending' RETURN AFTER;",
          {
            organization_id: context.organizationId,
            trigger_id: candidate.trigger_id,
            configuration_version_id: configuration.configurationVersionId,
          },
        );
        return updated;
      });
      return skipped[0]
        ? { outcome: "skipped", trigger: skipped[0], reason: "reflection-disabled" }
        : { outcome: "none" };
    }
    const expiresAt = new Date(Date.now() + input.leaseMs).toISOString();
    const claimed = await this.database.transaction(async (transaction) => {
      const [updated] = await transaction.query<[GrowthTrigger[]]>(
        "UPDATE growth_trigger SET status = 'claimed', configuration_version_id = $configuration_version_id, worker_id = $worker_id, lease_expires_at = type::datetime($expires_at), updated_at = time::now() WHERE organization_id = $organization_id AND trigger_id = $trigger_id AND status = 'pending' RETURN AFTER;",
        {
          organization_id: context.organizationId,
          trigger_id: candidate.trigger_id,
          configuration_version_id: configuration.configurationVersionId,
          worker_id: input.workerId,
          expires_at: expiresAt,
        },
      );
      return updated;
    });
    return claimed[0] ? { outcome: "claimed", trigger: claimed[0] } : { outcome: "none" };
  }
}
