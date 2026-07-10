import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { RuntimeExecutionStore } from "@massion/runtime";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";

import {
  AssuranceBootstrap,
  AssuranceCheckStore,
  AssuranceFindingStore,
  assuranceBindingIdentityChecksum,
  assuranceBindingPolicyChecksum,
  type TrustedAssuranceInspectionExecutor,
} from "./index.js";

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("AssuranceFinding", () => {
  let database: MassionDatabase;
  let organizations: OrganizationService;
  let context: TenantContext;
  let otherContext: TenantContext;
  let workId: string;
  let assuranceRunId: string;
  let criterionId: string;
  let modelCriterionId: string;
  let evidenceCriterionId: string;
  let briefCriterionId: string;
  let modelExecutionId: string;
  let artifactVersionId: string;
  let store: AssuranceFindingStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "finding@example.com", displayName: "Finding" });
    const other = await identity.registerPersonalUser({ email: "finding-other@example.com", displayName: "Other" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    otherContext = await organizations.resolveTenantContext(other.user.user_id, other.organization.organization_id);
    const graph = await OrganizationGraphService.create(database, organizations);
    await graph.bootstrap(context);
    await AssuranceBootstrap.create(database, organizations);
    const works = await WorkService.create(database, organizations, graph);
    const created = await works.createWork(context, {
      commandId: crypto.randomUUID(),
      text: "finding source",
      surface: "test",
      organizationVersionId: "organization-version-1",
    });
    workId = created.work.work_id;
    const artifact = await works.createArtifactVersion(context, {
      commandId: crypto.randomUUID(),
      workId,
      expectedRevision: created.work.revision,
      kind: "sarif",
      name: "scan.sarif",
      mediaType: "application/sarif+json",
      content: { version: "2.1.0", runs: [] },
    });
    artifactVersionId = artifact.artifactVersion.artifact_version_id;
    for (const status of ["planned", "ready", "running", "verifying"] as const) {
      await database.query(
        "UPDATE work SET status = $status, revision += 1, updated_at = time::now() WHERE organization_id = $organization_id AND work_id = $work_id;",
        { status, organization_id: context.organizationId, work_id: workId },
      );
    }
    const [worksAtRevision] = await database.query<[{ revision: number }[]]>(
      "SELECT revision FROM work WHERE organization_id = $organization_id AND work_id = $work_id LIMIT 1;",
      { organization_id: context.organizationId, work_id: workId },
    );
    const runtime = await RuntimeExecutionStore.create(database, organizations);
    const execution = await runtime.createExecution(context, {
      commandId: crypto.randomUUID(),
      workId,
      agentHandle: "assurance",
      modelRoute: "test:assurance",
      correlationId: crypto.randomUUID(),
      estimatedTokens: 1,
      estimatedCostMicros: 0,
      input: { operation: "finding" },
    });
    const modelQueued = await runtime.createExecution(context, {
      commandId: crypto.randomUUID(),
      workId,
      agentHandle: "security-review",
      modelRoute: "test:security-review",
      correlationId: crypto.randomUUID(),
      estimatedTokens: 1,
      estimatedCostMicros: 0,
      input: { operation: "inspection" },
    });
    const modelRunning = await runtime.transition(context, {
      commandId: crypto.randomUUID(),
      executionId: modelQueued.execution.execution_id,
      expectedVersion: modelQueued.execution.version,
      target: "running",
      payload: { started: true },
    });
    const modelSucceeded = await runtime.transition(context, {
      commandId: crypto.randomUUID(),
      executionId: modelRunning.execution.execution_id,
      expectedVersion: modelRunning.execution.version,
      target: "succeeded",
      payload: { findings: [] },
    });
    modelExecutionId = modelSucceeded.execution.execution_id;
    assuranceRunId = crypto.randomUUID();
    await database.query(
      "CREATE assurance_run CONTENT { assurance_run_id: $assurance_run_id, organization_id: $organization_id, work_id: $work_id, target_work_revision: $target_work_revision, plan_version_id: 'plan-1', binding_version_id: 'binding-1', profile_id: 'massion.assurance.software-change.v1', profile_version: '1.0.0', verifier_handle: 'assurance', verifier_execution_id: $execution_id, snapshot_hash: $snapshot_hash, status: 'planned', version: 1, attempt: 1, start_command_id: $command_id, active_guard_key: $active_guard_key, created_by_user_id: $user_id, expires_at: time::now() + 1h, started_at: time::now(), updated_at: time::now() };",
      {
        assurance_run_id: assuranceRunId,
        organization_id: context.organizationId,
        work_id: workId,
        target_work_revision: worksAtRevision[0]?.revision,
        execution_id: execution.execution.execution_id,
        snapshot_hash: "b".repeat(64),
        command_id: crypto.randomUUID(),
        active_guard_key: crypto.randomUUID(),
        user_id: context.userId,
      },
    );
    criterionId = crypto.randomUUID();
    await database.query(
      "CREATE assurance_criterion CONTENT { criterion_id: $criterion_id, organization_id: $organization_id, work_id: $work_id, assurance_run_id: $assurance_run_id, criterion_key: 'security:scan', source: 'profile', statement: '보안 finding을 판정한다', method: 'inspection', required_evidence_kinds: ['sarif'], control_references: ['OWASP-ASVS-5.0.0'], status: 'pending', created_at: time::now(), updated_at: time::now() };",
      {
        criterion_id: criterionId,
        organization_id: context.organizationId,
        work_id: workId,
        assurance_run_id: assuranceRunId,
      },
    );
    modelCriterionId = crypto.randomUUID();
    await database.query(
      "CREATE assurance_criterion CONTENT { criterion_id: $criterion_id, organization_id: $organization_id, work_id: $work_id, assurance_run_id: $assurance_run_id, criterion_key: 'security:model', source: 'profile', statement: '모델 finding을 판정한다', method: 'inspection', required_evidence_kinds: ['artifact-version'], control_references: ['OWASP-ASVS-5.0.0'], status: 'pending', created_at: time::now(), updated_at: time::now() };",
      {
        criterion_id: modelCriterionId,
        organization_id: context.organizationId,
        work_id: workId,
        assurance_run_id: assuranceRunId,
      },
    );
    evidenceCriterionId = crypto.randomUUID();
    await database.query(
      "CREATE assurance_criterion CONTENT { criterion_id: $criterion_id, organization_id: $organization_id, work_id: $work_id, assurance_run_id: $assurance_run_id, criterion_key: 'security:evidence', source: 'profile', statement: '증거 무결성을 판정한다', method: 'evidence', required_evidence_kinds: ['artifact-version'], control_references: [], status: 'pending', created_at: time::now(), updated_at: time::now() };",
      {
        criterion_id: evidenceCriterionId,
        organization_id: context.organizationId,
        work_id: workId,
        assurance_run_id: assuranceRunId,
      },
    );
    briefCriterionId = crypto.randomUUID();
    await database.query(
      "CREATE assurance_criterion CONTENT { criterion_id: $criterion_id, organization_id: $organization_id, work_id: $work_id, assurance_run_id: $assurance_run_id, criterion_key: 'security:brief', source: 'profile', statement: 'EvidenceBrief 신선도를 판정한다', method: 'evidence', required_evidence_kinds: ['evidence-brief'], control_references: [], status: 'pending', created_at: time::now(), updated_at: time::now() };",
      {
        criterion_id: briefCriterionId,
        organization_id: context.organizationId,
        work_id: workId,
        assurance_run_id: assuranceRunId,
      },
    );
    const inspectionBinding = {
      kind: "inspection" as const,
      bindingKey: "inspection:security",
      criterionKey: "security:scan",
      executor: { kind: "system_adapter" as const, adapterId: "massion.sarif.v1" },
      requiredEvidenceKinds: ["sarif"],
      inspectorProfile: "security",
      evidenceAllowlist: [artifactVersionId],
      maximumAgeMs: 60_000,
      maximumFindings: 100,
    };
    const identityChecksum = assuranceBindingIdentityChecksum(inspectionBinding);
    const modelBinding = {
      kind: "inspection" as const,
      bindingKey: "inspection:model",
      criterionKey: "security:model",
      executor: { kind: "runtime_agent" as const, handle: "security-review" },
      requiredEvidenceKinds: ["finding"],
      inspectorProfile: "massion.inspection.security.v1",
      evidenceAllowlist: ["artifact-version", "evidence-brief"],
      maximumAgeMs: 60_000,
      maximumFindings: 10,
    };
    const modelIdentityChecksum = assuranceBindingIdentityChecksum(modelBinding);
    const evidenceBinding = {
      kind: "evidence" as const,
      bindingKey: "evidence:integrity",
      criterionKey: "security:evidence",
      executor: { kind: "system_adapter" as const, adapterId: "massion.evidence.v1" },
      requiredEvidenceKinds: ["artifact-version"],
      evidenceKinds: ["artifact-version"],
      maximumAgeMs: 60_000,
    };
    const evidenceIdentityChecksum = assuranceBindingIdentityChecksum(evidenceBinding);
    const policyChecksum = assuranceBindingPolicyChecksum(inspectionBinding);
    const modelPolicyChecksum = assuranceBindingPolicyChecksum(modelBinding);
    const evidencePolicyChecksum = assuranceBindingPolicyChecksum(evidenceBinding);
    const briefBinding = {
      kind: "evidence" as const,
      bindingKey: "evidence:brief",
      criterionKey: "security:brief",
      executor: { kind: "system_adapter" as const, adapterId: "massion.evidence.v1" },
      requiredEvidenceKinds: ["evidence-brief"],
      evidenceKinds: ["evidence-brief"],
      maximumAgeMs: 60_000,
    };
    const briefIdentityChecksum = assuranceBindingIdentityChecksum(briefBinding);
    const briefPolicyChecksum = assuranceBindingPolicyChecksum(briefBinding);
    await database.query(
      "CREATE assurance_binding_version CONTENT { binding_version_id: 'binding-1', organization_id: $organization_id, work_id: $work_id, plan_version_id: 'plan-1', version: 1, revision: 1, status: 'draft', profile_id: 'massion.assurance.software-change.v1', profile_version: '1.0.0', bindings_json: $bindings_json, criteria_checksum: $criteria_checksum, checksum: $checksum, author_handle: 'context-strategy', created_by_user_id: $user_id, created_at: time::now() }; CREATE assurance_binding_check_manifest CONTENT { binding_version_id: 'binding-1', organization_id: $organization_id, work_id: $work_id, identity_checksum: $identity_checksum, created_at: time::now() }; CREATE assurance_binding_check_manifest CONTENT { binding_version_id: 'binding-1', organization_id: $organization_id, work_id: $work_id, identity_checksum: $model_identity_checksum, created_at: time::now() }; CREATE assurance_binding_check_manifest CONTENT { binding_version_id: 'binding-1', organization_id: $organization_id, work_id: $work_id, identity_checksum: $evidence_identity_checksum, created_at: time::now() }; CREATE assurance_binding_check CONTENT { binding_version_id: 'binding-1', organization_id: $organization_id, work_id: $work_id, binding_key: 'inspection:security', criterion_key: 'security:scan', kind: 'inspection', executor_kind: 'system_adapter', executor_id: 'massion.sarif.v1', eligible_roles: [], required_evidence_kinds: ['sarif'], evidence_kinds: [], evidence_allowlist: [$artifact_version_id], maximum_age_ms: 60000, policy_checksum: $policy_checksum, identity_checksum: $identity_checksum, created_at: time::now() }; CREATE assurance_binding_check CONTENT { binding_version_id: 'binding-1', organization_id: $organization_id, work_id: $work_id, binding_key: 'inspection:model', criterion_key: 'security:model', kind: 'inspection', executor_kind: 'runtime_agent', executor_id: 'security-review', eligible_roles: [], required_evidence_kinds: ['finding'], evidence_kinds: [], evidence_allowlist: ['artifact-version', 'evidence-brief'], maximum_age_ms: 60000, policy_checksum: $model_policy_checksum, identity_checksum: $model_identity_checksum, created_at: time::now() }; CREATE assurance_binding_check CONTENT { binding_version_id: 'binding-1', organization_id: $organization_id, work_id: $work_id, binding_key: 'evidence:integrity', criterion_key: 'security:evidence', kind: 'evidence', executor_kind: 'system_adapter', executor_id: 'massion.evidence.v1', eligible_roles: [], required_evidence_kinds: ['artifact-version'], evidence_kinds: ['artifact-version'], evidence_allowlist: [], maximum_age_ms: 60000, policy_checksum: $evidence_policy_checksum, identity_checksum: $evidence_identity_checksum, created_at: time::now() };",
      {
        organization_id: context.organizationId,
        work_id: workId,
        bindings_json: JSON.stringify([inspectionBinding, modelBinding, evidenceBinding, briefBinding]),
        criteria_checksum: "a".repeat(64),
        checksum: "b".repeat(64),
        identity_checksum: identityChecksum,
        model_identity_checksum: modelIdentityChecksum,
        evidence_identity_checksum: evidenceIdentityChecksum,
        policy_checksum: policyChecksum,
        model_policy_checksum: modelPolicyChecksum,
        evidence_policy_checksum: evidencePolicyChecksum,
        artifact_version_id: artifactVersionId,
        user_id: context.userId,
      },
    );
    await database.query(
      "CREATE assurance_binding_check_manifest CONTENT { binding_version_id: 'binding-1', organization_id: $organization_id, work_id: $work_id, identity_checksum: $identity_checksum, created_at: time::now() }; CREATE assurance_binding_check CONTENT { binding_version_id: 'binding-1', organization_id: $organization_id, work_id: $work_id, binding_key: 'evidence:brief', criterion_key: 'security:brief', kind: 'evidence', executor_kind: 'system_adapter', executor_id: 'massion.evidence.v1', eligible_roles: [], required_evidence_kinds: ['evidence-brief'], evidence_kinds: ['evidence-brief'], evidence_allowlist: [], maximum_age_ms: 60000, policy_checksum: $policy_checksum, identity_checksum: $identity_checksum, created_at: time::now() };",
      {
        organization_id: context.organizationId,
        work_id: workId,
        identity_checksum: briefIdentityChecksum,
        policy_checksum: briefPolicyChecksum,
      },
    );
    const decisionId = crypto.randomUUID();
    await database.query(
      "CREATE governance_policy_decision CONTENT { decision_id: $decision_id, organization_id: $organization_id, command_id: $command_id, request_hash: $request_hash, principal_type: 'Human', principal_id: $principal_id, action: 'work.execute', resource_type: 'AssuranceBindingVersion', resource_id: 'binding-1', resource_revision: 1, environment: 'local', risk_class: 'assurance-binding-activation', external: false, request_summary_json: '{}', outcome: 'allow', reasons_json: '[]', errors_json: '[]', request_json: '{}', created_at: time::now() }; UPDATE assurance_binding_version SET status = 'active', revision = 2, active_guard_key = $active_guard_key, governance_decision_id = $decision_id, activated_at = time::now() WHERE organization_id = $organization_id AND binding_version_id = 'binding-1';",
      {
        decision_id: decisionId,
        organization_id: context.organizationId,
        command_id: crypto.randomUUID(),
        request_hash: "e".repeat(64),
        principal_id: context.userId,
        active_guard_key: crypto.randomUUID(),
      },
    );
    await database.query(
      "CREATE assurance_check_execution_receipt CONTENT { receipt_id: $receipt_id, organization_id: $organization_id, work_id: $work_id, assurance_run_id: $assurance_run_id, criterion_id: $criterion_id, binding_key: 'inspection:security', input_hash: $input_hash, status: 'passed', output_hash: $output_hash, artifact_version_ids: [$artifact_version_id], evidence_brief_ids: [], metric_observation_ids: [], human_attestation_ids: [], executor_kind: 'system_adapter', executor_id: 'massion.sarif.v1', created_at: time::now() }; CREATE assurance_check CONTENT { check_id: $check_id, organization_id: $organization_id, work_id: $work_id, assurance_run_id: $assurance_run_id, criterion_id: $criterion_id, kind: 'inspection', system_adapter_id: 'massion.sarif.v1', command_key: 'inspection:security', input_hash: $input_hash, execution_receipt_id: $receipt_id, status: 'passed', output_hash: $output_hash, artifact_version_ids: [$artifact_version_id], evidence_brief_ids: [], metric_observation_ids: [], human_attestation_ids: [], duration_ms: 0, created_at: time::now(), started_at: time::now(), completed_at: time::now() };",
      {
        receipt_id: crypto.randomUUID(),
        check_id: crypto.randomUUID(),
        organization_id: context.organizationId,
        work_id: workId,
        assurance_run_id: assuranceRunId,
        criterion_id: criterionId,
        input_hash: "c".repeat(64),
        output_hash: "d".repeat(64),
        artifact_version_id: artifactVersionId,
      },
    );
    store = new AssuranceFindingStore(database, organizations);
  });

  afterEach(async () => database.close());

  function input(commandId = crypto.randomUUID(), severity: "critical" | "major" | "minor" | "info" = "minor") {
    return {
      commandId,
      workId,
      assuranceRunId,
      criterionId,
      category: "security" as const,
      severity,
      message: "의존성 버전에 알려진 취약점이 있습니다",
      location: { uri: "pnpm-lock.yaml", line: 42 },
      evidenceReferenceIds: [artifactVersionId],
      sourceTool: "osv-scanner",
      sourceRule: "GHSA-test",
      controlReferences: ["OWASP-ASVS-5.0.0"],
    };
  }

  it("source·location에서 안정 fingerprint를 만들고 같은 run evidence에 결속한다", async () => {
    const finding = await store.record(context, input());
    expect(finding).toMatchObject({
      organizationId: context.organizationId,
      workId,
      assuranceRunId,
      criterionId,
      category: "security",
      severity: "minor",
      status: "open",
      evidenceReferenceIds: [artifactVersionId],
      sourceTool: "osv-scanner",
      sourceRule: "GHSA-test",
    });
    expect(finding.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("trusted model inspection의 Check와 모든 Finding을 같은 transaction에 기록한다", async () => {
    const inspectionExecutor: TrustedAssuranceInspectionExecutor = {
      inspectorProfile: "massion.inspection.security.v1",
      async execute() {
        return {
          status: "passed",
          executionId: modelExecutionId,
          outputHash: "7".repeat(64),
          summary: "모델 inspection finding 1건",
          evidenceReferenceIds: [artifactVersionId],
          artifactVersionIds: [artifactVersionId],
          evidenceBriefIds: [],
          metricObservationIds: [],
          humanAttestationIds: [],
          toolName: "massion.inspection.security.v1",
          toolVersion: "1.0.0",
          durationMs: 1,
          findings: [
            {
              category: "security",
              severity: "major",
              message: "인증 경로에서 권한 검사가 누락됐습니다",
              location: { uri: "src/auth.ts", line: 12 },
              evidenceReferenceIds: [artifactVersionId],
              sourceTool: "massion.inspection.security.v1",
              sourceRule: "AUTHZ-001",
              controlReferences: ["OWASP-ASVS-5.0.0"],
            },
          ],
        };
      },
    };
    const checks = new AssuranceCheckStore(database, organizations, {
      trustedInspectionExecutors: [inspectionExecutor],
    });
    const recorded = await checks.record(context, {
      commandId: crypto.randomUUID(),
      workId,
      assuranceRunId,
      criterionId: modelCriterionId,
      bindingKey: "inspection:model",
      artifactVersionIds: [artifactVersionId],
    });
    const [findings] = await database.query<[{ finding_id: string; severity: string }[]]>(
      "SELECT finding_id, severity FROM assurance_finding WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id AND criterion_id = $criterion_id;",
      { organization_id: context.organizationId, assurance_run_id: assuranceRunId, criterion_id: modelCriterionId },
    );
    expect(recorded).toMatchObject({ check: { status: "passed", kind: "inspection" }, criterionStatus: "passed" });
    expect(findings).toEqual([{ finding_id: expect.any(String), severity: "major" }]);
  });

  it("system execution receipt 없이 기존 evidence를 붙인 passed inspection을 직접 기록하지 못한다", async () => {
    await expect(
      database.query(
        "CREATE assurance_check CONTENT { check_id: $check_id, organization_id: $organization_id, work_id: $work_id, assurance_run_id: $assurance_run_id, criterion_id: $criterion_id, kind: 'inspection', executor_handle: 'security-review', executor_execution_id: $execution_id, command_key: 'inspection:model', input_hash: $input_hash, status: 'passed', output_hash: $output_hash, artifact_version_ids: [$artifact_version_id], evidence_brief_ids: [], metric_observation_ids: [], human_attestation_ids: [], duration_ms: 0, created_at: time::now(), started_at: time::now(), completed_at: time::now() };",
        {
          check_id: crypto.randomUUID(),
          organization_id: context.organizationId,
          work_id: workId,
          assurance_run_id: assuranceRunId,
          criterion_id: modelCriterionId,
          execution_id: modelExecutionId,
          input_hash: "8".repeat(64),
          output_hash: "9".repeat(64),
          artifact_version_id: artifactVersionId,
        },
      ),
    ).rejects.toThrow("execution receipt");
  });

  it("trusted inspection 결과가 제출 evidence의 일부를 누락하면 blocked로 저장한다", async () => {
    const incompleteExecutor: TrustedAssuranceInspectionExecutor = {
      inspectorProfile: "massion.inspection.security.v1",
      async execute() {
        return {
          status: "passed",
          executionId: modelExecutionId,
          outputHash: "5".repeat(64),
          summary: "제출 evidence를 결과에서 누락했습니다",
          evidenceReferenceIds: [],
          artifactVersionIds: [],
          evidenceBriefIds: [],
          metricObservationIds: [],
          humanAttestationIds: [],
          findings: [],
        };
      },
    };
    const checks = new AssuranceCheckStore(database, organizations, {
      trustedInspectionExecutors: [incompleteExecutor],
    });

    const recorded = await checks.record(context, {
      commandId: crypto.randomUUID(),
      workId,
      assuranceRunId,
      criterionId: modelCriterionId,
      bindingKey: "inspection:model",
      artifactVersionIds: [artifactVersionId],
    });

    expect(recorded).toMatchObject({ check: { status: "blocked" }, criterionStatus: "blocked" });
  });

  it("모델 실행 중 current IndexVersion이 바뀌면 저장 transaction 재검증으로 blocked 처리한다", async () => {
    const evidenceBriefId = crypto.randomUUID();
    const brief = {
      workId,
      repositoryId: "repository-inspection-race",
      repositoryRevisionId: "revision-before",
      indexVersionId: "index-before",
      configurationChecksum: "a".repeat(64),
      query: "권한 검사를 찾아주세요",
      status: "ready",
      references: [],
      claims: [{ statement: "기존 index claim" }],
    } as const;
    await database.query(
      "CREATE evidence_brief CONTENT { evidence_brief_id: $evidence_brief_id, organization_id: $organization_id, work_id: $work_id, repository_id: $repository_id, repository_revision_id: $repository_revision_id, index_version_id: $index_version_id, configuration_checksum: $configuration_checksum, query: $query, status: $status, references_json: $references_json, claims_json: $claims_json, checksum: $checksum, created_by_user_id: $user_id, created_at: time::now() }; CREATE index_version CONTENT { organization_id: $organization_id, repository_id: $repository_id, repository_revision_id: $repository_revision_id, index_version_id: $index_version_id, configuration_checksum: $configuration_checksum, current: true, status: 'ready' };",
      {
        evidence_brief_id: evidenceBriefId,
        organization_id: context.organizationId,
        work_id: workId,
        repository_id: brief.repositoryId,
        repository_revision_id: brief.repositoryRevisionId,
        index_version_id: brief.indexVersionId,
        configuration_checksum: brief.configurationChecksum,
        query: brief.query,
        status: brief.status,
        references_json: JSON.stringify(brief.references),
        claims_json: JSON.stringify(brief.claims),
        checksum: sha256(canonicalJson(brief)),
        user_id: context.userId,
      },
    );
    const racingExecutor: TrustedAssuranceInspectionExecutor = {
      inspectorProfile: "massion.inspection.security.v1",
      async execute() {
        return {
          status: "passed",
          executionId: modelExecutionId,
          outputHash: "4".repeat(64),
          summary: "old index 기반 검사",
          evidenceReferenceIds: [evidenceBriefId],
          artifactVersionIds: [],
          evidenceBriefIds: [evidenceBriefId],
          metricObservationIds: [],
          humanAttestationIds: [],
          findings: [],
        };
      },
    };
    let releaseRevalidation = (): void => undefined;
    let signalRevalidation = (): void => undefined;
    const revalidationReached = new Promise<void>((resolve) => {
      signalRevalidation = resolve;
    });
    const continueAfterIndexChange = new Promise<void>((resolve) => {
      releaseRevalidation = resolve;
    });
    let paused = false;
    const checks = new AssuranceCheckStore(database, organizations, {
      trustedInspectionExecutors: [racingExecutor],
      async afterEvidenceRevalidation() {
        if (paused) return;
        paused = true;
        signalRevalidation();
        await continueAfterIndexChange;
      },
    });

    const pending = checks.record(context, {
      commandId: crypto.randomUUID(),
      workId,
      assuranceRunId,
      criterionId: modelCriterionId,
      bindingKey: "inspection:model",
      evidenceBriefIds: [evidenceBriefId],
    });
    await revalidationReached;
    try {
      await database.query(
        "UPDATE index_version SET current = false WHERE organization_id = $organization_id AND repository_id = $repository_id AND current = true; CREATE index_version CONTENT { organization_id: $organization_id, repository_id: $repository_id, repository_revision_id: 'revision-after', index_version_id: 'index-after', configuration_checksum: $configuration_checksum, current: true, status: 'ready' };",
        {
          organization_id: context.organizationId,
          repository_id: brief.repositoryId,
          configuration_checksum: brief.configurationChecksum,
        },
      );
    } finally {
      releaseRevalidation();
    }
    const recorded = await pending;

    expect(recorded).toMatchObject({ check: { status: "blocked" }, criterionStatus: "blocked" });
    expect(recorded.check.outputSummary).toContain("재검증 실패");
  });

  it("evidence Check 재검증 뒤 current IndexVersion 변경도 guard 충돌 재시도로 blocked 처리한다", async () => {
    const evidenceBriefId = crypto.randomUUID();
    const brief = {
      workId,
      repositoryId: "repository-evidence-race",
      repositoryRevisionId: "revision-before",
      indexVersionId: "index-before",
      configurationChecksum: "b".repeat(64),
      query: "배포 근거를 찾아주세요",
      status: "ready",
      references: [],
      claims: [{ statement: "기존 배포 근거" }],
    } as const;
    await database.query(
      "CREATE evidence_brief CONTENT { evidence_brief_id: $evidence_brief_id, organization_id: $organization_id, work_id: $work_id, repository_id: $repository_id, repository_revision_id: $repository_revision_id, index_version_id: $index_version_id, configuration_checksum: $configuration_checksum, query: $query, status: $status, references_json: $references_json, claims_json: $claims_json, checksum: $checksum, created_by_user_id: $user_id, created_at: time::now() }; CREATE index_version CONTENT { organization_id: $organization_id, repository_id: $repository_id, repository_revision_id: $repository_revision_id, index_version_id: $index_version_id, configuration_checksum: $configuration_checksum, current: true, status: 'ready' };",
      {
        evidence_brief_id: evidenceBriefId,
        organization_id: context.organizationId,
        work_id: workId,
        repository_id: brief.repositoryId,
        repository_revision_id: brief.repositoryRevisionId,
        index_version_id: brief.indexVersionId,
        configuration_checksum: brief.configurationChecksum,
        query: brief.query,
        status: brief.status,
        references_json: JSON.stringify(brief.references),
        claims_json: JSON.stringify(brief.claims),
        checksum: sha256(canonicalJson(brief)),
        user_id: context.userId,
      },
    );
    let releaseRevalidation = (): void => undefined;
    let signalRevalidation = (): void => undefined;
    const revalidationReached = new Promise<void>((resolve) => {
      signalRevalidation = resolve;
    });
    const continueAfterIndexChange = new Promise<void>((resolve) => {
      releaseRevalidation = resolve;
    });
    let paused = false;
    const checks = new AssuranceCheckStore(database, organizations, {
      async afterEvidenceRevalidation() {
        if (paused) return;
        paused = true;
        signalRevalidation();
        await continueAfterIndexChange;
      },
    });
    const pending = checks.record(context, {
      commandId: crypto.randomUUID(),
      workId,
      assuranceRunId,
      criterionId: briefCriterionId,
      bindingKey: "evidence:brief",
      evidenceBriefIds: [evidenceBriefId],
    });
    await revalidationReached;
    try {
      await database.query(
        "UPDATE index_version SET current = false WHERE organization_id = $organization_id AND repository_id = $repository_id AND current = true; CREATE index_version CONTENT { organization_id: $organization_id, repository_id: $repository_id, repository_revision_id: 'revision-after', index_version_id: 'index-after', configuration_checksum: $configuration_checksum, current: true, status: 'ready' };",
        {
          organization_id: context.organizationId,
          repository_id: brief.repositoryId,
          configuration_checksum: brief.configurationChecksum,
        },
      );
    } finally {
      releaseRevalidation();
    }

    const recorded = await pending;
    expect(recorded).toMatchObject({ check: { status: "blocked" }, criterionStatus: "blocked" });
    expect(recorded.check.outputSummary).toContain("repository revision");
  });

  it("evidence checksum 변조를 failed Check와 critical security Finding으로 원자 기록한다", async () => {
    const tamperedArtifactVersionId = crypto.randomUUID();
    await database.query(
      "CREATE artifact_version CONTENT { artifact_version_id: $artifact_version_id, artifact_id: $artifact_id, organization_id: $organization_id, work_id: $work_id, version: 1, checksum: $checksum, media_type: 'application/json', content_json: $content_json, created_by: $user_id, created_at: time::now() };",
      {
        artifact_version_id: tamperedArtifactVersionId,
        artifact_id: crypto.randomUUID(),
        organization_id: context.organizationId,
        work_id: workId,
        checksum: "0".repeat(64),
        content_json: '{"tampered":true}',
        user_id: context.userId,
      },
    );
    const checks = new AssuranceCheckStore(database, organizations);

    const recorded = await checks.record(context, {
      commandId: crypto.randomUUID(),
      workId,
      assuranceRunId,
      criterionId: evidenceCriterionId,
      bindingKey: "evidence:integrity",
      artifactVersionIds: [tamperedArtifactVersionId],
    });
    const [findings] = await database.query<
      [{ category: string; severity: string; source_rule: string; evidence_reference_ids: string[] }[]]
    >(
      "SELECT category, severity, source_rule, evidence_reference_ids FROM assurance_finding WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id AND criterion_id = $criterion_id;",
      {
        organization_id: context.organizationId,
        assurance_run_id: assuranceRunId,
        criterion_id: evidenceCriterionId,
      },
    );

    expect(recorded).toMatchObject({ check: { status: "failed" }, criterionStatus: "failed" });
    expect(findings).toEqual([
      {
        category: "security",
        severity: "critical",
        source_rule: expect.stringContaining("EVIDENCE-INTEGRITY"),
        evidence_reference_ids: [tamperedArtifactVersionId],
      },
    ]);
  });

  it("trusted inspection finding 검증이 실패하면 Check까지 같은 transaction에서 rollback한다", async () => {
    const inspectionExecutor: TrustedAssuranceInspectionExecutor = {
      inspectorProfile: "massion.inspection.security.v1",
      async execute() {
        return {
          status: "passed",
          executionId: modelExecutionId,
          outputHash: "6".repeat(64),
          summary: "허용되지 않은 control finding",
          evidenceReferenceIds: [artifactVersionId],
          artifactVersionIds: [artifactVersionId],
          evidenceBriefIds: [],
          metricObservationIds: [],
          humanAttestationIds: [],
          findings: [
            {
              category: "security",
              severity: "major",
              message: "권한 검사가 누락됐습니다",
              evidenceReferenceIds: [artifactVersionId],
              sourceTool: "massion.inspection.security.v1",
              sourceRule: "AUTHZ-INVALID",
              controlReferences: ["UNSUPPORTED-CONTROL"],
            },
          ],
        };
      },
    };
    const checks = new AssuranceCheckStore(database, organizations, {
      trustedInspectionExecutors: [inspectionExecutor],
    });
    await expect(
      checks.record(context, {
        commandId: crypto.randomUUID(),
        workId,
        assuranceRunId,
        criterionId: modelCriterionId,
        bindingKey: "inspection:model",
        artifactVersionIds: [artifactVersionId],
      }),
    ).rejects.toThrow("criterion 밖");
    const [records] = await database.query<[{ check_id: string }[]]>(
      "SELECT check_id FROM assurance_check WHERE organization_id = $organization_id AND assurance_run_id = $assurance_run_id AND criterion_id = $criterion_id;",
      { organization_id: context.organizationId, assurance_run_id: assuranceRunId, criterion_id: modelCriterionId },
    );
    expect(records).toEqual([]);
  });

  it("runtime model executor가 없으면 execution 위조 없이 blocked Check를 기록한다", async () => {
    const checks = new AssuranceCheckStore(database, organizations);
    const recorded = await checks.record(context, {
      commandId: crypto.randomUUID(),
      workId,
      assuranceRunId,
      criterionId: modelCriterionId,
      bindingKey: "inspection:model",
      artifactVersionIds: [artifactVersionId],
    });

    expect(recorded).toMatchObject({
      check: {
        status: "blocked",
        executorHandle: "security-review",
      },
      criterionStatus: "blocked",
    });
    expect(recorded.check.executorExecutionId).toBeUndefined();
  });

  it("command replay와 동일 fingerprint dedup은 멱등이고 충돌 payload는 거부한다", async () => {
    const commandId = crypto.randomUUID();
    const first = await store.record(context, input(commandId));
    const replayed = await store.record(context, input(commandId));
    expect(replayed.findingId).toBe(first.findingId);
    const deduplicated = await store.record(context, input());
    expect(deduplicated.findingId).toBe(first.findingId);
    await expect(store.record(context, { ...input(), message: "서로 다른 내용" })).rejects.toThrow("fingerprint 충돌");
    await expect(store.record(context, { ...input(commandId), severity: "major" })).rejects.toThrow("같은 commandId");
  });

  it("검사에 결속되지 않은 evidence와 다른 tenant 접근을 거부한다", async () => {
    await expect(store.record(context, { ...input(), evidenceReferenceIds: ["missing"] })).rejects.toThrow(
      "check evidence",
    );
    await expect(store.record(otherContext, input())).rejects.toThrow();
  });

  it.each(["critical", "major"] as const)("%s finding acceptance를 금지한다", async (severity) => {
    const finding = await store.record(context, input(undefined, severity));
    await expect(
      store.resolve(context, {
        commandId: crypto.randomUUID(),
        findingId: finding.findingId,
        status: "accepted",
        reason: "위험을 감수합니다",
      }),
    ).rejects.toThrow("수용할 수 없습니다");
    await expect(
      database.query(
        "UPDATE assurance_finding SET status = 'accepted', resolution_reason = '우회', resolution_actor_id = $actor_id, resolved_at = time::now() WHERE organization_id = $organization_id AND finding_id = $finding_id;",
        {
          actor_id: context.userId,
          organization_id: context.organizationId,
          finding_id: finding.findingId,
        },
      ),
    ).rejects.toThrow("수용할 수 없습니다");
  });

  it("프로필이 허용한 minor만 사유와 현재 actor로 수용하고 resolution replay를 보장한다", async () => {
    const finding = await store.record(context, input());
    const commandId = crypto.randomUUID();
    const reason = "격리된 개발 환경에서만 사용하며 다음 배포 전에 갱신합니다";
    const accepted = await store.resolve(context, {
      commandId,
      findingId: finding.findingId,
      status: "accepted",
      reason,
    });
    expect(accepted).toMatchObject({
      status: "accepted",
      resolutionActorId: context.userId,
      resolutionReason: "격리된 개발 환경에서만 사용하며 다음 배포 전에 갱신합니다",
    });
    expect(
      (await store.resolve(context, { commandId, findingId: finding.findingId, status: "accepted", reason })).findingId,
    ).toBe(finding.findingId);
    await expect(
      store.resolve(context, {
        commandId,
        findingId: finding.findingId,
        status: "resolved",
        reason: "다른 payload",
      }),
    ).rejects.toThrow("같은 commandId");
  });

  it("caller resolution actor 주입과 빈 사유를 거부하고 critical은 resolved만 허용한다", async () => {
    const critical = await store.record(context, input(undefined, "critical"));
    await expect(
      store.resolve(context, {
        commandId: crypto.randomUUID(),
        findingId: critical.findingId,
        status: "resolved",
        reason: "",
      }),
    ).rejects.toThrow("사유");
    await expect(
      store.resolve(context, {
        commandId: crypto.randomUUID(),
        findingId: critical.findingId,
        status: "resolved",
        reason: "패치를 적용했습니다",
        resolutionActorId: "attacker",
      } as never),
    ).rejects.toThrow("actor");
    expect(
      (
        await store.resolve(context, {
          commandId: crypto.randomUUID(),
          findingId: critical.findingId,
          status: "resolved",
          reason: "패치를 적용하고 재검사했습니다",
        })
      ).status,
    ).toBe("resolved");
  });

  it("Finding identity와 terminal resolution을 direct DB로 변조할 수 없다", async () => {
    const finding = await store.record(context, input());
    const resolved = await store.resolve(context, {
      commandId: crypto.randomUUID(),
      findingId: finding.findingId,
      status: "resolved",
      reason: "패치를 적용했습니다",
    });
    await expect(
      database.query(
        "UPDATE assurance_finding SET message = '변조' WHERE organization_id = $organization_id AND finding_id = $finding_id;",
        { organization_id: context.organizationId, finding_id: resolved.findingId },
      ),
    ).rejects.toThrow("immutable");
    await expect(
      database.query(
        "DELETE assurance_finding WHERE organization_id = $organization_id AND finding_id = $finding_id;",
        { organization_id: context.organizationId, finding_id: resolved.findingId },
      ),
    ).rejects.toThrow("immutable");
  });

  it("critical accepted Finding direct CREATE를 거부한다", async () => {
    await expect(
      database.query(
        "CREATE assurance_finding CONTENT { finding_id: $finding_id, organization_id: $organization_id, work_id: $work_id, assurance_run_id: $assurance_run_id, criterion_id: $criterion_id, fingerprint: $fingerprint, category: 'security', severity: 'critical', status: 'accepted', message: 'forged', evidence_reference_ids: [$evidence_id], control_references: [], resolution_reason: '우회', resolution_actor_id: $actor_id, resolved_at: time::now(), created_at: time::now() };",
        {
          finding_id: crypto.randomUUID(),
          organization_id: context.organizationId,
          work_id: workId,
          assurance_run_id: assuranceRunId,
          criterion_id: criterionId,
          fingerprint: "f".repeat(64),
          evidence_id: artifactVersionId,
          actor_id: context.userId,
        },
      ),
    ).rejects.toThrow("open 상태");
  });
});
