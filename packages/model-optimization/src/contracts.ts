import type { OptimizationRoleKey, EvaluationDataPolicy, EvaluationPolicy } from "./scoring.js";

export interface OptimizationModelProfile {
  readonly modelProfileId: string;
  readonly modelId: string;
  readonly routeId: string;
  readonly providerId: string;
  readonly verified: boolean;
  readonly supportsStructuredOutput: boolean;
  readonly supportsTools: boolean;
  readonly supportsStreaming: boolean;
  readonly dataPolicy: EvaluationDataPolicy;
}

export interface EvaluationCase {
  readonly caseId: string;
  readonly roleKey: OptimizationRoleKey;
  readonly version: number;
  readonly promptChecksum: string;
  readonly toolsChecksum: string;
  readonly environmentChecksum: string;
  readonly expectedOutcome: string;
}

export interface EvaluationBundle {
  readonly bundleId: string;
  readonly roleKey: OptimizationRoleKey;
  readonly version: number;
  readonly caseIds: readonly string[];
  readonly runtimeVersion: string;
  readonly checksum: string;
  readonly status: "active" | "superseded";
}

export interface EvaluationRun {
  readonly runId: string;
  readonly organizationId: string;
  readonly roleKey: OptimizationRoleKey;
  readonly bundleId: string;
  readonly bundleVersion: number;
  readonly modelProfileId: string;
  readonly runtimeVersion: string;
  readonly mode: "standard" | "shadow";
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly inputChecksum: string;
  readonly commandId: string;
}

export interface StoredEvaluationReceipt {
  readonly receiptId: string;
  readonly runId: string;
  readonly organizationId: string;
  readonly roleKey: OptimizationRoleKey;
  readonly modelProfileId: string;
  readonly bundleVersion: number;
  readonly sampleCount: number;
  readonly qualityScore: number;
  readonly latencyMs: number;
  readonly costMicros: number;
  readonly privacyAllowed: boolean;
  readonly completed: boolean;
  readonly inputChecksum: string;
  readonly receiptChecksum: string;
}

export interface OptimizationPolicyVersion {
  readonly policyVersionId: string;
  readonly organizationId: string;
  readonly version: number;
  readonly policy: EvaluationPolicy;
  readonly autoOptimize: boolean;
  readonly productionLearning: boolean;
  readonly shadowEnabled: boolean;
  readonly minimumSampleCount: number;
  readonly improvementThreshold: number;
  readonly status: "active" | "superseded";
  readonly checksum: string;
}

export interface ModelRecommendationRecord {
  readonly recommendationId: string;
  readonly organizationId: string;
  readonly roleKey: OptimizationRoleKey;
  readonly policyVersionId: string;
  readonly primaryModelProfileId?: string;
  readonly fallbackModelProfileIds: readonly string[];
  readonly excludedJson: string;
  readonly receiptIds: readonly string[];
  readonly status: "pending-approval" | "approved" | "rejected" | "superseded";
  readonly checksum: string;
}

export type OptimizationBatchStatus = "candidate" | "shadow" | "limited" | "active" | "reverted";

export interface OptimizationBatch {
  readonly batchId: string;
  readonly organizationId: string;
  readonly roleKey: OptimizationRoleKey;
  readonly version: number;
  readonly recommendationId: string;
  readonly policyVersionId: string;
  readonly status: OptimizationBatchStatus;
  readonly primaryModelProfileId?: string;
  readonly fallbackModelProfileIds: readonly string[];
  readonly parentBatchId?: string;
  readonly checksum: string;
}

export interface OptimizationObservation {
  readonly observationId: string;
  readonly organizationId: string;
  readonly batchId: string;
  readonly sampleCount: number;
  readonly qualityScore: number;
  readonly latencyMs: number;
  readonly costMicros: number;
  readonly status: "healthy" | "degraded";
  readonly checksum: string;
}

export interface OptimizationRecoveryEvent {
  readonly recoveryId: string;
  readonly organizationId: string;
  readonly roleKey: OptimizationRoleKey;
  readonly fromBatchId: string;
  readonly toBatchId: string;
  readonly reason: string;
  readonly observationId: string;
}

export interface ConfigureOptimizationPolicyInput {
  readonly commandId: string;
  readonly policy: EvaluationPolicy;
  readonly autoOptimize: boolean;
  readonly productionLearning: boolean;
  readonly shadowEnabled: boolean;
  readonly minimumSampleCount?: number;
  readonly improvementThreshold?: number;
  readonly governanceDecisionId: string;
}

export interface StartEvaluationInput {
  readonly commandId: string;
  readonly roleKey: OptimizationRoleKey;
  readonly bundleId: string;
  readonly modelProfileId: string;
  readonly runtimeVersion: string;
  readonly mode?: "standard" | "shadow";
  readonly inputChecksum: string;
}

export interface CompleteEvaluationInput {
  readonly commandId: string;
  readonly runId: string;
  readonly sampleCount: number;
  readonly qualityScore: number;
  readonly latencyMs: number;
  readonly costMicros: number;
  readonly privacyAllowed: boolean;
  readonly completed: boolean;
}
