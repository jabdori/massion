import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, listAppliedMigrations, type MassionDatabase } from "@massion/storage";

import {
  AssuranceBindingStore,
  type AssuranceCheckBinding,
  type BindingActivationAuthorizer,
  type ProposeAssuranceBindingInput,
} from "./binding-store.js";
import { checksumCriterionCoverage } from "./criteria.js";

describe("Assurance binding 저장소", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let otherContext: TenantContext;
  let store: AssuranceBindingStore;
  let authorization: "allow" | "deny";

  const authorizer: BindingActivationAuthorizer = {
    async authorize(_context, input) {
      if (authorization === "deny") throw new Error("Governance 정책이 binding 활성화를 거부했습니다");
      const decisionId = `decision:${input.bindingVersionId}`;
      await database.query(
        "CREATE governance_policy_decision CONTENT { decision_id: $decision_id, organization_id: $organization_id, command_id: $command_id, request_hash: $request_hash, principal_type: 'Human', principal_id: $principal_id, action: 'work.execute', resource_type: 'AssuranceBindingVersion', resource_id: $resource_id, resource_revision: $resource_revision, environment: 'local', risk_class: 'assurance-binding-activation', external: false, request_summary_json: '{}', outcome: 'allow', reasons_json: '[]', errors_json: '[]', request_json: '{}', created_at: time::now() };",
        {
          decision_id: decisionId,
          organization_id: _context.organizationId,
          command_id: `${input.commandId}:fake-policy`,
          request_hash: "a".repeat(64),
          principal_id: _context.userId,
          resource_id: input.bindingVersionId,
          resource_revision: input.revision,
        },
      );
      return {
        decisionId,
      };
    },
  };

  beforeEach(async () => {
    authorization = "allow";
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "binding@example.com", displayName: "Binding" });
    const other = await identity.registerPersonalUser({ email: "binding-other@example.com", displayName: "Other" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    otherContext = await organizations.resolveTenantContext(other.user.user_id, other.organization.organization_id);
    store = await AssuranceBindingStore.create(database, organizations, authorizer, {
      allowedAuthorHandles: ["context-strategy", "software-engineering"],
    });
  });

  afterEach(async () => database.close());

  function checks(): AssuranceCheckBinding[] {
    return [
      {
        bindingKey: "check:tests",
        criterionKey: "criterion:tests",
        kind: "test",
        executor: { kind: "system_adapter", adapterId: "massion.command.v1" },
        executable: "pnpm",
        args: ["test"],
        cwd: ".",
        expectedExitCode: 0,
        timeoutMs: 60_000,
        maxOutputBytes: 1_000_000,
        requiredEvidenceKinds: ["command"],
      },
      {
        bindingKey: "check:metric",
        criterionKey: "criterion:metric",
        kind: "metric",
        executor: { kind: "system_adapter", adapterId: "massion.metric.v1" },
        sourceKind: "runtime_execution",
        operator: ">=",
        threshold: 99,
        unit: "percent",
        maxAgeMs: 60_000,
        requiredEvidenceKinds: ["metric-observation"],
      },
      {
        bindingKey: "check:human",
        criterionKey: "criterion:human",
        kind: "human",
        executor: { kind: "system_adapter", adapterId: "massion.human.v1" },
        eligibleRoles: ["owner"],
        minimumAttestations: 1,
        requiredEvidenceKinds: ["attestation"],
      },
      {
        bindingKey: "check:inspection",
        criterionKey: "criterion:inspection",
        kind: "inspection",
        executor: { kind: "runtime_agent", handle: "security-review" },
        inspectorProfile: "massion.inspection.security.v1",
        evidenceAllowlist: ["artifact-version"],
        maximumFindings: 100,
        requiredEvidenceKinds: ["finding"],
      },
      {
        bindingKey: "check:evidence",
        criterionKey: "criterion:evidence",
        kind: "evidence",
        executor: { kind: "system_adapter", adapterId: "massion.evidence.v1" },
        evidenceKinds: ["artifact-version"],
        maximumAgeMs: 60_000,
        requiredEvidenceKinds: ["artifact-version"],
      },
    ];
  }

  function proposal(commandId = crypto.randomUUID()): ProposeAssuranceBindingInput {
    return {
      commandId,
      workId: "work-1",
      planVersionId: "plan-1",
      profileId: "massion.assurance.acceptance.v1",
      profileVersion: "1.0.0",
      authorHandle: "context-strategy",
      requiredCriteria: [
        { criterionKey: "criterion:tests", method: "test" },
        { criterionKey: "criterion:metric", method: "metric" },
        { criterionKey: "criterion:human", method: "human" },
        { criterionKey: "criterion:inspection", method: "inspection" },
        { criterionKey: "criterion:evidence", method: "evidence" },
      ],
      bindings: checks(),
    };
  }

  it("binding bootstrap이 기존 checksum을 보존하며 0017→0039→0040→0041 순서를 보장한다", async () => {
    const ids = (await listAppliedMigrations(database))
      .map((migration) => migration.migration_id)
      .filter((id) =>
        [
          "0017-governance-decision",
          "0039-assurance-run",
          "0040-governance-decision-context",
          "0041-assurance-binding",
        ].includes(id),
      );
    expect(ids).toEqual([
      "0017-governance-decision",
      "0039-assurance-run",
      "0040-governance-decision-context",
      "0041-assurance-binding",
    ]);
  });

  it("typed draft를 멱등 제안하고 payload 충돌과 criterion coverage 누락을 거부한다", async () => {
    const commandId = crypto.randomUUID();
    const first = await store.propose(context, proposal(commandId));
    const replayed = await store.propose(context, proposal(commandId));

    expect(first).toMatchObject({
      status: "draft",
      version: 1,
      revision: 1,
      authorHandle: "context-strategy",
      criteriaChecksum: checksumCriterionCoverage(proposal().requiredCriteria),
    });
    expect(replayed.bindingVersionId).toBe(first.bindingVersionId);
    await expect(store.propose(context, { ...proposal(commandId), profileVersion: "1.0.1" })).rejects.toThrow(
      "다른 binding 명령",
    );
    await expect(store.propose(context, { ...proposal(), bindings: checks().slice(1) })).rejects.toThrow("coverage");
  });

  it("method별 bound와 executor 단일성을 검증한다", async () => {
    const [validCommand, validMetric, validHuman] = checks();
    if (!validCommand || !validMetric || !validHuman) throw new Error("Binding fixture가 불완전합니다");
    const invalidCommand = { ...validCommand, executable: "sh" } as AssuranceCheckBinding;
    await expect(
      store.propose(context, { ...proposal(), bindings: [invalidCommand, validMetric, validHuman] }),
    ).rejects.toThrow("허용 executable");
    const invalidMetric = { ...validMetric, threshold: Number.NaN } as AssuranceCheckBinding;
    await expect(
      store.propose(context, { ...proposal(), bindings: [validCommand, invalidMetric, validHuman] }),
    ).rejects.toThrow("유한");
    const invalidHuman = { ...validHuman, minimumAttestations: 0 } as AssuranceCheckBinding;
    await expect(
      store.propose(context, { ...proposal(), bindings: [validCommand, validMetric, invalidHuman] }),
    ).rejects.toThrow("attestation");
    const garbage = {
      ...validHuman,
      kind: "garbage",
      executor: { kind: "garbage", adapterId: "massion.invalid.v1" },
    } as unknown as AssuranceCheckBinding;
    await expect(
      store.propose(context, {
        ...proposal(),
        requiredCriteria: [{ criterionKey: "criterion:human", method: "garbage" as "human" }],
        bindings: [garbage],
      }),
    ).rejects.toThrow("지원하지 않는");
    const overboundEvidence: AssuranceCheckBinding = {
      ...validCommand,
      bindingKey: "check:tests:extra",
      requiredEvidenceKinds: Array.from({ length: 20 }, (_, index) => `extra-${String(index)}`),
    };
    await expect(store.propose(context, { ...proposal(), bindings: [...checks(), overboundEvidence] })).rejects.toThrow(
      "합집합",
    );
  });

  it("더 최신 version이 있으면 오래된 draft 활성화로 rollback할 수 없다", async () => {
    const older = await store.propose(context, proposal());
    const newer = await store.propose(context, proposal());
    await store.activate(context, {
      commandId: crypto.randomUUID(),
      bindingVersionId: newer.bindingVersionId,
      expectedRevision: newer.revision,
    });

    await expect(
      store.activate(context, {
        commandId: crypto.randomUUID(),
        bindingVersionId: older.bindingVersionId,
        expectedRevision: older.revision,
      }),
    ).rejects.toThrow("최신");
    expect(await store.getActive(context, "work-1", "plan-1")).toMatchObject({
      bindingVersionId: newer.bindingVersionId,
      version: newer.version,
    });
  });

  it("Governance 허가로 활성화하고 다음 version 활성화 시 이전 version을 supersede한다", async () => {
    const first = await store.propose(context, proposal());
    const activated = await store.activate(context, {
      commandId: crypto.randomUUID(),
      bindingVersionId: first.bindingVersionId,
      expectedRevision: first.revision,
    });
    const second = await store.propose(context, proposal());
    const next = await store.activate(context, {
      commandId: crypto.randomUUID(),
      bindingVersionId: second.bindingVersionId,
      expectedRevision: second.revision,
    });

    expect(activated).toMatchObject({ status: "active", revision: 2, governanceDecisionId: expect.any(String) });
    expect(next).toMatchObject({ status: "active", version: 2 });
    expect(next.governanceApprovalId).toBeUndefined();
    expect(await store.get(context, first.bindingVersionId)).toMatchObject({ status: "superseded", revision: 3 });
    expect(await store.getActive(context, "work-1", "plan-1")).toMatchObject({
      bindingVersionId: second.bindingVersionId,
    });
  });

  it("Governance deny, 잘못된 author, tenant 접근과 활성 binding 부재를 fail-closed로 처리한다", async () => {
    await expect(store.propose(context, { ...proposal(), authorHandle: "delivery-coordination" })).rejects.toThrow(
      "작성할 수 없는",
    );
    expect(
      await store.readiness(context, "work-1", "plan-1", {
        profileId: "massion.assurance.acceptance.v1",
        version: "1.0.0",
      }),
    ).toEqual({
      status: "binding_required",
      workId: "work-1",
      planVersionId: "plan-1",
      profileId: "massion.assurance.acceptance.v1",
      profileVersion: "1.0.0",
      action: "propose_assurance_binding",
    });
    const draft = await store.propose(context, proposal());
    authorization = "deny";
    await expect(
      store.activate(context, {
        commandId: crypto.randomUUID(),
        bindingVersionId: draft.bindingVersionId,
        expectedRevision: draft.revision,
      }),
    ).rejects.toThrow("Governance");
    await expect(store.get(otherContext, draft.bindingVersionId)).rejects.toThrow("찾을 수 없습니다");
  });

  it("DB Event가 active binding 내용과 terminal superseded record 변경을 거부한다", async () => {
    const draft = await store.propose(context, proposal());
    const active = await store.activate(context, {
      commandId: crypto.randomUUID(),
      bindingVersionId: draft.bindingVersionId,
      expectedRevision: draft.revision,
    });
    await expect(
      database.query(
        "UPDATE assurance_binding_version SET bindings_json = '[]', revision = 3 WHERE organization_id = $organization_id AND binding_version_id = $binding_version_id;",
        { organization_id: context.organizationId, binding_version_id: active.bindingVersionId },
      ),
    ).rejects.toThrow("immutable");
    await expect(
      database.query(
        "UPDATE assurance_binding_version SET status = 'superseded', revision = 3, active_guard_key = NONE, governance_decision_id = 'decision:FORGED', superseded_at = time::now() WHERE organization_id = $organization_id AND binding_version_id = $binding_version_id;",
        { organization_id: context.organizationId, binding_version_id: active.bindingVersionId },
      ),
    ).rejects.toThrow("immutable");
    const rogue = await store.propose(context, proposal());
    await expect(
      database.query(
        "UPDATE assurance_binding_version SET status = 'active', revision = 2, active_guard_key = $active_guard_key, governance_decision_id = 'decision:DOES-NOT-EXIST', activated_at = time::now() WHERE organization_id = $organization_id AND binding_version_id = $binding_version_id;",
        {
          active_guard_key: "f".repeat(64),
          organization_id: context.organizationId,
          binding_version_id: rogue.bindingVersionId,
        },
      ),
    ).rejects.toThrow("Governance decision");
  });
});
