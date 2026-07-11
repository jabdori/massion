import { GOVERNANCE_DECISION_CONTEXT_MIGRATION, GOVERNANCE_DECISION_MIGRATION } from "@massion/governance";
import type { OrganizationService, TenantContext } from "@massion/identity";
import { ORGANIZATION_CAPABILITY_MIGRATION, ORGANIZATION_GRAPH_MIGRATION } from "@massion/organization";
import { RUNTIME_BLOCKED_TRANSITION_MIGRATION, RUNTIME_EXECUTION_MIGRATION } from "@massion/runtime";
import { applyMigrations, type MassionDatabase } from "@massion/storage";
import { WORK_ASSURANCE_LINK_MIGRATION, WorkService } from "@massion/work";

import { AssuranceRunStore } from "./run-store.js";
import { AssuranceService, type DecideAssuranceInput, type DecideAssuranceResult } from "./service.js";
import { AssuranceRecovery, type AssuranceRecoveryResult } from "./recovery.js";
import { AssuranceComplianceAuditor, type AssuranceCompletionAuditFinding } from "./compliance.js";
import type { AssuranceEvent, AssuranceRun, AssuranceRunResult, StartAssuranceRunInput } from "./contracts.js";
import type { DatabaseAssuranceSnapshotInput, DatabaseAssuranceSnapshotResult } from "./database-snapshot.js";
import { backfillAssuranceBindingChecks } from "./binding-store.js";
import {
  ASSURANCE_BINDING_MIGRATION,
  ASSURANCE_DECISION_EVIDENCE_MIGRATION,
  ASSURANCE_EVIDENCE_INTEGRITY_MIGRATION,
  ASSURANCE_RECOVERY_METRIC_MIGRATION,
  ASSURANCE_RUN_MIGRATION,
} from "./schema.js";

export interface AssuranceRunGateway {
  start(context: TenantContext, input: StartAssuranceRunInput): Promise<AssuranceRunResult>;
  get(context: TenantContext, assuranceRunId: string): Promise<AssuranceRun>;
  listCriteria(context: TenantContext, assuranceRunId: string): ReturnType<AssuranceRunStore["listCriteria"]>;
  prepareSnapshot(
    context: TenantContext,
    input: DatabaseAssuranceSnapshotInput,
  ): Promise<DatabaseAssuranceSnapshotResult>;
  listEvents(context: TenantContext, assuranceRunId: string): Promise<AssuranceEvent[]>;
  decide(context: TenantContext, input: DecideAssuranceInput): Promise<DecideAssuranceResult>;
  recover(
    context: TenantContext,
    input: { readonly commandId: string; readonly assuranceRunId: string },
  ): Promise<{ readonly run: AssuranceRun; readonly result: AssuranceRecoveryResult }>;
  auditCompletedWorks(context: TenantContext): Promise<AssuranceCompletionAuditFinding[]>;
  assertRestoredCompliance(context: TenantContext): Promise<void>;
}

export const AssuranceBootstrap = {
  async create(database: MassionDatabase, organizations: OrganizationService): Promise<AssuranceRunGateway> {
    await WorkService.create(database, organizations);
    await applyMigrations(database, [
      ORGANIZATION_GRAPH_MIGRATION,
      RUNTIME_EXECUTION_MIGRATION,
      RUNTIME_BLOCKED_TRANSITION_MIGRATION,
      GOVERNANCE_DECISION_MIGRATION,
      ORGANIZATION_CAPABILITY_MIGRATION,
      ASSURANCE_RUN_MIGRATION,
      GOVERNANCE_DECISION_CONTEXT_MIGRATION,
      ASSURANCE_BINDING_MIGRATION,
      WORK_ASSURANCE_LINK_MIGRATION,
      ASSURANCE_EVIDENCE_INTEGRITY_MIGRATION,
      ASSURANCE_DECISION_EVIDENCE_MIGRATION,
      ASSURANCE_RECOVERY_METRIC_MIGRATION,
    ]);
    await backfillAssuranceBindingChecks(database);
    const runs = await AssuranceRunStore.create(database, organizations);
    const assurance = await AssuranceService.create(database, organizations);
    const recovery = await AssuranceRecovery.create(database, organizations);
    const compliance = new AssuranceComplianceAuditor(database, organizations);
    await compliance.assertDatabaseCompliance();
    return Object.freeze({
      start: runs.start.bind(runs),
      get: runs.get.bind(runs),
      listCriteria: runs.listCriteria.bind(runs),
      prepareSnapshot: runs.prepareSnapshot.bind(runs),
      listEvents: runs.listEvents.bind(runs),
      decide: assurance.decide.bind(assurance),
      recover: recovery.recover.bind(recovery),
      auditCompletedWorks: compliance.auditCompletedWorks.bind(compliance),
      assertRestoredCompliance: compliance.assertRestoredCompliance.bind(compliance),
    });
  },
} as const;
