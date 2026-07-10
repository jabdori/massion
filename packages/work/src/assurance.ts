import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import type { MassionDatabase, QueryExecutor } from "@massion/storage";

import type {
  ArtifactVersion,
  Work,
  WorkCommandInput,
  WorkCommandResult,
  WorkEvent,
  WorkVerification,
} from "./work.js";

export type AssuranceProjectionVerdict = "passed" | "failed" | "blocked";
export type AssuranceProjectionCriterionStatus = "passed" | "failed" | "blocked" | "excluded";

export interface AssuranceProjectionCriterion {
  readonly criterionKey: string;
  readonly status: AssuranceProjectionCriterionStatus;
}

export interface AssuranceVerdictProjection {
  readonly assuranceRunId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly targetWorkRevision: number;
  readonly snapshotHash: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly bindingVersionId: string;
  readonly verifierHandle: string;
  readonly verifierExecutionId: string;
  readonly verdict: AssuranceProjectionVerdict;
  readonly criteria: readonly AssuranceProjectionCriterion[];
  readonly evidenceHash: string;
  readonly completedAt: string;
}

export interface ReadAssuranceVerdictInput {
  readonly organizationId: string;
  readonly workId: string;
  readonly assuranceRunId: string;
}

export interface MarkAssuranceProjectionInput extends ReadAssuranceVerdictInput {
  readonly projectedWorkRevision: number;
}

export interface AssuranceVerdictReader {
  readTerminalVerdict(
    executor: QueryExecutor,
    input: ReadAssuranceVerdictInput,
  ): Promise<AssuranceVerdictProjection | undefined>;
  markProjected(executor: QueryExecutor, input: MarkAssuranceProjectionInput): Promise<void>;
}

export interface ProjectAssuranceVerdictInput extends WorkCommandInput {
  readonly assuranceRunId: string;
}

export interface WorkAssuranceProjectionResult extends WorkCommandResult {
  readonly outcome: AssuranceProjectionVerdict;
  readonly verification?: WorkVerification;
  readonly evidenceArtifactVersion?: ArtifactVersion;
}

interface WorkArtifactRecord {
  readonly artifact_id: string;
}

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

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label}는 SHA-256 형식이어야 합니다`);
}

function validateProjection(
  projection: AssuranceVerdictProjection,
  input: ProjectAssuranceVerdictInput,
  organizationId: string,
): void {
  if (projection.assuranceRunId !== input.assuranceRunId) throw new Error("요청한 Assurance run과 판정이 다릅니다");
  if (projection.organizationId !== organizationId) throw new Error("다른 tenant의 Assurance 판정입니다");
  if (projection.workId !== input.workId) throw new Error("다른 Work의 Assurance 판정입니다");
  if (projection.targetWorkRevision !== input.expectedRevision)
    throw new Error("오래된 Work revision의 Assurance 판정입니다");
  if (projection.verifierHandle !== "assurance") throw new Error("최종 verifier는 assurance handle이어야 합니다");
  assertSha256(projection.snapshotHash, "Assurance snapshot hash");
  assertSha256(projection.evidenceHash, "Assurance evidence hash");
  if (!projection.profileId.trim() || !projection.profileVersion.trim() || !projection.bindingVersionId.trim()) {
    throw new Error("Assurance profile과 binding version이 필요합니다");
  }
  if (Number.isNaN(new Date(projection.completedAt).getTime()))
    throw new Error("Assurance 완료 시각이 유효하지 않습니다");
  if (projection.criteria.length === 0 || projection.criteria.length > 100) {
    throw new Error("Assurance criterion은 1개 이상 100개 이하여야 합니다");
  }
  const keys = new Set<string>();
  for (const criterion of projection.criteria) {
    if (!criterion.criterionKey.trim() || keys.has(criterion.criterionKey)) {
      throw new Error("Assurance criterion key는 비어 있거나 중복될 수 없습니다");
    }
    keys.add(criterion.criterionKey);
  }
  if (
    projection.verdict === "passed" &&
    projection.criteria.some((criterion) => !["passed", "excluded"].includes(criterion.status))
  ) {
    throw new Error("passed 판정에는 failed 또는 blocked criterion이 있을 수 없습니다");
  }
  if (projection.verdict === "failed" && !projection.criteria.some((criterion) => criterion.status === "failed")) {
    throw new Error("failed 판정에는 failed criterion이 필요합니다");
  }
  if (projection.verdict === "blocked" && !projection.criteria.some((criterion) => criterion.status === "blocked")) {
    throw new Error("blocked 판정에는 blocked criterion이 필요합니다");
  }
}

async function findWork(executor: QueryExecutor, organizationId: string, workId: string): Promise<Work | undefined> {
  const [records] = await executor.query<[Work[]]>(
    "SELECT * OMIT id FROM work WHERE organization_id = $organization_id AND work_id = $work_id LIMIT 1;",
    { organization_id: organizationId, work_id: workId },
  );
  return records[0];
}

async function findCommand(
  executor: QueryExecutor,
  organizationId: string,
  commandId: string,
): Promise<WorkEvent | undefined> {
  const [records] = await executor.query<[WorkEvent[]]>(
    "SELECT * OMIT id FROM work_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
    { organization_id: organizationId, command_id: commandId },
  );
  return records[0];
}

export class WorkAssurancePort {
  public constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly reader: AssuranceVerdictReader,
  ) {}

  public async projectVerdict(
    context: TenantContext,
    input: ProjectAssuranceVerdictInput,
  ): Promise<WorkAssuranceProjectionResult> {
    await this.organizations.verifyTenantContext(context);
    const requestJson = canonicalJson(input);
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const repeated = await findCommand(transaction, context.organizationId, input.commandId);
      if (repeated) {
        if (repeated.request_json !== requestJson) throw new Error("같은 commandId에 다른 명령을 사용할 수 없습니다");
        return JSON.parse(repeated.result_json) as WorkAssuranceProjectionResult;
      }
      const work = await findWork(transaction, context.organizationId, input.workId);
      if (!work) throw new Error(`Work를 찾을 수 없습니다: ${input.workId}`);
      if (work.status !== "verifying") throw new Error("Assurance 판정은 verifying Work에만 투영할 수 있습니다");
      if (work.revision !== input.expectedRevision) {
        throw new Error(`현재 Work revision은 ${String(work.revision)}입니다`);
      }
      const projection = await this.reader.readTerminalVerdict(transaction, {
        organizationId: context.organizationId,
        workId: input.workId,
        assuranceRunId: input.assuranceRunId,
      });
      if (!projection) throw new Error("Terminal Assurance 판정을 찾을 수 없습니다");
      validateProjection(projection, input, context.organizationId);

      const nextRevision = work.revision + 1;
      let verification: WorkVerification | undefined;
      let evidenceArtifactVersion: ArtifactVersion | undefined;
      if (projection.verdict !== "blocked") {
        const evidenceContent = canonicalJson({
          schema: "massion.verification-evidence.v1",
          assuranceRunId: projection.assuranceRunId,
          targetWorkRevision: projection.targetWorkRevision,
          snapshotHash: projection.snapshotHash,
          profileId: projection.profileId,
          profileVersion: projection.profileVersion,
          bindingVersionId: projection.bindingVersionId,
          verifierHandle: projection.verifierHandle,
          verifierExecutionId: projection.verifierExecutionId,
          verdict: projection.verdict,
          criteria: projection.criteria,
          evidenceHash: projection.evidenceHash,
          completedAt: projection.completedAt,
        });
        const artifactId = randomUUID();
        const artifactVersionId = randomUUID();
        const [artifacts] = await transaction.query<[WorkArtifactRecord[]]>(
          "CREATE work_artifact CONTENT { artifact_id: $artifact_id, organization_id: $organization_id, work_id: $work_id, kind: 'verification-evidence', name: $name, created_by: $created_by, created_at: time::now() } RETURN AFTER;",
          {
            artifact_id: artifactId,
            organization_id: context.organizationId,
            work_id: work.work_id,
            name: `assurance-${projection.assuranceRunId}.json`,
            created_by: projection.verifierHandle,
          },
        );
        if (!artifacts[0]) throw new Error("Assurance evidence Artifact 생성 결과가 없습니다");
        const [versions] = await transaction.query<[ArtifactVersion[]]>(
          "CREATE artifact_version CONTENT { artifact_version_id: $artifact_version_id, artifact_id: $artifact_id, organization_id: $organization_id, work_id: $work_id, version: 1, checksum: $checksum, media_type: 'application/vnd.massion.assurance-evidence+json', content_json: $content_json, created_by: $created_by, creator_agent_handle: $creator_agent_handle, creator_execution_id: $creator_execution_id, created_at: time::now() } RETURN AFTER;",
          {
            artifact_version_id: artifactVersionId,
            artifact_id: artifactId,
            organization_id: context.organizationId,
            work_id: work.work_id,
            checksum: sha256(evidenceContent),
            content_json: evidenceContent,
            created_by: projection.verifierHandle,
            creator_agent_handle: projection.verifierHandle,
            creator_execution_id: projection.verifierExecutionId,
          },
        );
        evidenceArtifactVersion = versions[0];
        if (!evidenceArtifactVersion) throw new Error("Assurance evidence ArtifactVersion 생성 결과가 없습니다");
        const [verifications] = await transaction.query<[WorkVerification[]]>(
          "CREATE work_verification CONTENT { verification_id: $verification_id, organization_id: $organization_id, work_id: $work_id, verifier_id: $verifier_id, passed: $passed, criteria_json: $criteria_json, evidence_artifact_version_ids: [$evidence_artifact_version_id], assurance_run_id: $assurance_run_id, target_work_revision: $target_work_revision, projected_work_revision: $projected_work_revision, snapshot_hash: $snapshot_hash, profile_id: $profile_id, profile_version: $profile_version, binding_version_id: $binding_version_id, evidence_artifact_version_id: $evidence_artifact_version_id, created_at: time::now() } RETURN AFTER;",
          {
            verification_id: randomUUID(),
            organization_id: context.organizationId,
            work_id: work.work_id,
            verifier_id: projection.verifierHandle,
            passed: projection.verdict === "passed",
            criteria_json: canonicalJson(projection.criteria),
            evidence_artifact_version_id: artifactVersionId,
            assurance_run_id: projection.assuranceRunId,
            target_work_revision: projection.targetWorkRevision,
            projected_work_revision: nextRevision,
            snapshot_hash: projection.snapshotHash,
            profile_id: projection.profileId,
            profile_version: projection.profileVersion,
            binding_version_id: projection.bindingVersionId,
          },
        );
        verification = verifications[0];
        if (!verification) throw new Error("WorkVerification 생성 결과가 없습니다");
        await this.reader.markProjected(transaction, {
          organizationId: context.organizationId,
          workId: work.work_id,
          assuranceRunId: projection.assuranceRunId,
          projectedWorkRevision: nextRevision,
        });
      }

      const artifactVersionIds = evidenceArtifactVersion
        ? [...work.artifact_version_ids, evidenceArtifactVersion.artifact_version_id]
        : work.artifact_version_ids;
      await transaction.query(
        "UPDATE work SET status = $status, revision = $revision, artifact_version_ids = $artifact_version_ids, updated_at = time::now() WHERE organization_id = $organization_id AND work_id = $work_id;",
        {
          status: projection.verdict === "failed" ? "failed" : "verifying",
          revision: nextRevision,
          artifact_version_ids: artifactVersionIds,
          organization_id: context.organizationId,
          work_id: work.work_id,
        },
      );
      const updated = await findWork(transaction, context.organizationId, work.work_id);
      if (!updated) throw new Error("변경된 Work를 찾을 수 없습니다");
      const eventPayload = {
        outcome: projection.verdict,
        assuranceRunId: projection.assuranceRunId,
        ...(verification ? { verification } : {}),
        ...(evidenceArtifactVersion ? { evidenceArtifactVersion } : {}),
      };
      const [existingEvents] = await transaction.query<[WorkEvent[]]>(
        "SELECT * OMIT id FROM work_event WHERE organization_id = $organization_id AND work_id = $work_id ORDER BY sequence ASC;",
        { organization_id: context.organizationId, work_id: work.work_id },
      );
      if (input.causedByEventId && !existingEvents.some((event) => event.event_id === input.causedByEventId)) {
        throw new Error(`원인 WorkEvent를 찾을 수 없습니다: ${input.causedByEventId}`);
      }
      const eventId = randomUUID();
      const provisional = { work: updated, event: undefined, ...eventPayload };
      const [events] = await transaction.query<[WorkEvent[]]>(
        "CREATE work_event CONTENT { event_id: $event_id, organization_id: $organization_id, work_id: $work_id, sequence: $sequence, command_id: $command_id, event_type: $event_type, actor_user_id: $actor_user_id, caused_by_event_id: $caused_by_event_id, request_json: $request_json, payload_json: $payload_json, result_json: '{}', created_at: time::now() } RETURN AFTER;",
        {
          event_id: eventId,
          organization_id: context.organizationId,
          work_id: work.work_id,
          sequence: existingEvents.reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1,
          command_id: input.commandId,
          event_type: projection.verdict === "blocked" ? "assurance_verdict_blocked" : "verification_recorded",
          actor_user_id: context.userId,
          caused_by_event_id: input.causedByEventId,
          request_json: requestJson,
          payload_json: canonicalJson(eventPayload),
        },
      );
      const event = events[0];
      if (!event) throw new Error("WorkEvent 생성 결과가 없습니다");
      const result: WorkAssuranceProjectionResult = { ...provisional, event };
      await transaction.query("UPDATE work_event SET result_json = $result_json WHERE event_id = $event_id;", {
        result_json: JSON.stringify(result),
        event_id: eventId,
      });
      return result;
    });
  }
}
