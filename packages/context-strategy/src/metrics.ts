import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase } from "@massion/storage";

import {
  CONTEXT_STRATEGY_MIGRATION,
  CONTINUATION_STAFFING_MIGRATION,
  STRATEGY_GENERATION_MIGRATION,
} from "./schema.js";

export interface ContextStrategyMetricSnapshot {
  readonly contextCompileTotal: number;
  readonly contextExcludedSourceTotal: number;
  readonly contextBudgetBlockedTotal: number;
  readonly strategyGeneratedTotal: number;
  readonly strategySchemaFailureTotal: number;
  readonly strategyModelBlockedTotal: number;
  readonly strategyProjectionConflictTotal: number;
  readonly continuationTotal: Readonly<Record<"extend_current" | "create_follow_up" | "create_independent", number>>;
  readonly staffingGapTotal: number;
}

interface ContextMetricRecord {
  readonly excluded_sources_json: string;
}

interface EventMetricRecord {
  readonly event_type: string;
}

interface StrategyMetricRecord {
  readonly status: string;
  readonly error_json?: string;
}

interface ContinuationMetricRecord {
  readonly decision: "extend_current" | "create_follow_up" | "create_independent";
}

export class ContextStrategyMetrics {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
  ): Promise<ContextStrategyMetrics> {
    await applyMigrations(database, [
      CONTEXT_STRATEGY_MIGRATION,
      STRATEGY_GENERATION_MIGRATION,
      CONTINUATION_STAFFING_MIGRATION,
    ]);
    return new ContextStrategyMetrics(database, organizations);
  }

  public async read(context: TenantContext): Promise<ContextStrategyMetricSnapshot> {
    await this.organizations.verifyTenantContext(context);
    const [[contexts], [events], [strategies], [continuations], [gaps]] = await Promise.all([
      this.database.query<[ContextMetricRecord[]]>(
        "SELECT excluded_sources_json FROM context_version WHERE organization_id = $organization_id;",
        { organization_id: context.organizationId },
      ),
      this.database.query<[EventMetricRecord[]]>(
        "SELECT event_type FROM context_event WHERE organization_id = $organization_id;",
        { organization_id: context.organizationId },
      ),
      this.database.query<[StrategyMetricRecord[]]>(
        "SELECT status, error_json FROM strategy_generation WHERE organization_id = $organization_id;",
        { organization_id: context.organizationId },
      ),
      this.database.query<[ContinuationMetricRecord[]]>(
        "SELECT decision FROM continuation_decision WHERE organization_id = $organization_id;",
        { organization_id: context.organizationId },
      ),
      this.database.query<[unknown[]]>("SELECT gap_id FROM staffing_gap WHERE organization_id = $organization_id;", {
        organization_id: context.organizationId,
      }),
    ]);
    const continuationTotal = {
      extend_current: 0,
      create_follow_up: 0,
      create_independent: 0,
    };
    for (const continuation of continuations) continuationTotal[continuation.decision] += 1;
    const strategyErrors = strategies.map((strategy) => {
      if (!strategy.error_json) return undefined;
      return JSON.parse(strategy.error_json) as { readonly category?: string };
    });
    return {
      contextCompileTotal: events.filter((event) => event.event_type === "context_version_created").length,
      contextExcludedSourceTotal: contexts.reduce((total, record) => {
        const excluded = JSON.parse(record.excluded_sources_json) as unknown[];
        return total + excluded.length;
      }, 0),
      contextBudgetBlockedTotal: events.filter((event) => event.event_type === "context_budget_blocked").length,
      strategyGeneratedTotal: strategies.filter((strategy) =>
        ["generated", "applied", "conflicted"].includes(strategy.status),
      ).length,
      strategySchemaFailureTotal: strategyErrors.filter((error) => error?.category === "structured_output").length,
      strategyModelBlockedTotal: strategies.filter((strategy) => strategy.status === "blocked_model_unavailable")
        .length,
      strategyProjectionConflictTotal: strategies.filter((strategy) => strategy.status === "conflicted").length,
      continuationTotal,
      staffingGapTotal: gaps.length,
    };
  }
}
