import { createHash } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import {
  WorkRecordsPort,
  type FinalizeRecordsProjectionInput,
  type FinalizeRecordsProjectionResult,
} from "@massion/work";
import type { MassionDatabase } from "@massion/storage";

import type { RecordsRun } from "./contracts.js";
import {
  evaluateDocumentationImpacts,
  type DocumentationImpactEvaluationInput,
  type DocumentationImpactProposalInput,
  type DocumentationSourceReference,
} from "./impact.js";
import { renderDocument, type RecordsDocumentSource } from "./renderer.js";
import { RecordsRunStore, type RecordDocumentationImpactsResult, type StartRecordsRunInput } from "./run-store.js";

export interface ProposeDocumentationImpactsInput {
  readonly commandId: string;
  readonly recordsRunId: string;
  readonly evaluatedAt: string;
  readonly proposals: readonly DocumentationImpactProposalInput[];
  readonly sources: readonly DocumentationSourceReference[];
}

export interface FinalizeRecordsInput {
  readonly commandId: string;
  readonly recordsRunId: string;
  readonly expectedWorkRevision: number;
  readonly documentSources: readonly RecordsDocumentSource[];
  readonly causedByEventId?: string;
}

interface RecordsRunGateway {
  start(context: TenantContext, input: StartRecordsRunInput): Promise<RecordsRun>;
  get(context: TenantContext, recordsRunId: string): Promise<RecordsRun>;
  recordImpacts(
    context: TenantContext,
    commandId: string,
    recordsRunId: string,
    evaluation: ReturnType<typeof evaluateDocumentationImpacts>,
    proposals?: readonly DocumentationImpactProposalInput[],
  ): Promise<RecordDocumentationImpactsResult>;
}

interface WorkRecordsProjectionGateway {
  finalize(context: TenantContext, input: FinalizeRecordsProjectionInput): Promise<FinalizeRecordsProjectionResult>;
}

function documentId(recordsRunId: string, kind: RecordsDocumentSource["kind"]): string {
  return createHash("sha256").update(`${recordsRunId}:${kind}`).digest("hex");
}

export class RecordsService {
  public constructor(
    private readonly runs: RecordsRunGateway,
    private readonly work: WorkRecordsProjectionGateway,
  ) {}

  public static async create(database: MassionDatabase, organizations: OrganizationService): Promise<RecordsService> {
    const runs = await RecordsRunStore.create(database, organizations);
    const work = await WorkRecordsPort.create(database, organizations);
    return new RecordsService(runs, work);
  }

  public async start(context: TenantContext, input: StartRecordsRunInput): Promise<RecordsRun> {
    return await this.runs.start(context, input);
  }

  public async proposeImpacts(
    context: TenantContext,
    input: ProposeDocumentationImpactsInput,
  ): Promise<RecordDocumentationImpactsResult> {
    const run = await this.runs.get(context, input.recordsRunId);
    if (run.status !== "planned") throw new Error("Documentation impact는 planned Records run에서만 제안합니다");
    const evaluationInput: DocumentationImpactEvaluationInput = {
      organizationId: run.organizationId,
      workId: run.workId,
      recordsRunId: run.recordsRunId,
      verificationReferenceId: run.verificationId,
      evaluatedAt: input.evaluatedAt,
      proposals: input.proposals,
      sources: input.sources,
    };
    const evaluation = evaluateDocumentationImpacts(evaluationInput);
    return await this.runs.recordImpacts(context, input.commandId, input.recordsRunId, evaluation, input.proposals);
  }

  public async finalize(context: TenantContext, input: FinalizeRecordsInput): Promise<FinalizeRecordsProjectionResult> {
    const run = await this.runs.get(context, input.recordsRunId);
    if (run.status !== "rendering") throw new Error("Records finalize는 rendering run에서만 실행합니다");
    if (run.targetWorkRevision !== input.expectedWorkRevision) {
      throw new Error("Records finalize expected Work revision이 run target과 다릅니다");
    }
    const documents = input.documentSources.map((source) => {
      const rendered = renderDocument(source);
      if (rendered.rendererVersion !== run.rendererVersion) {
        throw new Error("Rendered document version이 Records run renderer version과 다릅니다");
      }
      return {
        documentId: documentId(run.recordsRunId, source.kind),
        kind: source.kind,
        schemaVersion: rendered.schemaVersion,
        rendererVersion: rendered.rendererVersion,
        sourceJson: rendered.sourceJson,
        sourceChecksum: rendered.sourceChecksum,
        markdown: rendered.markdown,
        markdownChecksum: rendered.markdownChecksum,
      };
    });
    return await this.work.finalize(context, {
      commandId: input.commandId,
      workId: run.workId,
      expectedRevision: input.expectedWorkRevision,
      recordsRunId: run.recordsRunId,
      recordsSnapshotHash: run.snapshotHash,
      verificationId: run.verificationId,
      documents,
      ...(input.causedByEventId ? { causedByEventId: input.causedByEventId } : {}),
    });
  }
}
