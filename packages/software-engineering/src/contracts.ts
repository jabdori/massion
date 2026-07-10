import type { TenantContext } from "@massion/identity";

export type EngineeringDeliveryStatus =
  | "preparing"
  | "test_applied"
  | "red_verified"
  | "implementation_applied"
  | "green_verified"
  | "committed"
  | "failed"
  | "cancelled";

export interface EngineeringDeliveryError {
  readonly category: string;
  readonly causeId: string;
}

export interface EngineeringDelivery {
  readonly deliveryId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly taskId: string;
  readonly assignmentId: string;
  readonly repositoryId: string;
  readonly repositoryRevisionId: string;
  readonly baseRevision: string;
  readonly repositoryRootRealPathHash: string;
  readonly agentHandle: string;
  readonly profileVersion: string;
  readonly status: EngineeringDeliveryStatus;
  readonly version: number;
  readonly startCommandId: string;
  readonly workspaceId?: string;
  readonly branchRef?: string;
  readonly commitSha?: string;
  readonly testPatchHash?: string;
  readonly implementationPatchHash?: string;
  readonly changeSetHash?: string;
  readonly redEvidenceId?: string;
  readonly greenEvidenceId?: string;
  readonly validationEvidenceIds: readonly string[];
  readonly artifactVersionId?: string;
  readonly error?: EngineeringDeliveryError;
  readonly createdByUserId: string;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
}

export interface StartEngineeringDeliveryInput {
  readonly commandId: string;
  readonly workId: string;
  readonly taskId: string;
  readonly assignmentId: string;
  readonly repositoryId: string;
  readonly repositoryRevisionId: string;
  readonly baseRevision: string;
  readonly agentHandle: string;
  readonly profileVersion: string;
}

export interface TransitionEngineeringDeliveryInput {
  readonly commandId: string;
  readonly deliveryId: string;
  readonly expectedVersion: number;
  readonly target: EngineeringDeliveryStatus;
  readonly workspaceId?: string;
  readonly branchRef?: string;
  readonly commitSha?: string;
  readonly testPatchHash?: string;
  readonly implementationPatchHash?: string;
  readonly changeSetHash?: string;
  readonly redEvidenceId?: string;
  readonly greenEvidenceId?: string;
  readonly validationEvidenceIds?: readonly string[];
  readonly artifactVersionId?: string;
  readonly error?: EngineeringDeliveryError;
}

export interface DeliveryPrerequisiteReader {
  getWork(
    context: TenantContext,
    workId: string,
  ): Promise<{ readonly organizationId: string; readonly workId: string; readonly status: string }>;
  getTask(
    context: TenantContext,
    workId: string,
    taskId: string,
  ): Promise<{
    readonly organizationId: string;
    readonly workId: string;
    readonly taskId: string;
    readonly status: string;
  }>;
  getAssignment(
    context: TenantContext,
    workId: string,
    assignmentId: string,
  ): Promise<{
    readonly organizationId: string;
    readonly workId: string;
    readonly taskId: string;
    readonly assignmentId: string;
    readonly agentHandle: string;
    readonly status: string;
  }>;
  getRepository(
    context: TenantContext,
    repositoryId: string,
  ): Promise<{
    readonly organizationId: string;
    readonly repositoryId: string;
    readonly status: string;
    readonly rootRealPathHash: string;
  }>;
  getRepositoryRevision(
    context: TenantContext,
    repositoryRevisionId: string,
  ): Promise<{
    readonly organizationId: string;
    readonly repositoryId: string;
    readonly repositoryRevisionId: string;
    readonly providerRevision: string;
    readonly dirty: boolean;
    readonly rootRealPathHash: string;
  }>;
}

export interface EngineeringDeliveryResult {
  readonly delivery: EngineeringDelivery;
}
