import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { RecordsRunStore, type StartRecordsRunInput } from "./run-store.js";
import { evaluateDocumentationImpacts } from "./impact.js";

describe("Records run 저장소", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let otherContext: TenantContext;
  let store: RecordsRunStore;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "records@example.com", displayName: "Records" });
    const other = await identity.registerPersonalUser({ email: "other-records@example.com", displayName: "Other" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    otherContext = await organizations.resolveTenantContext(other.user.user_id, other.organization.organization_id);
    store = await RecordsRunStore.create(database, organizations);
    await database.query(
      `
DEFINE TABLE work SCHEMAFULL;
DEFINE FIELD organization_id ON work TYPE string;
DEFINE FIELD work_id ON work TYPE string;
DEFINE FIELD status ON work TYPE string;
DEFINE FIELD revision ON work TYPE int;
DEFINE TABLE work_verification SCHEMAFULL;
DEFINE FIELD organization_id ON work_verification TYPE string;
DEFINE FIELD work_id ON work_verification TYPE string;
DEFINE FIELD verification_id ON work_verification TYPE string;
DEFINE FIELD assurance_run_id ON work_verification TYPE string;
DEFINE FIELD passed ON work_verification TYPE bool;
DEFINE FIELD projected_work_revision ON work_verification TYPE int;
DEFINE FIELD created_at ON work_verification TYPE datetime;
DEFINE TABLE assurance_run SCHEMAFULL;
DEFINE FIELD organization_id ON assurance_run TYPE string;
DEFINE FIELD work_id ON assurance_run TYPE string;
DEFINE FIELD assurance_run_id ON assurance_run TYPE string;
DEFINE FIELD status ON assurance_run TYPE string;
DEFINE FIELD projected_work_revision ON assurance_run TYPE option<int>;
CREATE work CONTENT { organization_id: $organization_id, work_id: 'work-1', status: 'verifying', revision: 9 };
CREATE assurance_run CONTENT { organization_id: $organization_id, work_id: 'work-1', assurance_run_id: 'assurance-run-1', status: 'passed', projected_work_revision: 9 };
CREATE work_verification CONTENT { organization_id: $organization_id, work_id: 'work-1', verification_id: 'verification-1', assurance_run_id: 'assurance-run-1', passed: true, projected_work_revision: 9, created_at: time::now() };
`,
      { organization_id: context.organizationId },
    );
  });

  afterEach(async () => database.close());

  function input(commandId: string = crypto.randomUUID()): StartRecordsRunInput {
    return {
      commandId,
      workId: "work-1",
      targetWorkRevision: 9,
      verificationId: "verification-1",
      assuranceRunId: "assurance-run-1",
      snapshotHash: "a".repeat(64),
      rendererVersion: "massion.records.markdown.v1",
    };
  }

  it("같은 command의 동시 start를 run 하나로 멱등 재생한다", async () => {
    const commandId = crypto.randomUUID();
    const [left, right] = await Promise.all([
      store.start(context, input(commandId)),
      store.start(context, input(commandId)),
    ]);

    expect(right).toEqual(left);
    expect(left).toMatchObject({
      organizationId: context.organizationId,
      workId: "work-1",
      targetWorkRevision: 9,
      verificationId: "verification-1",
      assuranceRunId: "assurance-run-1",
      status: "planned",
      version: 1,
      attempt: 1,
    });
    const [runs] = await database.query<[{ count: number }[]]>("SELECT count() FROM records_run GROUP ALL;");
    expect(runs).toEqual([{ count: 1 }]);
  });

  it("같은 command의 payload 변경과 같은 target의 다른 active run을 거부한다", async () => {
    const commandId = crypto.randomUUID();
    await store.start(context, input(commandId));
    await expect(store.start(context, { ...input(commandId), snapshotHash: "b".repeat(64) })).rejects.toThrow(
      "다른 payload",
    );
    await expect(store.start(context, input())).rejects.toThrow();
  });

  it("verifying N+1·최신 passed Verification·Assurance projection을 강제한다", async () => {
    await database.query("UPDATE work SET status = 'running' WHERE work_id = 'work-1';");
    await expect(store.start(context, input())).rejects.toThrow("verifying");
    await database.query("UPDATE work SET status = 'verifying' WHERE work_id = 'work-1';");

    await expect(store.start(context, { ...input(), targetWorkRevision: 8 })).rejects.toThrow("revision");
    await expect(store.start(context, { ...input(), verificationId: "unknown" })).rejects.toThrow("Verification");
  });

  it("다른 tenant에서는 run을 조회할 수 없다", async () => {
    const run = await store.start(context, input());
    await expect(store.get(otherContext, run.recordsRunId)).rejects.toThrow("찾을 수 없습니다");
  });

  it("네 impact assessment와 proposal을 원자 저장하고 rendering으로 전이한다", async () => {
    const started = await store.start(context, input());
    const proposals = [
      {
        kind: "decision" as const,
        ruleHint: "architecture-decision",
        reason: "구조 결정을 승인했습니다",
        sourceReferenceIds: ["message-1"],
      },
    ];
    const evaluation = evaluateDocumentationImpacts({
      organizationId: context.organizationId,
      workId: "work-1",
      recordsRunId: started.recordsRunId,
      verificationReferenceId: "verification-1",
      evaluatedAt: "2026-07-11T00:00:00.000Z",
      proposals,
      sources: [
        {
          referenceId: "verification-1",
          organizationId: context.organizationId,
          workId: "work-1",
          sourceType: "verification",
        },
        {
          referenceId: "message-1",
          organizationId: context.organizationId,
          workId: "work-1",
          sourceType: "message",
        },
      ],
    });
    const commandId = crypto.randomUUID();
    const first = await store.recordImpacts(context, commandId, started.recordsRunId, evaluation, proposals);
    const repeated = await store.recordImpacts(context, commandId, started.recordsRunId, evaluation, proposals);

    expect(first.run).toMatchObject({ status: "rendering", version: 2 });
    expect(first.assessments).toHaveLength(4);
    expect(repeated).toEqual(first);
    const [counts] = await database.query<[{ count: number }[]]>(
      "SELECT count() FROM documentation_impact_proposal GROUP ALL;",
    );
    expect(counts).toEqual([{ count: 1 }]);
    await expect(store.recordImpacts(context, commandId, started.recordsRunId, evaluation, [])).rejects.toThrow(
      "다른 impact payload",
    );
  });
});
