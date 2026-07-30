import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, createDatabase, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { WorkAssurancePort, type AssuranceVerdictProjection, type AssuranceVerdictReader } from "./assurance.js";
import { WORK_ASSURANCE_LINK_MIGRATION } from "./schema.js";
import { WorkService, type CreateWorkResult } from "./work.js";

class FakeVerdictReader implements AssuranceVerdictReader {
  public markedRevision?: number;
  public failMark = false;

  public constructor(public projection: AssuranceVerdictProjection) {}

  public async readTerminalVerdict(): Promise<AssuranceVerdictProjection> {
    return this.projection;
  }

  public async markProjected(
    _executor: QueryExecutor,
    input: { readonly projectedWorkRevision: number },
  ): Promise<void> {
    if (this.failMark) throw new Error("원장 투영 표시 실패");
    this.markedRevision = input.projectedWorkRevision;
  }
}

describe("Work Assurance 판정 투영", () => {
  let database: MassionDatabase;
  let organizations: OrganizationService;
  let context: TenantContext;
  let created: CreateWorkResult;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const work = await WorkService.create(database, organizations);
    created = await work.createWork(context, {
      commandId: crypto.randomUUID(),
      text: "보증 투영 테스트",
      surface: "test",
      organizationVersionId: "organization-version-1",
    });

    await database.query(
      "REMOVE EVENT work_transition_state ON work; UPDATE work SET status = 'verifying' WHERE work_id = $work_id;",
      {
        work_id: created.work.work_id,
      },
    );
    await database.query("DEFINE TABLE assurance_run SCHEMALESS;");
    await applyMigrations(database, [WORK_ASSURANCE_LINK_MIGRATION]);
    await database.query("REMOVE EVENT work_verification_assurance_invariant ON work_verification;");
    await database.query("REMOVE EVENT artifact_version_runtime_provenance ON artifact_version;");
  });

  afterEach(async () => database.close());

  function projection(verdict: AssuranceVerdictProjection["verdict"] = "passed"): AssuranceVerdictProjection {
    return {
      assuranceRunId: crypto.randomUUID(),
      organizationId: context.organizationId,
      workId: created.work.work_id,
      targetWorkRevision: created.work.revision,
      snapshotHash: "a".repeat(64),
      profileId: "software-change",
      profileVersion: "1.0.0",
      bindingVersionId: "binding-1",
      verifierHandle: "assurance",
      verifierExecutionId: "execution-assurance",
      verdict,
      criteria: [
        {
          criterionKey: "task:implementation:0",
          status: verdict === "passed" ? "passed" : verdict,
        },
      ],
      evidenceHash: "b".repeat(64),
      completedAt: new Date().toISOString(),
    };
  }

  async function seedCoreOfficeRoom(
    options: {
      readonly assuranceParticipant?: boolean;
      readonly maxRounds?: number;
      readonly roundCount?: number;
      readonly deadline?: string;
    } = {},
  ): Promise<void> {
    await database.query(
      `
CREATE collaboration_room CONTENT { room_id: 'core-office-room', organization_id: $organization_id, work_id: $work_id, title: 'Core Office', coordinator_handle: 'representative', status: 'active', revision: 1, next_sequence: 2, max_parallel: 8, max_tokens: 32000, max_cost_micros: 1000000, max_rounds: $max_rounds, round_count: $round_count, created_at: time::now(), updated_at: time::now() };
CREATE collaboration_message CONTENT { message_id: 'delivery-message', organization_id: $organization_id, work_id: $work_id, room_id: 'core-office-room', sequence: 1, message_type: 'evidence', author_kind: 'agent', author_id: 'delivery-coordination', content: 'Delivery 결과', token_count: 0, cost_micros: 0, created_at: time::now() };
`,
      {
        organization_id: context.organizationId,
        work_id: created.work.work_id,
        max_rounds: options.maxRounds ?? 10,
        round_count: options.roundCount ?? 1,
      },
    );
    if (options.assuranceParticipant !== false) {
      await database.query(
        "CREATE collaboration_participant CONTENT { participant_id: 'assurance-participant', organization_id: $organization_id, work_id: $work_id, room_id: 'core-office-room', kind: 'agent', subject_id: 'assurance', role: 'participant', status: 'active', joined_at: time::now() };",
        { organization_id: context.organizationId, work_id: created.work.work_id },
      );
    }
    if (options.deadline) {
      await database.query(
        "UPDATE collaboration_room SET deadline = type::datetime($deadline) WHERE organization_id = $organization_id AND room_id = 'core-office-room';",
        { organization_id: context.organizationId, deadline: options.deadline },
      );
    }
  }

  it("passed 판정을 evidence Artifact와 WorkVerification으로 한 revision에 원자 투영한다", async () => {
    const reader = new FakeVerdictReader(projection());
    const port = new WorkAssurancePort(database, organizations, reader);

    const result = await port.projectVerdict(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      assuranceRunId: reader.projection.assuranceRunId,
    });

    expect(result.outcome).toBe("passed");
    expect(result.work).toMatchObject({ status: "verifying", revision: created.work.revision + 1 });
    expect(result.verification).toMatchObject({
      assurance_run_id: reader.projection.assuranceRunId,
      target_work_revision: created.work.revision,
      projected_work_revision: created.work.revision + 1,
      passed: true,
      evidence_artifact_version_id: result.evidenceArtifactVersion?.artifact_version_id,
    });
    expect(result.evidenceArtifactVersion?.checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.work.artifact_version_ids).toEqual([result.evidenceArtifactVersion?.artifact_version_id]);
    expect(reader.markedRevision).toBe(created.work.revision + 1);

    const [verifications] = await database.query<[unknown[]]>(
      "SELECT * FROM work_verification WHERE work_id = $work_id;",
      { work_id: created.work.work_id },
    );
    const [artifactVersions] = await database.query<[unknown[]]>(
      "SELECT * FROM artifact_version WHERE work_id = $work_id;",
      { work_id: created.work.work_id },
    );
    expect(verifications).toHaveLength(1);
    expect(artifactVersions).toHaveLength(1);
  });

  it("Assurance 메시지·evidence Artifact·Verification을 원자 투영하고 replay에서 중복하지 않는다", async () => {
    await seedCoreOfficeRoom();
    const reader = new FakeVerdictReader(projection());
    const port = new WorkAssurancePort(database, organizations, reader);
    const input = {
      commandId: "assurance-collaboration-projection",
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      assuranceRunId: reader.projection.assuranceRunId,
    };

    const first = await port.projectVerdict(context, input);
    const replayed = await port.projectVerdict(context, input);

    expect(replayed.verification?.verification_id).toBe(first.verification?.verification_id);
    expect(first.verification?.projected_work_revision).toBe(first.work.revision);
    const [messages, rooms] = await database.query<
      [
        Array<{
          message_id: string;
          sequence: number;
          author_id: string;
          reply_to_message_id?: string;
          caused_by_message_id?: string;
          execution_id?: string;
          artifact_version_id?: string;
        }>,
        Array<{ revision: number; next_sequence: number; round_count: number }>,
      ]
    >(
      "SELECT * OMIT id FROM collaboration_message WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY sequence ASC; SELECT revision, next_sequence, round_count FROM collaboration_room WHERE organization_id = $organization_id AND room_id = 'core-office-room';",
      { organization_id: context.organizationId, work_id: created.work.work_id },
    );
    expect(messages).toEqual([
      expect.objectContaining({ message_id: "delivery-message", sequence: 1 }),
      expect.objectContaining({
        sequence: 2,
        author_id: "assurance",
        reply_to_message_id: "delivery-message",
        caused_by_message_id: "delivery-message",
        execution_id: reader.projection.verifierExecutionId,
        artifact_version_id: first.evidenceArtifactVersion?.artifact_version_id,
      }),
    ]);
    expect(rooms).toEqual([{ revision: 2, next_sequence: 3, round_count: 2 }]);
  });

  it.each([
    ["participant 부재", { assuranceParticipant: false }, "participant"],
    ["round 한도", { maxRounds: 1, roundCount: 1 }, "round"],
    ["deadline 만료", { deadline: "2000-01-01T00:00:00.000Z" }, "deadline"],
  ] as const)("Assurance Collaboration %s는 전체 투영을 rollback한다", async (_label, options, reason) => {
    await seedCoreOfficeRoom(options);
    const reader = new FakeVerdictReader(projection());
    await expect(
      new WorkAssurancePort(database, organizations, reader).projectVerdict(context, {
        commandId: `assurance-collaboration-${reason}`,
        workId: created.work.work_id,
        expectedRevision: created.work.revision,
        assuranceRunId: reader.projection.assuranceRunId,
      }),
    ).rejects.toThrow(reason);

    const [artifacts, verifications, messages, rooms] = await database.query<
      [unknown[], unknown[], unknown[], Array<{ revision: number; next_sequence: number; round_count: number }>]
    >(
      "SELECT * FROM work_artifact; SELECT * FROM work_verification; SELECT * FROM collaboration_message; SELECT revision, next_sequence, round_count FROM collaboration_room WHERE room_id = 'core-office-room';",
    );
    expect(artifacts).toHaveLength(0);
    expect(verifications).toHaveLength(0);
    expect(messages).toHaveLength(1);
    expect(rooms).toEqual([{ revision: 1, next_sequence: 2, round_count: options.roundCount ?? 1 }]);
    await expect(
      (await WorkService.create(database, organizations)).getWork(context, created.work.work_id),
    ).resolves.toMatchObject({ revision: created.work.revision, status: "verifying" });
  });

  it("failed 판정은 WorkVerification을 남기고 Work를 failed로 전이한다", async () => {
    const reader = new FakeVerdictReader(projection("failed"));
    const result = await new WorkAssurancePort(database, organizations, reader).projectVerdict(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      assuranceRunId: reader.projection.assuranceRunId,
    });

    expect(result).toMatchObject({ outcome: "failed", work: { status: "failed" }, verification: { passed: false } });
  });

  it("같은 command 재실행은 같은 투영을 반환하고 payload 충돌은 거부한다", async () => {
    const reader = new FakeVerdictReader(projection());
    const port = new WorkAssurancePort(database, organizations, reader);
    const input = {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      assuranceRunId: reader.projection.assuranceRunId,
    };
    const first = await port.projectVerdict(context, input);
    const replayed = await port.projectVerdict(context, input);

    expect(replayed.verification?.verification_id).toBe(first.verification?.verification_id);
    await expect(port.projectVerdict(context, { ...input, assuranceRunId: crypto.randomUUID() })).rejects.toThrow(
      "같은 commandId",
    );
    const [verifications] = await database.query<[unknown[]]>("SELECT * FROM work_verification;");
    expect(verifications).toHaveLength(1);
  });

  it("원장 투영 표시 실패 시 Artifact와 Verification을 모두 rollback한다", async () => {
    const reader = new FakeVerdictReader(projection());
    reader.failMark = true;
    await expect(
      new WorkAssurancePort(database, organizations, reader).projectVerdict(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: created.work.revision,
        assuranceRunId: reader.projection.assuranceRunId,
      }),
    ).rejects.toThrow("원장 투영 표시 실패");

    const [artifacts] = await database.query<[unknown[]]>("SELECT * FROM work_artifact;");
    const [verifications] = await database.query<[unknown[]]>("SELECT * FROM work_verification;");
    expect(artifacts).toHaveLength(0);
    expect(verifications).toHaveLength(0);
    expect(
      (
        await WorkService.create(database, organizations).then((service) =>
          service.getWork(context, created.work.work_id),
        )
      ).revision,
    ).toBe(created.work.revision);
  });

  it("존재하지 않는 원인 WorkEvent 참조를 거부한다", async () => {
    const reader = new FakeVerdictReader(projection());
    await expect(
      new WorkAssurancePort(database, organizations, reader).projectVerdict(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: created.work.revision,
        assuranceRunId: reader.projection.assuranceRunId,
        causedByEventId: "missing-event",
      }),
    ).rejects.toThrow("원인 WorkEvent");
  });

  it("blocked 판정은 Verification을 만들지 않고 Work를 verifying에 보존한다", async () => {
    const reader = new FakeVerdictReader(projection("blocked"));
    const result = await new WorkAssurancePort(database, organizations, reader).projectVerdict(context, {
      commandId: crypto.randomUUID(),
      workId: created.work.work_id,
      expectedRevision: created.work.revision,
      assuranceRunId: reader.projection.assuranceRunId,
    });

    expect(result).toMatchObject({ outcome: "blocked", work: { status: "verifying" } });
    expect(result.verification).toBeUndefined();
    expect(result.evidenceArtifactVersion).toBeUndefined();
    expect(reader.markedRevision).toBeUndefined();
  });

  it.each([
    ["다른 tenant", (value: AssuranceVerdictProjection) => ({ ...value, organizationId: "other-org" })],
    ["다른 Work", (value: AssuranceVerdictProjection) => ({ ...value, workId: "other-work" })],
    [
      "오래된 revision",
      (value: AssuranceVerdictProjection) => ({ ...value, targetWorkRevision: value.targetWorkRevision - 1 }),
    ],
    ["다른 run", (value: AssuranceVerdictProjection) => ({ ...value, assuranceRunId: crypto.randomUUID() })],
  ])("%s 판정을 거부하고 부분 Artifact를 남기지 않는다", async (_label, change) => {
    const original = projection();
    const reader = new FakeVerdictReader(change(original));
    await expect(
      new WorkAssurancePort(database, organizations, reader).projectVerdict(context, {
        commandId: crypto.randomUUID(),
        workId: created.work.work_id,
        expectedRevision: created.work.revision,
        assuranceRunId: original.assuranceRunId,
      }),
    ).rejects.toThrow();

    const [artifacts] = await database.query<[unknown[]]>("SELECT * FROM work_artifact;");
    expect(artifacts).toHaveLength(0);
  });

  it("WorkService는 호출자 주도 recordVerification API를 공개하지 않는다", async () => {
    const service = await WorkService.create(database, organizations);
    expect("recordVerification" in service).toBe(false);
  });
});
