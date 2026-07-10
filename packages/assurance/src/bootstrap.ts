import { GOVERNANCE_DECISION_CONTEXT_MIGRATION, GOVERNANCE_DECISION_MIGRATION } from "@massion/governance";
import type { OrganizationService } from "@massion/identity";
import { ORGANIZATION_CAPABILITY_MIGRATION, ORGANIZATION_GRAPH_MIGRATION } from "@massion/organization";
import { RUNTIME_BLOCKED_TRANSITION_MIGRATION, RUNTIME_EXECUTION_MIGRATION } from "@massion/runtime";
import { applyMigrations, type MassionDatabase } from "@massion/storage";
import { WORK_ASSURANCE_LINK_MIGRATION, WorkService } from "@massion/work";

import { AssuranceRunStore } from "./run-store.js";
import { ASSURANCE_BINDING_MIGRATION, ASSURANCE_RUN_MIGRATION } from "./schema.js";

export const AssuranceBootstrap = {
  async create(database: MassionDatabase, organizations: OrganizationService): Promise<AssuranceRunStore> {
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
    ]);
    return await AssuranceRunStore.create(database, organizations);
  },
} as const;
