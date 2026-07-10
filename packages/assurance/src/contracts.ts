export type AssuranceRunStatus = "planned" | "running" | "passed" | "failed" | "blocked" | "cancelled";
export type AssuranceVerdict = "passed" | "failed" | "blocked";
export type IsoDateTime = string;

export interface AssuranceFailure {
  readonly category: string;
  readonly causeHash: string;
}

export interface AssuranceRun {
  readonly assuranceRunId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly targetWorkRevision: number;
  readonly planVersionId: string;
  readonly bindingVersionId: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly verifierHandle: string;
  readonly verifierExecutionId: string;
  readonly snapshotHash: string;
  readonly status: AssuranceRunStatus;
  readonly version: number;
  readonly attempt: number;
  readonly startCommandId: string;
  readonly verdict?: AssuranceVerdict;
  readonly projectedWorkRevision?: number;
  readonly failure?: AssuranceFailure;
  readonly createdByUserId: string;
  readonly expiresAt: IsoDateTime;
  readonly startedAt: IsoDateTime;
  readonly completedAt?: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface StartAssuranceRunInput {
  readonly commandId: string;
  readonly workId: string;
  readonly targetWorkRevision: number;
  readonly planVersionId: string;
  readonly bindingVersionId: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly verifierHandle: string;
  readonly verifierExecutionId: string;
  readonly snapshotHash: string;
  readonly criterionExclusions?: Readonly<
    Record<string, { readonly rule: string; readonly reason: string; readonly actorId: string }>
  >;
  readonly leaseTtlMs: number;
}

export interface AssuranceRunResult {
  readonly run: AssuranceRun;
}

export interface AssuranceEvent {
  readonly eventId: string;
  readonly organizationId: string;
  readonly assuranceRunId: string;
  readonly commandId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly requestHash: string;
  readonly payloadJson: string;
  readonly actorUserId: string;
  readonly createdAt: IsoDateTime;
}

export type AssuranceCriterionStatus = "pending" | "passed" | "failed" | "blocked" | "excluded";
export type AssuranceCheckStatus = "pending" | "running" | "passed" | "failed" | "blocked" | "cancelled";
export type AssuranceCriterionMethod = "test" | "inspection" | "evidence" | "metric" | "human";
export type AssuranceFindingSeverity = "critical" | "major" | "minor" | "info";
export type AssuranceFindingStatus = "open" | "resolved" | "accepted";

export interface AssuranceCriterion {
  readonly criterionId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly assuranceRunId: string;
  readonly criterionKey: string;
  readonly source: "plan" | "task" | "profile";
  readonly statement: string;
  readonly method: AssuranceCriterionMethod;
  readonly requiredEvidenceKinds: readonly string[];
  readonly controlReferences: readonly string[];
  readonly status: AssuranceCriterionStatus;
  readonly exclusionRule?: string;
  readonly exclusionReason?: string;
  readonly exclusionActorId?: string;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface AssuranceCheck {
  readonly checkId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly assuranceRunId: string;
  readonly criterionId: string;
  readonly kind: "command" | "inspection" | "evidence" | "metric" | "human";
  readonly executorHandle?: string;
  readonly executorExecutionId?: string;
  readonly systemAdapterId?: string;
  readonly commandKey: string;
  readonly inputHash: string;
  readonly status: AssuranceCheckStatus;
  readonly toolName?: string;
  readonly toolVersion?: string;
  readonly outputHash?: string;
  readonly outputSummary?: string;
  readonly artifactVersionIds: readonly string[];
  readonly evidenceBriefIds: readonly string[];
  readonly metricObservationIds: readonly string[];
  readonly humanAttestationIds: readonly string[];
  readonly durationMs?: number;
  readonly createdAt: IsoDateTime;
  readonly startedAt?: IsoDateTime;
  readonly completedAt?: IsoDateTime;
}

export interface AssuranceFinding {
  readonly findingId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly assuranceRunId: string;
  readonly criterionId?: string;
  readonly fingerprint: string;
  readonly category: "correctness" | "security" | "reliability" | "operability" | "supply-chain";
  readonly severity: AssuranceFindingSeverity;
  readonly status: AssuranceFindingStatus;
  readonly message: string;
  readonly locationJson?: string;
  readonly evidenceReferenceIds: readonly string[];
  readonly sourceTool?: string;
  readonly sourceRule?: string;
  readonly controlReferences: readonly string[];
  readonly resolutionReason?: string;
  readonly resolutionActorId?: string;
  readonly resolvedAt?: IsoDateTime;
  readonly createdAt: IsoDateTime;
}

export interface HumanAttestation {
  readonly attestationId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly assuranceRunId: string;
  readonly criterionId: string;
  readonly attestorUserId: string;
  readonly statementHash: string;
  readonly snapshotHash: string;
  readonly accepted: boolean;
  readonly commandId: string;
  readonly requestHash: string;
  readonly createdAt: IsoDateTime;
}

export interface MetricObservation {
  readonly observationId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly producerKind: "runtime_execution" | "system_adapter";
  readonly producerId: string;
  readonly sourceKind: "artifact_version" | "runtime_execution";
  readonly sourceId: string;
  readonly value: number;
  readonly unit: string;
  readonly checksum: string;
  readonly measuredAt: IsoDateTime;
  readonly createdAt: IsoDateTime;
}
