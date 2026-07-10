import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { ContextStrategyMetrics } from "./index.js";

describe("Context & Strategy event-derived metrics", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let organizations: OrganizationService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "metrics@example.com", displayName: "Metrics" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
  });

  afterEach(async () => database.close());

  it("식별자 label 없이 compile, budget, generation, continuation과 staffing 수를 집계한다", async () => {
    const metrics = await ContextStrategyMetrics.create(database, organizations);
    const organizationId = context.organizationId;
    await database.query(
      `
CREATE context_version CONTENT { context_version_id: 'context-metric', organization_id: $organization_id, work_id: 'work-metric', version: 1, package_json: '{}', selected_sources_json: '[]', excluded_sources_json: '[{"sourceId":"one"},{"sourceId":"two"}]', token_budget: 100, token_total: 10, checksum: 'checksum', created_by_user_id: $user_id, created_at: time::now() };
CREATE context_event CONTENT { event_id: 'context-created', organization_id: $organization_id, work_id: 'work-metric', context_version_id: 'context-metric', command_id: 'context-created', event_type: 'context_version_created', request_hash: 'hash-created', payload_json: '{}', created_at: time::now() };
CREATE context_event CONTENT { event_id: 'context-blocked', organization_id: $organization_id, work_id: 'work-metric', command_id: 'context-blocked', event_type: 'context_budget_blocked', request_hash: 'hash-blocked', payload_json: '{}', created_at: time::now() };
CREATE strategy_generation CONTENT { strategy_generation_id: 'strategy-applied', organization_id: $organization_id, work_id: 'work-metric', context_version_id: 'context-metric', command_id: 'strategy-applied', request_hash: 'hash-applied', expected_work_revision: 1, status: 'applied', created_by_user_id: $user_id, created_at: time::now(), updated_at: time::now() };
CREATE strategy_generation CONTENT { strategy_generation_id: 'strategy-failed', organization_id: $organization_id, work_id: 'work-metric', context_version_id: 'context-metric', command_id: 'strategy-failed', request_hash: 'hash-failed', expected_work_revision: 1, status: 'failed', error_json: '{"category":"structured_output","causeId":"cause"}', created_by_user_id: $user_id, created_at: time::now(), updated_at: time::now() };
CREATE strategy_generation CONTENT { strategy_generation_id: 'strategy-blocked', organization_id: $organization_id, work_id: 'work-metric', context_version_id: 'context-metric', command_id: 'strategy-blocked', request_hash: 'hash-model', expected_work_revision: 1, status: 'blocked_model_unavailable', created_by_user_id: $user_id, created_at: time::now(), updated_at: time::now() };
CREATE strategy_generation CONTENT { strategy_generation_id: 'strategy-conflict', organization_id: $organization_id, work_id: 'work-metric', context_version_id: 'context-metric', command_id: 'strategy-conflict', request_hash: 'hash-conflict', expected_work_revision: 1, status: 'conflicted', created_by_user_id: $user_id, created_at: time::now(), updated_at: time::now() };
CREATE continuation_decision CONTENT { decision_id: 'decision-extend', organization_id: $organization_id, work_id: 'work-metric', command_id: 'decision-extend', request_hash: 'hash-extend', request_text: 'extend', decision: 'extend_current', confidence: 1.0, reason_codes_json: '[]', context_delta_json: '{}', replan_required: false, source: 'human_override', actor_user_id: $user_id, status: 'applied', created_at: time::now(), updated_at: time::now() };
CREATE continuation_decision CONTENT { decision_id: 'decision-follow', organization_id: $organization_id, work_id: 'work-metric', command_id: 'decision-follow', request_hash: 'hash-follow', request_text: 'follow', decision: 'create_follow_up', confidence: 0.9, reason_codes_json: '[]', context_delta_json: '{}', replan_required: false, source: 'model', actor_user_id: $user_id, status: 'applied', created_at: time::now(), updated_at: time::now() };
CREATE staffing_gap CONTENT { gap_id: 'gap-one', assessment_id: 'assessment', organization_id: $organization_id, work_id: 'work-metric', strategy_generation_id: 'strategy-applied', task_key: 'one', reason: 'missing_recommendation', capability: 'database', created_at: time::now() };
CREATE staffing_gap CONTENT { gap_id: 'gap-two', assessment_id: 'assessment', organization_id: $organization_id, work_id: 'work-metric', strategy_generation_id: 'strategy-applied', task_key: 'two', reason: 'unavailable_recommendation', agent_handle: 'missing', created_at: time::now() };
`,
      { organization_id: organizationId, user_id: context.userId },
    );

    expect(await metrics.read(context)).toEqual({
      contextCompileTotal: 1,
      contextExcludedSourceTotal: 2,
      contextBudgetBlockedTotal: 1,
      strategyGeneratedTotal: 2,
      strategySchemaFailureTotal: 1,
      strategyModelBlockedTotal: 1,
      strategyProjectionConflictTotal: 1,
      continuationTotal: {
        extend_current: 1,
        create_follow_up: 1,
        create_independent: 0,
      },
      staffingGapTotal: 2,
    });
    expect(JSON.stringify(await metrics.read(context))).not.toContain(organizationId);
  });
});
