import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { RuntimeExecutionStore } from "@massion/runtime";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";

import { AssuranceBootstrap, AssuranceFindingStore, assuranceBindingIdentityChecksum } from "./index.js";

describe("AssuranceFinding", () => {
  let database: MassionDatabase;
  let organizations: OrganizationService;
  let context: TenantContext;
  let otherContext: TenantContext;
  let workId: string;
  let assuranceRunId: string;
  let criterionId: string;
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
    const inspectionBinding = {
      kind: "inspection" as const,
      bindingKey: "inspection:security",
      criterionKey: "security:scan",
      executor: { kind: "system_adapter" as const, adapterId: "massion.sarif.v1" },
      requiredEvidenceKinds: ["sarif"],
      inspectorProfile: "security",
      evidenceAllowlist: [artifactVersionId],
      maximumFindings: 100,
    };
    const identityChecksum = assuranceBindingIdentityChecksum(inspectionBinding);
    await database.query(
      "CREATE assurance_binding_version CONTENT { binding_version_id: 'binding-1', organization_id: $organization_id, work_id: $work_id, plan_version_id: 'plan-1', version: 1, revision: 1, status: 'draft', profile_id: 'massion.assurance.software-change.v1', profile_version: '1.0.0', bindings_json: $bindings_json, criteria_checksum: $criteria_checksum, checksum: $checksum, author_handle: 'context-strategy', created_by_user_id: $user_id, created_at: time::now() }; CREATE assurance_binding_check_manifest CONTENT { binding_version_id: 'binding-1', organization_id: $organization_id, work_id: $work_id, identity_checksum: $identity_checksum, created_at: time::now() }; CREATE assurance_binding_check CONTENT { binding_version_id: 'binding-1', organization_id: $organization_id, work_id: $work_id, binding_key: 'inspection:security', criterion_key: 'security:scan', kind: 'inspection', executor_kind: 'system_adapter', executor_id: 'massion.sarif.v1', eligible_roles: [], identity_checksum: $identity_checksum, created_at: time::now() };",
      {
        organization_id: context.organizationId,
        work_id: workId,
        bindings_json: JSON.stringify([inspectionBinding]),
        criteria_checksum: "a".repeat(64),
        checksum: "b".repeat(64),
        identity_checksum: identityChecksum,
        user_id: context.userId,
      },
    );
    await database.query(
      "CREATE assurance_check CONTENT { check_id: $check_id, organization_id: $organization_id, work_id: $work_id, assurance_run_id: $assurance_run_id, criterion_id: $criterion_id, kind: 'inspection', system_adapter_id: 'massion.sarif.v1', command_key: 'inspection:security', input_hash: $input_hash, status: 'passed', output_hash: $output_hash, artifact_version_ids: [$artifact_version_id], evidence_brief_ids: [], metric_observation_ids: [], human_attestation_ids: [], duration_ms: 0, created_at: time::now(), started_at: time::now(), completed_at: time::now() };",
      {
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
