import { afterEach, describe, expect, it } from "vitest";

import { GOVERNANCE_DECISION_CONTEXT_MIGRATION, GOVERNANCE_DECISION_MIGRATION } from "@massion/governance";
import { applyMigrations, createDatabase, listAppliedMigrations, type MassionDatabase } from "@massion/storage";

import {
  DEFAULT_INSPECTION_MAXIMUM_AGE_MS,
  assuranceBindingPolicyChecksum,
  assuranceBindingIdentityChecksum,
  backfillAssuranceBindingChecks,
  type AssuranceCheckBinding,
} from "./binding-store.js";
import {
  ASSURANCE_BINDING_MIGRATION,
  ASSURANCE_DECISION_EVIDENCE_MIGRATION,
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

  it("0041-era inspection binding에 deterministic freshness 기본값을 적용해 0045 policy를 backfill한다", async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    await applyMigrations(database, [
      GOVERNANCE_DECISION_MIGRATION,
      ASSURANCE_RUN_MIGRATION,
      GOVERNANCE_DECISION_CONTEXT_MIGRATION,
      ASSURANCE_BINDING_MIGRATION,
      ASSURANCE_EVIDENCE_INTEGRITY_MIGRATION,
    ]);
    const legacyBinding = {
      bindingKey: "inspection:legacy",
      criterionKey: "security:legacy",
      kind: "inspection",
      executor: { kind: "runtime_agent", handle: "security-review" },
      inspectorProfile: "massion.inspection.security.v1",
      evidenceAllowlist: ["artifact-version"],
      maximumFindings: 10,
      requiredEvidenceKinds: ["finding"],
    } as const;
    await database.query(
      "CREATE assurance_binding_version CONTENT { binding_version_id: 'binding-inspection-legacy', organization_id: 'organization-upgrade', work_id: 'work-upgrade', plan_version_id: 'plan-upgrade', version: 1, revision: 1, status: 'draft', profile_id: 'massion.assurance.software-change.v1', profile_version: '1.0.0', bindings_json: $bindings_json, criteria_checksum: $criteria_checksum, checksum: $checksum, author_handle: 'context-strategy', created_by_user_id: 'user-upgrade', created_at: time::now() };",
      {
        bindings_json: JSON.stringify([legacyBinding]),
        criteria_checksum: "a".repeat(64),
        checksum: "b".repeat(64),
      },
    );

    await backfillAssuranceBindingChecks(database);

    const [policies] = await database.query<[{ maximum_age_ms: number; policy_checksum: string }[]]>(
      "SELECT maximum_age_ms, policy_checksum FROM assurance_binding_check WHERE binding_version_id = 'binding-inspection-legacy';",
    );
    expect(policies).toEqual([
      {
        maximum_age_ms: DEFAULT_INSPECTION_MAXIMUM_AGE_MS,
        policy_checksum: assuranceBindingPolicyChecksum(legacyBinding),
      },
    ]);
  });

  it("0039 terminal run을 0045 evidence guard로 순방향 backfill한다", async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    await applyMigrations(database, [ASSURANCE_RUN_MIGRATION]);
    await database.query(
      "CREATE assurance_run CONTENT { assurance_run_id: 'legacy-run', organization_id: 'legacy-org', work_id: 'legacy-work', target_work_revision: 1, plan_version_id: 'legacy-plan', binding_version_id: 'legacy-binding', profile_id: 'massion.assurance.acceptance.v1', profile_version: '1.0.0', verifier_handle: 'assurance', verifier_execution_id: 'legacy-execution', snapshot_hash: $snapshot_hash, status: 'passed', version: 1, attempt: 1, start_command_id: 'legacy-start', verdict: 'passed', created_by_user_id: 'legacy-user', expires_at: time::now() + 1h, started_at: time::now(), completed_at: time::now(), updated_at: time::now() };",
      { snapshot_hash: "a".repeat(64) },
    );

    expect(await applyMigrations(database, [ASSURANCE_DECISION_EVIDENCE_MIGRATION])).toEqual([
      "0045-assurance-decision-evidence",
    ]);
    const [guards] = await database.query<[{ assurance_run_id: string; revision: number }[]]>(
      "SELECT assurance_run_id, revision FROM assurance_evidence_guard WHERE assurance_run_id = 'legacy-run';",
    );
    expect(guards).toEqual([{ assurance_run_id: "legacy-run", revision: 0 }]);
  });

  it("0045 적용 뒤 Assurance가 참조하는 EvidenceBrief의 변경을 거부한다", async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    await applyMigrations(database, [ASSURANCE_RUN_MIGRATION, ASSURANCE_DECISION_EVIDENCE_MIGRATION]);
    await database.query(
      "CREATE evidence_brief CONTENT { evidence_brief_id: 'brief-upgrade', organization_id: 'legacy-org', work_id: 'legacy-work', claims_json: '[]' };",
    );

    await expect(
      database.query('UPDATE evidence_brief SET claims_json = \'[{\\"claim\\":\\"tampered\\"}]\';'),
    ).rejects.toThrow("EvidenceBrief는 immutable");
  });
});
