import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase, listAppliedMigrations, type MassionDatabase } from "@massion/storage";

import { RecordsBootstrap } from "./bootstrap.js";

describe("Records bootstrap", () => {
  let database: MassionDatabase;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
  });

  afterEach(async () => database.close());

  it("migration·service·metric·recovery를 gateway 활성화 전에 조립한다", async () => {
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({
      email: "records-bootstrap@example.com",
      displayName: "Bootstrap",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const continuation = { resume: vi.fn(async () => undefined) };

    const bootstrap = await RecordsBootstrap.create(database, organizations, { continuation });

    expect(bootstrap.service).toBeDefined();
    expect(bootstrap.recovery).toBeDefined();
    expect(bootstrap.metrics).toBeDefined();
    expect((await listAppliedMigrations(database)).map((migration) => migration.migration_id)).toEqual(
      expect.arrayContaining([
        "0047-records-documentation",
        "0048-work-records-link",
        "0049-work-records-completion",
        "0050-records-recovery-metric",
      ]),
    );
    await expect(bootstrap.metrics.aggregate(context)).resolves.toEqual([]);
  });
});
