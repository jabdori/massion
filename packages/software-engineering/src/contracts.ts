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

/** 독립 검증에서 재실행할 수 있는, 비밀값 없는 명령 명세입니다. */
export interface EngineeringAssuranceCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

/**
 * TDD delivery가 실제로 성공시킨 명령만 보존합니다.
 * 환경 변수와 패치 원문은 넣지 않아, 비밀정보나 코드 본문을 재검증 경로에 저장하지 않습니다.
 */
export interface EngineeringAssuranceRecipe {
  readonly schemaVersion: "massion.software-assurance-recipe.v1";
  readonly focusedCommand: EngineeringAssuranceCommand;
  readonly validationCommands: readonly EngineeringAssuranceCommand[];
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
  readonly assuranceRecipe?: EngineeringAssuranceRecipe;
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
  readonly assuranceRecipe?: EngineeringAssuranceRecipe;
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
