export type IsoDateTime = string;
export type RecordsRunStatus = "planned" | "rendering" | "finalized" | "completed" | "blocked" | "cancelled";
export type DocumentationKind = "work-record" | "adr" | "changelog" | "runbook";
export type RecordsDocumentKind = Exclude<DocumentationKind, "work-record">;
export type DocumentationImpactOutcome = "required" | "not-applicable";

export interface RecordsFailure {
  readonly category: string;
  readonly causeHash: string;
}

export interface RecordsRun {
  readonly recordsRunId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly targetWorkRevision: number;
  readonly verificationId: string;
  readonly assuranceRunId: string;
  readonly snapshotHash: string;
  readonly rendererVersion: string;
  readonly status: RecordsRunStatus;
  readonly version: number;
  readonly attempt: number;
  readonly commandId: string;
  readonly requestHash: string;
  readonly failure?: RecordsFailure;
  readonly createdByUserId: string;
  readonly startedAt: IsoDateTime;
  readonly completedAt?: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface DocumentationImpactAssessment {
  readonly assessmentId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly recordsRunId: string;
  readonly kind: DocumentationKind;
  readonly outcome: DocumentationImpactOutcome;
  readonly ruleId: string;
  readonly reason: string;
  readonly sourceReferenceIds: readonly string[];
  readonly evaluatorVersion: string;
  readonly createdAt: IsoDateTime;
}

export interface RecordsDocument {
  readonly documentId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly recordsRunId: string;
  readonly kind: RecordsDocumentKind;
  readonly schemaVersion: string;
  readonly rendererVersion: string;
  readonly sourceJson: string;
  readonly sourceChecksum: string;
  readonly markdownChecksum: string;
  readonly artifactVersionId: string;
  readonly createdAt: IsoDateTime;
}

const IDENTIFIER_MAX_LENGTH = 200;
const REASON_MAX_LENGTH = 2_000;
const REFERENCE_MAX_COUNT = 100;
const DOCUMENT_MAX_BYTES = 1_048_576;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const RUN_STATUSES = new Set<RecordsRunStatus>([
  "planned",
  "rendering",
  "finalized",
  "completed",
  "blocked",
  "cancelled",
]);
const DOCUMENT_KINDS = new Set<RecordsDocumentKind>(["adr", "changelog", "runbook"]);
const IMPACT_KINDS = new Set<DocumentationKind>(["work-record", "adr", "changelog", "runbook"]);
const IMPACT_OUTCOMES = new Set<DocumentationImpactOutcome>(["required", "not-applicable"]);

function assertIdentifier(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > IDENTIFIER_MAX_LENGTH) {
    throw new Error(`${name} identifier는 1~200자여야 합니다`);
  }
}

function assertSha256(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${name}은 lowercase SHA-256이어야 합니다`);
  }
}

function assertIsoDateTime(value: unknown, name: string): asserts value is IsoDateTime {
  if (typeof value !== "string" || !ISO_DATE_TIME_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${name}은 UTC ISO datetime이어야 합니다`);
  }
}

function assertReferenceIds(values: readonly string[], required: boolean): void {
  if (!Array.isArray(values) || values.length > REFERENCE_MAX_COUNT) {
    throw new Error("source reference는 100개 이하여야 합니다");
  }
  if (required && values.length === 0) throw new Error("required 문서에는 source reference가 필요합니다");
  if (new Set(values).size !== values.length) throw new Error("source reference는 중복될 수 없습니다");
  for (const value of values) assertIdentifier(value, "source reference");
}

export function validateRecordsRun(run: RecordsRun): void {
  assertIdentifier(run.recordsRunId, "Records run");
  assertIdentifier(run.organizationId, "Organization");
  assertIdentifier(run.workId, "Work");
  assertIdentifier(run.verificationId, "Verification");
  assertIdentifier(run.assuranceRunId, "Assurance run");
  assertIdentifier(run.rendererVersion, "Renderer version");
  assertIdentifier(run.commandId, "Command");
  assertIdentifier(run.createdByUserId, "Creator");
  if (!Number.isSafeInteger(run.targetWorkRevision) || run.targetWorkRevision < 1) {
    throw new Error("target Work revision은 1 이상인 안전한 정수여야 합니다");
  }
  if (!Number.isSafeInteger(run.version) || run.version < 1)
    throw new Error("Records run version은 1 이상이어야 합니다");
  if (!Number.isSafeInteger(run.attempt) || run.attempt < 1)
    throw new Error("Records run attempt는 1 이상이어야 합니다");
  assertSha256(run.snapshotHash, "Snapshot hash");
  assertSha256(run.requestHash, "Request hash");
  if (!RUN_STATUSES.has(run.status)) throw new Error("지원하지 않는 Records run status입니다");
  assertIsoDateTime(run.startedAt, "startedAt");
  assertIsoDateTime(run.updatedAt, "updatedAt");

  const terminal = run.status === "completed" || run.status === "blocked" || run.status === "cancelled";
  if (terminal !== (run.completedAt !== undefined)) {
    throw new Error("Records run terminal 상태와 completedAt이 일치해야 합니다");
  }
  if (run.completedAt !== undefined) assertIsoDateTime(run.completedAt, "completedAt");
  if ((run.status === "blocked") !== (run.failure !== undefined)) {
    throw new Error("blocked Records run에만 failure가 필요합니다");
  }
  if (run.failure) {
    assertIdentifier(run.failure.category, "Failure category");
    assertSha256(run.failure.causeHash, "Failure cause hash");
  }
}

export function validateDocumentationImpactAssessment(assessment: DocumentationImpactAssessment): void {
  assertIdentifier(assessment.assessmentId, "Assessment");
  assertIdentifier(assessment.organizationId, "Organization");
  assertIdentifier(assessment.workId, "Work");
  assertIdentifier(assessment.recordsRunId, "Records run");
  assertIdentifier(assessment.ruleId, "Rule");
  assertIdentifier(assessment.evaluatorVersion, "Evaluator version");
  if (!IMPACT_KINDS.has(assessment.kind)) throw new Error("지원하지 않는 documentation kind입니다");
  if (!IMPACT_OUTCOMES.has(assessment.outcome)) throw new Error("지원하지 않는 impact outcome입니다");
  if (assessment.kind === "work-record" && assessment.outcome !== "required") {
    throw new Error("WorkRecord impact outcome은 항상 required여야 합니다");
  }
  if (
    typeof assessment.reason !== "string" ||
    assessment.reason.length === 0 ||
    assessment.reason.length > REASON_MAX_LENGTH
  ) {
    throw new Error("impact reason은 1~2000자여야 합니다");
  }
  assertReferenceIds(assessment.sourceReferenceIds, assessment.outcome === "required");
  assertIsoDateTime(assessment.createdAt, "createdAt");
}

export function validateRecordsDocument(document: RecordsDocument): void {
  assertIdentifier(document.documentId, "Document");
  assertIdentifier(document.organizationId, "Organization");
  assertIdentifier(document.workId, "Work");
  assertIdentifier(document.recordsRunId, "Records run");
  assertIdentifier(document.schemaVersion, "Schema version");
  assertIdentifier(document.rendererVersion, "Renderer version");
  assertIdentifier(document.artifactVersionId, "Artifact version");
  if (!DOCUMENT_KINDS.has(document.kind)) throw new Error("지원하지 않는 records document kind입니다");
  if (
    typeof document.sourceJson !== "string" ||
    new TextEncoder().encode(document.sourceJson).byteLength > DOCUMENT_MAX_BYTES
  ) {
    throw new Error("Document source는 UTF-8 1 MiB 이하여야 합니다");
  }
  assertSha256(document.sourceChecksum, "Source checksum");
  assertSha256(document.markdownChecksum, "Markdown checksum");
  assertIsoDateTime(document.createdAt, "createdAt");
}

const CALLER_PROJECTION_FIELDS = new Set([
  "artifactVersionId",
  "completedAt",
  "documentId",
  "markdownChecksum",
  "outcome",
  "sourceChecksum",
  "status",
]);

export function assertNoCallerRecordsProjection(input: Readonly<Record<string, unknown>>): void {
  for (const field of Object.keys(input)) {
    if (CALLER_PROJECTION_FIELDS.has(field)) {
      throw new Error(`caller는 ${field} projection을 주입할 수 없습니다`);
    }
  }
}
