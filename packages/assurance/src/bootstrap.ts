import { GOVERNANCE_DECISION_CONTEXT_MIGRATION, GOVERNANCE_DECISION_MIGRATION } from "@massion/governance";
import type { OrganizationService, TenantContext } from "@massion/identity";
import { ORGANIZATION_CAPABILITY_MIGRATION, ORGANIZATION_GRAPH_MIGRATION } from "@massion/organization";
import { RUNTIME_BLOCKED_TRANSITION_MIGRATION, RUNTIME_EXECUTION_MIGRATION } from "@massion/runtime";
import { applyMigrations, type MassionDatabase } from "@massion/storage";
import { WORK_ASSURANCE_LINK_MIGRATION, WorkService } from "@massion/work";

import { AssuranceRunStore } from "./run-store.js";
import type { AssuranceEvent, AssuranceRun, AssuranceRunResult, StartAssuranceRunInput } from "./contracts.js";
import type { DatabaseAssuranceSnapshotInput, DatabaseAssuranceSnapshotResult } from "./database-snapshot.js";
import { backfillAssuranceBindingChecks } from "./binding-store.js";
import {
  ASSURANCE_BINDING_MIGRATION,
  ASSURANCE_EVIDENCE_INTEGRITY_MIGRATION,
  ASSURANCE_RUN_MIGRATION,
} from "./schema.js";

export interface AssuranceRunGateway {
  start(context: TenantContext, input: StartAssuranceRunInput): Promise<AssuranceRunResult>;
  get(context: TenantContext, assuranceRunId: string): Promise<AssuranceRun>;
  prepareSnapshot(
    context: TenantContext,
    input: DatabaseAssuranceSnapshotInput,
  ): Promise<DatabaseAssuranceSnapshotResult>;
  listEvents(context: TenantContext, assuranceRunId: string): Promise<AssuranceEvent[]>;
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
    ]);
    await backfillAssuranceBindingChecks(database);
    const runs = await AssuranceRunStore.create(database, organizations);
    return Object.freeze({
      start: runs.start.bind(runs),
      get: runs.get.bind(runs),
      prepareSnapshot: runs.prepareSnapshot.bind(runs),
      listEvents: runs.listEvents.bind(runs),
    });
  },
} as const;
