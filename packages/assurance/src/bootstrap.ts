import type { OrganizationService } from "@massion/identity";
import type { MassionDatabase } from "@massion/storage";

import { AssuranceRunStore } from "./run-store.js";

export const AssuranceBootstrap = {
  async create(database: MassionDatabase, organizations: OrganizationService): Promise<AssuranceRunStore> {
    return await AssuranceRunStore.create(database, organizations);
  },
} as const;
