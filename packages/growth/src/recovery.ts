import { randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase } from "@massion/storage";

import { growthChecksum } from "./prompt-memory.js";
import { GROWTH_RECOVERY_METRIC_MIGRATION } from "./schema.js";

export interface GrowthRecoveryState {
  readonly trigger?: string;
  readonly leaseExpired?: boolean;
  readonly reflection?: string;
  readonly evaluation?: string;
  readonly adoption?: string;
  readonly revert?: string;
  readonly targetVersionExists?: boolean;
  readonly checksumMatches?: boolean;
  readonly terminal?: boolean;
}
export type GrowthRecoveryAction =
  | "requeue-trigger"
  | "resume-reflection"
  | "resume-evaluation"
  | "wait-for-approval"
  | "finish-adoption"
  | "retry-adoption"
  | "resume-observation"
  | "finish-revert"
  | "retry-revert"
  | "blocked"
  | "unchanged";

function recoveryInstant(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") return new Date(value).getTime();
  if (value && typeof value === "object" && "toISOString" in value) {
    const converter = (value as { toISOString?: unknown }).toISOString;
    if (typeof converter === "function") return new Date(String(converter.call(value))).getTime();
  }
  return Number.NaN;
}

export function classifyGrowthRecovery(state: GrowthRecoveryState): GrowthRecoveryAction {
  if (state.terminal) return "unchanged";
  if (state.checksumMatches === false) return "blocked";
  if (state.trigger === "claimed" && state.leaseExpired) return "requeue-trigger";
  if (state.trigger === "claimed" && !state.reflection) return "resume-reflection";
  if (["planned", "generating", "validated"].includes(state.reflection ?? "")) return "resume-reflection";
  if (state.evaluation === "evaluating") return "resume-evaluation";
  if (state.adoption === "awaiting-review") return "wait-for-approval";
  if (state.adoption === "applying") return state.targetVersionExists ? "finish-adoption" : "retry-adoption";
  if (state.adoption === "observing") return "resume-observation";
  if (state.revert === "reverting") return state.targetVersionExists ? "finish-revert" : "retry-revert";
  return "unchanged";
}

export interface GrowthRecoveryRecord {
  readonly recovery_id: string;
  readonly organization_id: string;
  readonly aggregate_id: string;
  readonly stage: string;
  readonly action: GrowthRecoveryAction;
  readonly command_id: string;
  readonly request_hash: string;
}
export class GrowthRecoveryService {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}
  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
  ): Promise<GrowthRecoveryService> {
    await applyMigrations(database, [GROWTH_RECOVERY_METRIC_MIGRATION]);
    return new GrowthRecoveryService(database, organizations);
  }
  public async recover(
    context: TenantContext,
    input: { readonly aggregateId: string; readonly stage: string; readonly state: GrowthRecoveryState },
  ): Promise<GrowthRecoveryRecord> {
    await this.organizations.verifyTenantContext(context);
    const commandId = `growth-recovery:${input.stage}:${input.aggregateId}`;
    const requestHash = growthChecksum(input);
    const [existing] = await this.database.query<[GrowthRecoveryRecord[]]>(
      "SELECT * FROM growth_recovery_operation WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: context.organizationId, command_id: commandId },
    );
    if (existing[0]) {
      if (existing[0].request_hash !== requestHash)
        throw new Error("같은 recovery command에 다른 snapshot을 사용할 수 없습니다");
      return existing[0];
    }
    const action = classifyGrowthRecovery(input.state);
    const [created] = await this.database.query<[GrowthRecoveryRecord[]]>(
      "CREATE growth_recovery_operation CONTENT { recovery_id: $id, organization_id: $organization_id, aggregate_id: $aggregate_id, stage: $stage, action: $action, command_id: $command_id, request_hash: $request_hash, created_at: time::now() } RETURN AFTER;",
      {
        id: randomUUID(),
        organization_id: context.organizationId,
        aggregate_id: input.aggregateId,
        stage: input.stage,
        action,
        command_id: commandId,
        request_hash: requestHash,
      },
    );
    if (!created[0]) throw new Error("Growth recovery operation 생성 결과가 없습니다");
    return created[0];
  }

  public async scan(context: TenantContext, now = new Date()): Promise<readonly GrowthRecoveryRecord[]> {
    await this.organizations.verifyTenantContext(context);
    const candidates: Array<{ aggregateId: string; stage: string; state: GrowthRecoveryState }> = [];
    const [triggers] = await this.database.query<
      [Array<{ trigger_id: string; status: string; lease_expires_at?: unknown }>]
    >(
      "SELECT trigger_id, status, lease_expires_at FROM growth_trigger WHERE organization_id = $organization_id AND status = 'claimed';",
      { organization_id: context.organizationId },
    );
    for (const trigger of triggers) {
      const expiry = recoveryInstant(trigger.lease_expires_at);
      candidates.push({
        aggregateId: trigger.trigger_id,
        stage: "trigger",
        state: { trigger: trigger.status, leaseExpired: Number.isFinite(expiry) && expiry <= now.getTime() },
      });
    }
    const [reflections] = await this.database.query<[Array<{ reflection_run_id: string; status: string }>]>(
      "SELECT reflection_run_id, status FROM reflection_run WHERE organization_id = $organization_id AND status IN ['planned', 'generating', 'validated'];",
      { organization_id: context.organizationId },
    );
    for (const run of reflections)
      candidates.push({ aggregateId: run.reflection_run_id, stage: "reflection", state: { reflection: run.status } });
    const [adoptions] = await this.database.query<
      [Array<{ adoption_id: string; status: string; after_version_id?: string }>]
    >(
      "SELECT adoption_id, status, after_version_id FROM growth_adoption_run WHERE organization_id = $organization_id AND status IN ['awaiting-review', 'applying', 'observing'];",
      { organization_id: context.organizationId },
    );
    for (const run of adoptions)
      candidates.push({
        aggregateId: run.adoption_id,
        stage: "adoption",
        state: { adoption: run.status, targetVersionExists: Boolean(run.after_version_id) },
      });
    const [reverts] = await this.database.query<
      [Array<{ revert_operation_id: string; status: string; reverted_version_id?: string }>]
    >(
      "SELECT revert_operation_id, status, reverted_version_id FROM growth_revert_operation WHERE organization_id = $organization_id AND status IN ['awaiting-review', 'reverting'];",
      { organization_id: context.organizationId },
    );
    for (const run of reverts)
      candidates.push({
        aggregateId: run.revert_operation_id,
        stage: "revert",
        state:
          run.status === "awaiting-review"
            ? { adoption: "awaiting-review" }
            : { revert: run.status, targetVersionExists: Boolean(run.reverted_version_id) },
      });
    return await Promise.all(candidates.map(async (candidate) => await this.recover(context, candidate)));
  }
}
