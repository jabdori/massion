import { createHash } from "node:crypto";

import type {
  DocumentationImpactProposalInput,
  DocumentationSourceReference,
  RecordsDocumentSource,
  RecordsService,
} from "@massion/records";
import { createRecordsSnapshot, RECORDS_MARKDOWN_RENDERER_VERSION } from "@massion/records";
import type { TenantContext } from "@massion/identity";
import type { WorkRecoveryBundle, WorkService } from "@massion/work";

import type { CoreWorkStageExecutor, CoreWorkStageInput, CoreWorkStageResult } from "./core-work-coordinator.js";

export interface CoreRecordsDocumentPlanner {
  plan(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly workId: string;
      readonly requiredKinds: readonly ("adr" | "changelog" | "runbook")[];
      readonly sourceReferences: readonly DocumentationSourceReference[];
      readonly recovery: WorkRecoveryBundle;
    },
  ): Promise<readonly RecordsDocumentSource[]>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isoDateTime(value: unknown, label: string): string {
  if (typeof value === "string" || value instanceof Date) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (value && typeof value === "object" && "toISOString" in value) {
    const convert = (value as { readonly toISOString?: unknown }).toISOString;
    if (typeof convert === "function") {
      const serialized = String(convert.call(value));
      const date = new Date(serialized);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  throw new Error(`${label} datetime을 UTC ISO 형식으로 직렬화할 수 없습니다`);
}

function proposals(request: unknown): readonly DocumentationImpactProposalInput[] {
  const value =
    request && typeof request === "object"
      ? (request as { documentationProposals?: unknown }).documentationProposals
      : undefined;
  return Array.isArray(value) ? (value as DocumentationImpactProposalInput[]) : [];
}

interface ActiveRecordsRun {
  readonly recordsRunId: string;
  cancellation?: Promise<void>;
}

const APPLICATION_RUN_CANCELLED = "Application run cancelled";

export class CoreRecordsStage implements CoreWorkStageExecutor {
  private readonly activeRecordsRuns = new Map<string, ActiveRecordsRun>();

  public constructor(
    private readonly dependencies: {
      readonly works: Pick<WorkService, "recoverWork">;
      readonly records: Pick<RecordsService, "start" | "cancel" | "proposeImpacts" | "finalize" | "complete">;
      readonly documents: CoreRecordsDocumentPlanner;
    },
  ) {}

  public async cancel(context: TenantContext, input: Omit<CoreWorkStageInput, "resumeInput">): Promise<void> {
    const stageCommandId = input.commandId.replace(/:cancel$/u, "");
    const active = this.activeRecordsRuns.get(stageCommandId);
    if (!active) return;
    await this.cancelRecordsRun(context, stageCommandId, active.recordsRunId);
  }

  public async execute(context: TenantContext, input: CoreWorkStageInput): Promise<CoreWorkStageResult> {
    this.throwIfCancelled(input);
    if (!input.workId) throw new Error("Records stage에 Work ID가 없습니다");
    const workId = input.workId;
    const recovery = await this.dependencies.works.recoverWork(context, workId);
    this.throwIfCancelled(input);
    const verification = [...recovery.verifications]
      .filter((item) => item.passed)
      .sort((left, right) => left.projected_work_revision - right.projected_work_revision)
      .at(-1);
    if (!verification) return { outcome: "blocked", reason: "passed-verification-required" };
    const plan = recovery.plans.find((candidate) => candidate.plan_version_id === recovery.work.active_plan_version_id);
    if (!plan) return { outcome: "blocked", reason: "strategy-plan-missing" };
    const artifacts = new Map(recovery.artifacts.map((artifact) => [artifact.artifact_id, artifact]));
    const snapshot = createRecordsSnapshot({
      organizationId: context.organizationId,
      rendererVersion: RECORDS_MARKDOWN_RENDERER_VERSION,
      work: {
        organizationId: context.organizationId,
        workId,
        status: recovery.work.status,
        revision: recovery.work.revision,
        organizationVersionId: recovery.work.organization_version_id,
        activePlanVersionId: plan.plan_version_id,
        ...(recovery.work.context_version_id ? { contextVersionId: recovery.work.context_version_id } : {}),
        ...(recovery.work.policy_version_id ? { policyVersionId: recovery.work.policy_version_id } : {}),
        ...(recovery.work.prompt_version_id ? { promptVersionId: recovery.work.prompt_version_id } : {}),
        artifactVersionIds: recovery.work.artifact_version_ids,
      },
      plan: {
        organizationId: context.organizationId,
        workId,
        planVersionId: plan.plan_version_id,
        checksum: sha256(plan.content_json),
      },
      events: recovery.events.map((event) => ({
        organizationId: context.organizationId,
        workId,
        eventId: event.event_id,
        sequence: event.sequence,
        eventType: event.event_type,
        requestHash: sha256(event.request_json),
        resultHash: sha256(event.result_json),
        ...(event.caused_by_event_id ? { causedByEventId: event.caused_by_event_id } : {}),
      })),
      decisionMessages: recovery.messages
        .filter((message) => message.message_type === "decision")
        .map((message) => ({
          organizationId: context.organizationId,
          workId,
          messageId: message.message_id,
          sequence: message.sequence,
          contentHash: sha256(message.content),
          ...(message.reply_to_message_id ? { replyToMessageId: message.reply_to_message_id } : {}),
          ...(message.caused_by_message_id ? { causedByMessageId: message.caused_by_message_id } : {}),
        })),
      artifactVersions: recovery.artifactVersions.map((version) => {
        const artifact = artifacts.get(version.artifact_id);
        if (!artifact) throw new Error("ArtifactVersion의 Artifact를 찾을 수 없습니다");
        return {
          organizationId: context.organizationId,
          workId,
          artifactId: artifact.artifact_id,
          artifactVersionId: version.artifact_version_id,
          kind: artifact.kind,
          name: artifact.name,
          checksum: version.checksum,
        };
      }),
      verification: {
        organizationId: context.organizationId,
        workId,
        verificationId: verification.verification_id,
        passed: verification.passed,
        targetWorkRevision: verification.target_work_revision,
        projectedWorkRevision: verification.projected_work_revision,
        assuranceRunId: verification.assurance_run_id,
        assuranceSnapshotHash: verification.snapshot_hash,
        profileId: verification.profile_id,
        profileVersion: verification.profile_version,
        bindingVersionId: verification.binding_version_id,
        evidenceArtifactVersionId: verification.evidence_artifact_version_id,
      },
      governanceReferences: [],
    });
    this.throwIfCancelled(input);
    const run = await this.dependencies.records.start(context, {
      commandId: `${input.commandId}:start`,
      workId,
      targetWorkRevision: recovery.work.revision,
      verificationId: verification.verification_id,
      assuranceRunId: verification.assurance_run_id,
      snapshotHash: snapshot.hash,
      rendererVersion: RECORDS_MARKDOWN_RENDERER_VERSION,
    });
    if (run.status === "completed") {
      this.throwIfCancelled(input);
      return { outcome: "advanced", data: { recordsRunId: run.recordsRunId } };
    }
    const active: ActiveRecordsRun = { recordsRunId: run.recordsRunId };
    this.activeRecordsRuns.set(input.commandId, active);
    try {
      await this.cancelAndThrowIfCancelled(context, input, run.recordsRunId);
      const sourceReferences: DocumentationSourceReference[] = [
        {
          referenceId: verification.verification_id,
          organizationId: context.organizationId,
          workId,
          sourceType: "verification",
        },
        ...recovery.events.map((event) => ({
          referenceId: event.event_id,
          organizationId: context.organizationId,
          workId,
          sourceType: "event" as const,
        })),
        ...recovery.messages.map((message) => ({
          referenceId: message.message_id,
          organizationId: context.organizationId,
          workId,
          sourceType: "message" as const,
        })),
        ...recovery.artifactVersions.map((artifact) => ({
          referenceId: artifact.artifact_version_id,
          organizationId: context.organizationId,
          workId,
          sourceType: "artifact" as const,
        })),
      ];
      await this.cancelAndThrowIfCancelled(context, input, run.recordsRunId);
      const impacts = await this.dependencies.records.proposeImpacts(context, {
        commandId: `${input.commandId}:impacts`,
        recordsRunId: run.recordsRunId,
        evaluatedAt: isoDateTime(recovery.events.at(-1)?.created_at ?? recovery.work.updated_at, "Records 평가 시각"),
        proposals: proposals(input.request),
        sources: sourceReferences,
      });
      await this.cancelAndThrowIfCancelled(context, input, run.recordsRunId);
      const requiredKinds = impacts.assessments
        .filter((assessment) => assessment.outcome === "required" && assessment.kind !== "work-record")
        .map((assessment) => assessment.kind as "adr" | "changelog" | "runbook");
      await this.cancelAndThrowIfCancelled(context, input, run.recordsRunId);
      const documents = await this.dependencies.documents.plan(context, {
        commandId: `${input.commandId}:documents`,
        workId,
        requiredKinds,
        sourceReferences,
        recovery,
      });
      await this.cancelAndThrowIfCancelled(context, input, run.recordsRunId);
      if (requiredKinds.some((kind) => !documents.some((document) => document.kind === kind)))
        return { outcome: "blocked", reason: "records-document-required" };
      await this.cancelAndThrowIfCancelled(context, input, run.recordsRunId);
      await this.dependencies.records.finalize(context, {
        commandId: `${input.commandId}:finalize`,
        recordsRunId: run.recordsRunId,
        expectedWorkRevision: run.targetWorkRevision,
        documentSources: documents,
      });
      await this.cancelAndThrowIfCancelled(context, input, run.recordsRunId);
      const completed = await this.dependencies.records.complete(context, { recordsRunId: run.recordsRunId });
      await this.cancelAndThrowIfCancelled(context, input, run.recordsRunId);
      return completed.run.status === "completed"
        ? { outcome: "advanced", data: { recordsRunId: completed.run.recordsRunId, snapshotHash: snapshot.hash } }
        : { outcome: "blocked", reason: `records-${completed.run.status}` };
    } finally {
      if (this.activeRecordsRuns.get(input.commandId) === active) this.activeRecordsRuns.delete(input.commandId);
    }
  }

  private throwIfCancelled(input: CoreWorkStageInput): void {
    if (input.signal?.aborted) throw new Error(APPLICATION_RUN_CANCELLED);
  }

  private async cancelAndThrowIfCancelled(
    context: TenantContext,
    input: CoreWorkStageInput,
    recordsRunId: string,
  ): Promise<void> {
    const active = this.activeRecordsRuns.get(input.commandId);
    if (!input.signal?.aborted && active?.cancellation === undefined) return;
    await this.cancelRecordsRun(context, input.commandId, recordsRunId);
    throw new Error(APPLICATION_RUN_CANCELLED);
  }

  private async cancelRecordsRun(context: TenantContext, stageCommandId: string, recordsRunId: string): Promise<void> {
    const active = this.activeRecordsRuns.get(stageCommandId);
    if (active?.recordsRunId === recordsRunId) {
      if (!active.cancellation) {
        const cancellation = this.dependencies.records
          .cancel(context, { commandId: `${stageCommandId}:cancel`, recordsRunId })
          .then(() => undefined);
        active.cancellation = cancellation;
        try {
          await cancellation;
        } catch (error) {
          if (active.cancellation === cancellation) delete active.cancellation;
          throw error;
        }
      } else {
        await active.cancellation;
      }
      return;
    }
    await this.dependencies.records.cancel(context, { commandId: `${stageCommandId}:cancel`, recordsRunId });
  }
}
