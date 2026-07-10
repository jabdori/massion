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

  it("손상된 restored completed Work는 service 활성화 전에 거부한다", async () => {
    await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    await database.query(
      "DEFINE TABLE work SCHEMALESS; CREATE work CONTENT { organization_id: 'organization-corrupt', work_id: 'work-corrupt', status: 'completed', revision: 11, records_schema_version: 'massion.work.records.v1' };",
    );

    await expect(
      RecordsBootstrap.create(database, organizations, {
        continuation: { resume: vi.fn(async () => undefined) },
      }),
    ).rejects.toThrow("RecordsRun");
  });
});
