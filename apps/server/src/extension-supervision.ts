import { applyMigrations, defineMigration, type MassionDatabase } from "@massion/storage";

import type { OperationQueue } from "./operation-queue.js";

const EXTENSION_SUPERVISION_MIGRATION = defineMigration(
  "0021-extension-supervision",
  `
DEFINE TABLE IF NOT EXISTS extension_supervision_state SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS organization_id ON extension_supervision_state TYPE string;
DEFINE FIELD IF NOT EXISTS installation_id ON extension_supervision_state TYPE string;
DEFINE FIELD IF NOT EXISTS version_id ON extension_supervision_state TYPE string;
DEFINE FIELD IF NOT EXISTS failure_times_json ON extension_supervision_state TYPE string;
DEFINE FIELD IF NOT EXISTS circuit ON extension_supervision_state TYPE string ASSERT $value IN ['closed', 'open'];
DEFINE FIELD IF NOT EXISTS updated_at ON extension_supervision_state TYPE datetime;
DEFINE INDEX IF NOT EXISTS extension_supervision_installation ON extension_supervision_state FIELDS organization_id, installation_id UNIQUE;
DEFINE TABLE IF NOT EXISTS extension_crash_decision SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS crash_id ON extension_crash_decision TYPE string;
DEFINE FIELD IF NOT EXISTS result_json ON extension_crash_decision TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON extension_crash_decision TYPE datetime;
DEFINE INDEX IF NOT EXISTS extension_crash_id ON extension_crash_decision FIELDS crash_id UNIQUE;
`,
);

export interface ExtensionCrashInput {
  readonly crashId: string;
  readonly organizationId: string;
  readonly installationId: string;
  readonly versionId: string;
  readonly previousVersionId?: string;
  readonly policyAllowsRollback: boolean;
  readonly previousVersionHealthy: boolean;
  readonly previousVersionRecalled: boolean;
  readonly permissionIncrease: boolean;
}

export interface ExtensionCrashDecision {
  readonly circuit: "closed" | "open";
  readonly action: "restart" | "rollback" | "review";
  readonly delayMs: number;
  readonly failureCount: number;
  readonly replayed?: boolean;
}

interface StateRow {
  readonly failure_times_json: string;
  readonly circuit: "closed" | "open";
}

interface DecisionRow {
  readonly result_json: string;
}

export class ExtensionCrashSupervisor {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly queue: OperationQueue,
    private readonly options: {
      readonly windowMs: number;
      readonly maximumRestarts: number;
      readonly baseBackoffMs: number;
      readonly maximumBackoffMs: number;
    },
  ) {}

  public static async create(
    database: MassionDatabase,
    queue: OperationQueue,
    options: {
      readonly windowMs: number;
      readonly maximumRestarts: number;
      readonly baseBackoffMs: number;
      readonly maximumBackoffMs: number;
    },
  ): Promise<ExtensionCrashSupervisor> {
    if (
      !Number.isSafeInteger(options.windowMs) ||
      options.windowMs < 1_000 ||
      options.windowMs > 86_400_000 ||
      !Number.isSafeInteger(options.maximumRestarts) ||
      options.maximumRestarts < 0 ||
      options.maximumRestarts > 20 ||
      !Number.isSafeInteger(options.baseBackoffMs) ||
      options.baseBackoffMs < 1 ||
      options.baseBackoffMs > options.maximumBackoffMs ||
      options.maximumBackoffMs > 86_400_000
    ) {
      throw new Error("Extension supervision 설정이 유효하지 않습니다");
    }
    await applyMigrations(database, [EXTENSION_SUPERVISION_MIGRATION]);
    return new ExtensionCrashSupervisor(database, queue, options);
  }

  public async recordCrash(input: ExtensionCrashInput): Promise<ExtensionCrashDecision> {
    const existing = await this.decision(input.crashId);
    if (existing) {
      await this.enqueue(input, existing);
      return { ...existing, replayed: true };
    }
    const now = Date.now();
    const result = await this.database.transaction(async (transaction) => {
      const [rows] = await transaction.query<[StateRow[]]>(
        "SELECT * OMIT id FROM extension_supervision_state WHERE organization_id = $organization_id AND installation_id = $installation_id LIMIT 1;",
        { organization_id: input.organizationId, installation_id: input.installationId },
      );
      const prior = rows?.[0];
      const times = prior
        ? (JSON.parse(prior.failure_times_json) as number[]).filter(
            (time) => Number.isSafeInteger(time) && time >= now - this.options.windowMs && time <= now,
          )
        : [];
      times.push(now);
      const failureCount = times.length;
      const circuit = failureCount > this.options.maximumRestarts ? "open" : "closed";
      const rollbackSafe =
        input.policyAllowsRollback &&
        input.previousVersionId !== undefined &&
        input.previousVersionHealthy &&
        !input.previousVersionRecalled &&
        !input.permissionIncrease;
      const action = circuit === "closed" ? "restart" : rollbackSafe ? "rollback" : "review";
      const delayMs =
        action === "restart"
          ? Math.min(this.options.maximumBackoffMs, this.options.baseBackoffMs * 2 ** (failureCount - 1))
          : 0;
      const decision: ExtensionCrashDecision = { circuit, action, delayMs, failureCount };
      if (prior) {
        await transaction.query(
          "UPDATE extension_supervision_state SET version_id = $version_id, failure_times_json = $times, circuit = $circuit, updated_at = time::now() WHERE organization_id = $organization_id AND installation_id = $installation_id;",
          {
            version_id: input.versionId,
            times: JSON.stringify(times),
            circuit,
            organization_id: input.organizationId,
            installation_id: input.installationId,
          },
        );
      } else {
        await transaction.query(
          "CREATE extension_supervision_state CONTENT { organization_id: $organization_id, installation_id: $installation_id, version_id: $version_id, failure_times_json: $times, circuit: $circuit, updated_at: time::now() };",
          {
            organization_id: input.organizationId,
            installation_id: input.installationId,
            version_id: input.versionId,
            times: JSON.stringify(times),
            circuit,
          },
        );
      }
      await transaction.query(
        "CREATE extension_crash_decision CONTENT { crash_id: $crash_id, result_json: $result_json, created_at: time::now() };",
        { crash_id: input.crashId, result_json: JSON.stringify(decision) },
      );
      return decision;
    });
    await this.enqueue(input, result);
    return result;
  }

  public async resetCircuit(organizationId: string, installationId: string): Promise<void> {
    const [updated] = await this.database.query<[StateRow[]]>(
      "UPDATE extension_supervision_state SET failure_times_json = '[]', circuit = 'closed', updated_at = time::now() WHERE organization_id = $organization_id AND installation_id = $installation_id RETURN AFTER;",
      { organization_id: organizationId, installation_id: installationId },
    );
    if (!updated?.[0]) throw new Error("reset할 Extension circuit를 찾을 수 없습니다");
  }

  private async decision(crashId: string): Promise<ExtensionCrashDecision | undefined> {
    const [rows] = await this.database.query<[DecisionRow[]]>(
      "SELECT * OMIT id FROM extension_crash_decision WHERE crash_id = $crash_id LIMIT 1;",
      { crash_id: crashId },
    );
    return rows?.[0] ? (JSON.parse(rows[0].result_json) as ExtensionCrashDecision) : undefined;
  }

  private async enqueue(input: ExtensionCrashInput, decision: ExtensionCrashDecision): Promise<void> {
    await this.queue.enqueue({
      dedupeKey: `extension-crash:${input.crashId}`,
      kind:
        decision.action === "restart"
          ? "extension-restart"
          : decision.action === "rollback"
            ? "extension-rollback"
            : "extension-review",
      payload: {
        organizationId: input.organizationId,
        installationId: input.installationId,
        versionId: input.versionId,
        ...(decision.action === "rollback" ? { targetVersionId: input.previousVersionId } : {}),
        crashId: input.crashId,
      },
      delayMs: decision.delayMs,
    });
  }
}
