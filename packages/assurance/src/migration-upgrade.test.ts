import { afterEach, describe, expect, it } from "vitest";

import { GOVERNANCE_DECISION_CONTEXT_MIGRATION, GOVERNANCE_DECISION_MIGRATION } from "@massion/governance";
import { applyMigrations, createDatabase, listAppliedMigrations, type MassionDatabase } from "@massion/storage";

import {
  assuranceBindingIdentityChecksum,
  backfillAssuranceBindingChecks,
  type AssuranceCheckBinding,
} from "./binding-store.js";
import {
  ASSURANCE_BINDING_MIGRATION,
  ASSURANCE_EVIDENCE_INTEGRITY_MIGRATION,
  ASSURANCE_RUN_MIGRATION,
} from "./schema.js";

describe("Assurance binding 순방향 migration", () => {
  let database: MassionDatabase | undefined;

  afterEach(async () => database?.close());

  it("기존 0017·0039 checksum을 고정하고 적용된 Task 1 DB를 0040·0041로 upgrade한다", async () => {
    expect(GOVERNANCE_DECISION_MIGRATION.checksum).toBe(
      "9994f399ff45ead2a1455f33f47e3982cac0e8d35dad93a58dec49af64eaf740",
    );
    expect(ASSURANCE_RUN_MIGRATION.checksum).toBe("ac01528f69d5bd4b2cb125a2ac1955f043889f737d55600c09755c3bd8948076");
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    expect(await applyMigrations(database, [GOVERNANCE_DECISION_MIGRATION, ASSURANCE_RUN_MIGRATION])).toEqual([
      "0017-governance-decision",
      "0039-assurance-run",
    ]);

    expect(
      await applyMigrations(database, [
        GOVERNANCE_DECISION_MIGRATION,
        ASSURANCE_RUN_MIGRATION,
        GOVERNANCE_DECISION_CONTEXT_MIGRATION,
        ASSURANCE_BINDING_MIGRATION,
      ]),
    ).toEqual(["0040-governance-decision-context", "0041-assurance-binding"]);
    expect((await listAppliedMigrations(database)).map((migration) => migration.migration_id)).toEqual([
      "0017-governance-decision",
      "0039-assurance-run",
      "0040-governance-decision-context",
      "0041-assurance-binding",
    ]);
    await expect(database.query("INFO FOR TABLE assurance_binding_event;")).resolves.toBeDefined();
  });

  it("0043 이전 binding의 identity manifest와 check projection을 안전하게 backfill한다", async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    await applyMigrations(database, [
      GOVERNANCE_DECISION_MIGRATION,
      ASSURANCE_RUN_MIGRATION,
      GOVERNANCE_DECISION_CONTEXT_MIGRATION,
      ASSURANCE_BINDING_MIGRATION,
    ]);
    const binding: AssuranceCheckBinding = {
      bindingKey: "evidence:upgrade",
      criterionKey: "profile:acceptance:coverage",
      kind: "evidence",
      executor: { kind: "system_adapter", adapterId: "massion.evidence.v1" },
      evidenceKinds: ["check-result"],
      maximumAgeMs: 60_000,
      requiredEvidenceKinds: ["check-result"],
    };
    await database.query(
      "CREATE assurance_binding_version CONTENT { binding_version_id: 'binding-upgrade', organization_id: 'organization-upgrade', work_id: 'work-upgrade', plan_version_id: 'plan-upgrade', version: 1, revision: 1, status: 'draft', profile_id: 'massion.assurance.acceptance.v1', profile_version: '1.0.0', bindings_json: $bindings_json, criteria_checksum: $criteria_checksum, checksum: $checksum, author_handle: 'context-strategy', created_by_user_id: 'user-upgrade', created_at: time::now() };",
      {
        bindings_json: JSON.stringify([binding]),
        criteria_checksum: "a".repeat(64),
        checksum: "b".repeat(64),
      },
    );
    await applyMigrations(database, [ASSURANCE_EVIDENCE_INTEGRITY_MIGRATION]);

    await backfillAssuranceBindingChecks(database);

    const [manifests] = await database.query<[{ identity_checksum: string }[]]>(
      "SELECT identity_checksum FROM assurance_binding_check_manifest WHERE binding_version_id = 'binding-upgrade';",
    );
    const [checks] = await database.query<[{ identity_checksum: string }[]]>(
      "SELECT identity_checksum FROM assurance_binding_check WHERE binding_version_id = 'binding-upgrade';",
    );
    const identityChecksum = assuranceBindingIdentityChecksum(binding);
    expect(manifests).toEqual([{ identity_checksum: identityChecksum }]);
    expect(checks).toEqual([{ identity_checksum: identityChecksum }]);
  });
});
