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
  HumanAttestationStore,
  MetricObservationStore,
  backfillAssuranceBindingChecks,
  metricObservationChecksum,
  type MetricObservationReader,
  type AssuranceCheckBinding,
} from "./index.js";

const statement = "승인된 변경을 운영 환경에 배포해도 됩니다";
const secondStatement = "고객 공지를 발송해도 됩니다";
const snapshotHash = "b".repeat(64);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("Assurance HumanAttestation", () => {
  let database: MassionDatabase;
  let organizations: OrganizationService;
  let ownerContext: TenantContext;
  let adminContext: TenantContext;
  let otherContext: TenantContext;
  let workId: string;
  let assuranceRunId: string;
  let criterionId: string;
  let secondCriterionId: string;
  let metricCriterionId: string;
  let forgedMetricCriterionId: string;
  let artifactVersionId: string;
  let artifactChecksum: string;
  let store: HumanAttestationStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "human-owner@example.com", displayName: "Owner" });
    const admin = await identity.registerPersonalUser({ email: "human-admin@example.com", displayName: "Admin" });
    const other = await identity.registerPersonalUser({ email: "human-other@example.com", displayName: "Other" });
    ownerContext = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const adminMembership = await organizations.addMember(ownerContext, admin.user.user_id, "admin");
    adminContext = {
      userId: admin.user.user_id,
      organizationId: ownerContext.organizationId,
      membershipId: adminMembership.membership_id,
      role: "admin",
    };
    otherContext = await organizations.resolveTenantContext(other.user.user_id, other.organization.organization_id);

    const graph = await OrganizationGraphService.create(database, organizations);
    await graph.bootstrap(ownerContext);
    await AssuranceBootstrap.create(database, organizations);
    const works = await WorkService.create(database, organizations, graph);
    const created = await works.createWork(ownerContext, {
      commandId: crypto.randomUUID(),
      text: "human attestation",
      surface: "test",
      organizationVersionId: "organization-version-1",
    });
    workId = created.work.work_id;
    const artifact = await works.createArtifactVersion(ownerContext, {
      commandId: crypto.randomUUID(),
      workId,
      expectedRevision: created.work.revision,
      kind: "metric-source",
      name: "coverage.json",
      mediaType: "application/json",
      content: { coverage: 98.5 },
    });
    artifactVersionId = artifact.artifactVersion.artifact_version_id;
    artifactChecksum = artifact.artifactVersion.checksum;
    for (const status of ["planned", "ready", "running", "verifying"] as const) {
      await database.query(
        "UPDATE work SET status = $status, revision += 1, updated_at = time::now() WHERE organization_id = $organization_id AND work_id = $work_id;",
        { status, organization_id: ownerContext.organizationId, work_id: workId },
      );
    }
    const [worksAtRevision] = await database.query<[{ revision: number }[]]>(
      "SELECT revision FROM work WHERE organization_id = $organization_id AND work_id = $work_id LIMIT 1;",
      { organization_id: ownerContext.organizationId, work_id: workId },
    );
    const targetRevision = worksAtRevision[0]?.revision;
    if (!targetRevision) throw new Error("테스트 Work revision이 없습니다");

    const runtime = await RuntimeExecutionStore.create(database, organizations);
    const execution = await runtime.createExecution(ownerContext, {
      commandId: crypto.randomUUID(),
      workId,
      agentHandle: "assurance",
      modelRoute: "test:assurance",
      correlationId: crypto.randomUUID(),
      estimatedTokens: 1,
      estimatedCostMicros: 0,
      input: { operation: "human-attestation" },
    });

    const bindingVersionId = crypto.randomUUID();
    const bindings: AssuranceCheckBinding[] = [
      {
        kind: "human",
        bindingKey: "human:release",
        criterionKey: "human:release",
        executor: { kind: "system_adapter", adapterId: "massion.human.v1" },
        requiredEvidenceKinds: ["attestation"],
        eligibleRoles: ["owner", "admin"],
        minimumAttestations: 2,
      },
      {
        kind: "human",
        bindingKey: "human:notice",
        criterionKey: "human:notice",
        executor: { kind: "system_adapter", adapterId: "massion.human.v1" },
        requiredEvidenceKinds: ["attestation"],
        eligibleRoles: ["owner", "admin"],
        minimumAttestations: 1,
      },
      {
        kind: "metric",
        bindingKey: "metric:coverage",
        criterionKey: "metric:coverage",
        executor: { kind: "system_adapter", adapterId: "massion.metric.coverage.v1" },
        requiredEvidenceKinds: ["metric-observation"],
        sourceKind: "artifact_version",
        operator: ">=",
        threshold: 95,
        unit: "percent",
        maxAgeMs: 60_000,
      },
      {
        kind: "metric",
        bindingKey: "metric:forged",
        criterionKey: "metric:forged",
        executor: { kind: "system_adapter", adapterId: "massion.metric.coverage.v1" },
        requiredEvidenceKinds: ["metric-observation"],
        sourceKind: "artifact_version",
        operator: ">=",
        threshold: 95,
        unit: "percent",
        maxAgeMs: 60_000,
      },
    ];
    await database.query(
      "CREATE assurance_binding_version CONTENT { binding_version_id: $binding_version_id, organization_id: $organization_id, work_id: $work_id, plan_version_id: 'plan-1', version: 1, revision: 1, status: 'draft', profile_id: 'profile-1', profile_version: '1.0.0', bindings_json: $bindings_json, criteria_checksum: $criteria_checksum, checksum: $checksum, author_handle: 'context-strategy', created_by_user_id: $user_id, created_at: time::now() };",
      {
        binding_version_id: bindingVersionId,
        organization_id: ownerContext.organizationId,
        work_id: workId,
        bindings_json: JSON.stringify(bindings),
        criteria_checksum: "c".repeat(64),
        checksum: "d".repeat(64),
        user_id: ownerContext.userId,
      },
    );
    const decisionId = crypto.randomUUID();
    await database.query(
      "CREATE governance_policy_decision CONTENT { decision_id: $decision_id, organization_id: $organization_id, command_id: $command_id, request_hash: $request_hash, principal_type: 'Human', principal_id: $principal_id, action: 'work.execute', resource_type: 'AssuranceBindingVersion', resource_id: $resource_id, resource_revision: 1, environment: 'local', risk_class: 'assurance-binding-activation', external: false, request_summary_json: '{}', outcome: 'allow', reasons_json: '[]', errors_json: '[]', request_json: '{}', created_at: time::now() };",
      {
        decision_id: decisionId,
        organization_id: ownerContext.organizationId,
        command_id: crypto.randomUUID(),
        request_hash: "e".repeat(64),
        principal_id: ownerContext.userId,
        resource_id: bindingVersionId,
      },
    );
    await database.query(
      "UPDATE assurance_binding_version SET status = 'active', revision = 2, active_guard_key = $active_guard_key, governance_decision_id = $decision_id, activated_at = time::now() WHERE organization_id = $organization_id AND binding_version_id = $binding_version_id;",
      {
        active_guard_key: crypto.randomUUID(),
        decision_id: decisionId,
        organization_id: ownerContext.organizationId,
        binding_version_id: bindingVersionId,
      },
    );
    await backfillAssuranceBindingChecks(database);

    assuranceRunId = crypto.randomUUID();
    await database.query(
      "CREATE assurance_run CONTENT { assurance_run_id: $assurance_run_id, organization_id: $organization_id, work_id: $work_id, target_work_revision: $target_work_revision, plan_version_id: 'plan-1', binding_version_id: $binding_version_id, profile_id: 'profile-1', profile_version: '1.0.0', verifier_handle: 'assurance', verifier_execution_id: $execution_id, snapshot_hash: $snapshot_hash, status: 'planned', version: 1, attempt: 1, start_command_id: $command_id, active_guard_key: $active_guard_key, created_by_user_id: $user_id, expires_at: time::now() + 1h, started_at: time::now(), updated_at: time::now() };",
      {
        assurance_run_id: assuranceRunId,
        organization_id: ownerContext.organizationId,
        work_id: workId,
        target_work_revision: targetRevision,
        binding_version_id: bindingVersionId,
        execution_id: execution.execution.execution_id,
        snapshot_hash: snapshotHash,
        command_id: crypto.randomUUID(),
        active_guard_key: crypto.randomUUID(),
        user_id: ownerContext.userId,
      },
    );
    criterionId = crypto.randomUUID();
    secondCriterionId = crypto.randomUUID();
    metricCriterionId = crypto.randomUUID();
    forgedMetricCriterionId = crypto.randomUUID();
    for (const criterion of [
      { id: criterionId, key: "human:release", text: statement, method: "human" },
      { id: secondCriterionId, key: "human:notice", text: secondStatement, method: "human" },
      { id: metricCriterionId, key: "metric:coverage", text: "테스트 커버리지가 95% 이상입니다", method: "metric" },
      { id: forgedMetricCriterionId, key: "metric:forged", text: "위조 메트릭은 통과하지 않습니다", method: "metric" },
    ]) {
      await database.query(
        "CREATE assurance_criterion CONTENT { criterion_id: $criterion_id, organization_id: $organization_id, work_id: $work_id, assurance_run_id: $assurance_run_id, criterion_key: $criterion_key, source: 'profile', statement: $statement, method: $method, required_evidence_kinds: $required_evidence_kinds, control_references: [], status: 'pending', created_at: time::now(), updated_at: time::now() };",
        {
          criterion_id: criterion.id,
          organization_id: ownerContext.organizationId,
          work_id: workId,
          assurance_run_id: assuranceRunId,
          criterion_key: criterion.key,
          statement: criterion.text,
          method: criterion.method,
          required_evidence_kinds: criterion.method === "human" ? ["attestation"] : ["metric-observation"],
        },
      );
    }
    store = new HumanAttestationStore(database, organizations);
  });

  afterEach(async () => database.close());

  function input(commandId = crypto.randomUUID()) {
    return {
      commandId,
      workId,
      assuranceRunId,
      criterionId,
      statementHash: sha256(statement),
      snapshotHash,
      accepted: true,
    };
  }

  it("attestor를 TenantContext에서 파생하고 distinct 최소 인원을 계산한다", async () => {
    const owner = await store.record(ownerContext, input());
    expect(owner.attestation.attestorUserId).toBe(ownerContext.userId);
    expect(owner.progress).toEqual({ acceptedCount: 1, minimumAttestations: 2, rejected: false, satisfied: false });

    const admin = await store.record(adminContext, input());
    expect(admin.progress).toEqual({ acceptedCount: 2, minimumAttestations: 2, rejected: false, satisfied: true });
  });

  it("명시적 reject를 기록하고 criterion을 충족시키지 않는다", async () => {
    const result = await store.record(ownerContext, {
      ...input(),
      criterionId: secondCriterionId,
      statementHash: sha256(secondStatement),
      accepted: false,
    });

    expect(result.attestation.accepted).toBe(false);
    expect(result.progress).toEqual({ acceptedCount: 0, minimumAttestations: 1, rejected: true, satisfied: false });
  });

  it("command replay는 멱등이고 payload 충돌과 같은 사용자 중복 서명을 거부한다", async () => {
    const commandId = crypto.randomUUID();
    const first = await store.record(ownerContext, input(commandId));
    const replayed = await store.record(ownerContext, input(commandId));
    expect(replayed.attestation.attestationId).toBe(first.attestation.attestationId);
    await expect(store.record(ownerContext, { ...input(commandId), accepted: false })).rejects.toThrow(
      "같은 commandId",
    );
    await expect(store.record(ownerContext, input())).rejects.toThrow("한 번만");
  });

  it("현재 Membership role과 tenant 경계를 다시 확인한다", async () => {
    const member = await IdentityService.create(database).then((identity) =>
      identity.registerPersonalUser({ email: "human-member@example.com", displayName: "Member" }),
    );
    const membership = await organizations.addMember(ownerContext, member.user.user_id, "member");
    const memberContext: TenantContext = {
      userId: member.user.user_id,
      organizationId: ownerContext.organizationId,
      membershipId: membership.membership_id,
      role: "member",
    };
    await expect(store.record(memberContext, input())).rejects.toThrow("eligible role");
    await expect(store.record(otherContext, input())).rejects.toThrow();
    await organizations.suspendMembership(ownerContext, membership.membership_id, membership.revision);
    await expect(store.record(memberContext, input())).rejects.toThrow("TenantContext");
  });

  it("현재 문장·run snapshot과 다른 hash 및 caller attestor 주입을 거부한다", async () => {
    await expect(store.record(ownerContext, { ...input(), statementHash: "a".repeat(64) })).rejects.toThrow(
      "statement hash",
    );
    await expect(store.record(ownerContext, { ...input(), snapshotHash: "a".repeat(64) })).rejects.toThrow(
      "snapshot hash",
    );
    await expect(
      store.record(ownerContext, { ...input(), attestorUserId: adminContext.userId } as never),
    ).rejects.toThrow("attestor");
  });

  it("기록된 HumanAttestation을 direct DB로 변경하거나 삭제할 수 없다", async () => {
    const recorded = await store.record(ownerContext, input());
    await expect(
      database.query(
        "UPDATE assurance_human_attestation SET accepted = false WHERE organization_id = $organization_id AND attestation_id = $attestation_id;",
        { organization_id: ownerContext.organizationId, attestation_id: recorded.attestation.attestationId },
      ),
    ).rejects.toThrow("immutable");
    await expect(
      database.query(
        "DELETE assurance_human_attestation WHERE organization_id = $organization_id AND attestation_id = $attestation_id;",
        { organization_id: ownerContext.organizationId, attestation_id: recorded.attestation.attestationId },
      ),
    ).rejects.toThrow("immutable");
  });

  it("CheckStore가 DB의 attestation·Membership·binding을 다시 읽어 criterion을 판정한다", async () => {
    const owner = await store.record(ownerContext, input());
    const admin = await store.record(adminContext, input());
    const checks = new AssuranceCheckStore(database, organizations);
    const commandId = crypto.randomUUID();
    const evaluated = await checks.record(ownerContext, {
      commandId,
      workId,
      assuranceRunId,
      criterionId,
      bindingKey: "human:release",
      humanAttestationIds: [owner.attestation.attestationId, admin.attestation.attestationId],
    });

    expect(evaluated.check).toMatchObject({
      kind: "human",
      status: "passed",
      humanAttestationIds: [admin.attestation.attestationId, owner.attestation.attestationId].sort(),
    });
    expect(evaluated.criterionStatus).toBe("passed");
    expect(
      (
        await checks.record(ownerContext, {
          commandId,
          workId,
          assuranceRunId,
          criterionId,
          bindingKey: "human:release",
          humanAttestationIds: [owner.attestation.attestationId, admin.attestation.attestationId],
        })
      ).check.checkId,
    ).toBe(evaluated.check.checkId);
    await expect(
      checks.record(ownerContext, {
        commandId: crypto.randomUUID(),
        workId,
        assuranceRunId,
        criterionId,
        bindingKey: "human:release",
        humanAttestationIds: ["forged-attestation"],
        passed: true,
      } as never),
    ).rejects.toThrow("caller verdict");
    await expect(
      database.query(
        "UPDATE assurance_check SET output_hash = $output_hash WHERE organization_id = $organization_id AND check_id = $check_id;",
        {
          output_hash: "f".repeat(64),
          organization_id: ownerContext.organizationId,
          check_id: evaluated.check.checkId,
        },
      ),
    ).rejects.toThrow("immutable");
    await expect(
      database.query(
        "UPDATE assurance_criterion SET status = 'failed' WHERE organization_id = $organization_id AND criterion_id = $criterion_id;",
        { organization_id: ownerContext.organizationId, criterion_id: criterionId },
      ),
    ).rejects.toThrow("한 번만");
    await expect(
      database.query(
        "UPDATE assurance_event SET actor_user_id = 'forged' WHERE organization_id = $organization_id AND command_id = $command_id;",
        { organization_id: ownerContext.organizationId, command_id: commandId },
      ),
    ).rejects.toThrow("immutable");
  });

  it("CheckStore는 DB에 저장된 MetricObservation ID만 판정하고 forged ID는 blocked로 둔다", async () => {
    const adapter: MetricObservationReader = {
      async observe(_executor, readInput) {
        const value = 98.5;
        const unit = "percent";
        const measuredAt = new Date().toISOString();
        return {
          value,
          unit,
          measuredAt,
          sourceChecksum: artifactChecksum,
          checksum: metricObservationChecksum({
            ...readInput,
            value,
            unit,
            measuredAt,
            sourceChecksum: artifactChecksum,
          }),
        };
      },
    };
    const metrics = new MetricObservationStore(database, organizations, {
      systemAdapters: { "massion.metric.coverage.v1": adapter },
      clock: () => new Date(),
    });
    const observation = await metrics.record(ownerContext, {
      commandId: crypto.randomUUID(),
      workId,
      producer: { kind: "system_adapter", id: "massion.metric.coverage.v1" },
      source: { kind: "artifact_version", id: artifactVersionId },
      expectedUnit: "percent",
      maximumAgeMs: 60_000,
    });
    const checks = new AssuranceCheckStore(database, organizations, {
      clock: () => new Date(),
    });
    const actual = await checks.record(ownerContext, {
      commandId: crypto.randomUUID(),
      workId,
      assuranceRunId,
      criterionId: metricCriterionId,
      bindingKey: "metric:coverage",
      metricObservationIds: [observation.observationId],
    });
    const forged = await checks.record(ownerContext, {
      commandId: crypto.randomUUID(),
      workId,
      assuranceRunId,
      criterionId: forgedMetricCriterionId,
      bindingKey: "metric:forged",
      metricObservationIds: ["forged-observation"],
    });

    expect(actual).toMatchObject({ check: { status: "passed" }, criterionStatus: "passed" });
    expect(forged).toMatchObject({ check: { status: "blocked" }, criterionStatus: "blocked" });
  });

  it("caller가 reject ID를 빼도 criterion의 전체 attestation을 읽어 failed로 판정한다", async () => {
    const accepted = await store.record(ownerContext, {
      ...input(),
      criterionId: secondCriterionId,
      statementHash: sha256(secondStatement),
    });
    const rejected = await store.record(adminContext, {
      ...input(),
      criterionId: secondCriterionId,
      statementHash: sha256(secondStatement),
      accepted: false,
    });
    const checks = new AssuranceCheckStore(database, organizations);
    const evaluated = await checks.record(ownerContext, {
      commandId: crypto.randomUUID(),
      workId,
      assuranceRunId,
      criterionId: secondCriterionId,
      bindingKey: "human:notice",
      humanAttestationIds: [accepted.attestation.attestationId],
    });

    expect(evaluated).toMatchObject({ check: { status: "failed" }, criterionStatus: "failed" });
    expect(evaluated.check.humanAttestationIds).toContain(rejected.attestation.attestationId);
  });

  it("forged HumanAttestation·binding 밖 Check·존재하지 않는 run Event direct CREATE를 거부한다", async () => {
    await expect(
      database.query(
        "CREATE assurance_human_attestation CONTENT { attestation_id: $attestation_id, organization_id: $organization_id, work_id: 'missing-work', assurance_run_id: 'missing-run', criterion_id: 'missing-criterion', attestor_user_id: $user_id, statement_hash: $statement_hash, snapshot_hash: $snapshot_hash, accepted: true, command_id: $command_id, request_hash: $request_hash, created_at: time::now() };",
        {
          attestation_id: crypto.randomUUID(),
          organization_id: ownerContext.organizationId,
          user_id: ownerContext.userId,
          statement_hash: "a".repeat(64),
          snapshot_hash: "b".repeat(64),
          command_id: crypto.randomUUID(),
          request_hash: "c".repeat(64),
        },
      ),
    ).rejects.toThrow("유효하지 않습니다");
    await expect(
      database.query(
        "CREATE assurance_check CONTENT { check_id: $check_id, organization_id: $organization_id, work_id: $work_id, assurance_run_id: $assurance_run_id, criterion_id: $criterion_id, kind: 'metric', system_adapter_id: 'massion.metric.coverage.v1', command_key: 'not-in-any-binding', input_hash: $input_hash, status: 'passed', output_hash: $output_hash, artifact_version_ids: [], evidence_brief_ids: [], metric_observation_ids: [], human_attestation_ids: [], duration_ms: 0, created_at: time::now(), started_at: time::now(), completed_at: time::now() };",
        {
          check_id: crypto.randomUUID(),
          organization_id: ownerContext.organizationId,
          work_id: workId,
          assurance_run_id: assuranceRunId,
          criterion_id: metricCriterionId,
          input_hash: "d".repeat(64),
          output_hash: "e".repeat(64),
        },
      ),
    ).rejects.toThrow("binding");
    await expect(
      database.query(
        "CREATE assurance_event CONTENT { event_id: $event_id, organization_id: $organization_id, assurance_run_id: 'missing-run', command_id: $command_id, sequence: 777, event_type: 'assurance_run_passed', request_hash: $request_hash, payload_json: '{}', actor_user_id: $actor_id, created_at: time::now() };",
        {
          event_id: crypto.randomUUID(),
          organization_id: ownerContext.organizationId,
          command_id: crypto.randomUUID(),
          request_hash: "f".repeat(64),
          actor_id: ownerContext.userId,
        },
      ),
    ).rejects.toThrow("유효하지 않습니다");
  });
});
