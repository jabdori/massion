export type RepositoryProviderKind = "git" | "filesystem" | "external";

export interface EvidenceRepository {
  readonly repositoryId: string;
  readonly organizationId: string;
  readonly projectId?: string;
  readonly name: string;
  readonly providerKind: RepositoryProviderKind;
  readonly rootRef: string;
  readonly rootRealPathHash: string;
  readonly defaultBranch?: string;
  readonly status: "active" | "inactive";
  readonly currentIndexVersionId?: string;
  readonly createdByUserId: string;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
}

export interface RepositoryRevision {
  readonly repositoryRevisionId: string;
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly version: number;
  readonly providerRevision: string;
  readonly revision: string;
  readonly dirty: boolean;
  readonly dirtyFingerprint?: string;
  readonly manifestChecksum: string;
  readonly rootRealPathHash: string;
  readonly collectorVersion: string;
  readonly capturedByUserId: string;
  readonly capturedAt: unknown;
}

export type EmbeddingIndexStatus = "unavailable" | "pending" | "complete" | "failed";

export interface IndexConfiguration {
  readonly configurationId: string;
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly version: number;
  readonly checksum: string;
  readonly parserBundleVersion: string;
  readonly schemaVersion: string;
  readonly embeddingVersion?: string;
  readonly embeddingStatus: EmbeddingIndexStatus;
  readonly settings: unknown;
  readonly createdByUserId: string;
  readonly createdAt: unknown;
}

export type IndexVersionStatus = "building" | "complete" | "partial" | "failed" | "superseded";
export type IndexMode = "full" | "incremental" | "reconcile";

export interface IndexVersion {
  readonly indexVersionId: string;
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly repositoryRevisionId: string;
  readonly configurationId: string;
  readonly version: number;
  readonly mode: IndexMode;
  readonly parentIndexVersionId?: string;
  readonly status: IndexVersionStatus;
  readonly current: boolean;
  readonly parserBundleVersion: string;
  readonly schemaVersion: string;
  readonly embeddingVersion?: string;
  readonly embeddingStatus: EmbeddingIndexStatus;
  readonly configurationChecksum: string;
  readonly snapshotChecksum?: string;
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly relationCount: number;
  readonly chunkCount: number;
  readonly error?: { readonly category: string; readonly causeId: string };
  readonly createdByUserId: string;
  readonly createdAt: unknown;
  readonly completedAt?: unknown;
  readonly updatedAt: unknown;
}

export interface RegisterRepositoryInput {
  readonly commandId: string;
  readonly projectId?: string;
  readonly name: string;
  readonly providerKind: RepositoryProviderKind;
  readonly rootRef: string;
  readonly rootRealPathHash: string;
  readonly defaultBranch?: string;
}

export interface CaptureRepositoryRevisionInput {
  readonly commandId: string;
  readonly repositoryId: string;
  readonly providerRevision: string;
  readonly dirty: boolean;
  readonly dirtyFingerprint?: string;
  readonly manifestChecksum: string;
  readonly rootRealPathHash: string;
  readonly collectorVersion: string;
}

export interface CreateIndexConfigurationInput {
  readonly commandId: string;
  readonly repositoryId: string;
  readonly checksum: string;
  readonly parserBundleVersion: string;
  readonly schemaVersion: string;
  readonly embeddingVersion?: string;
  readonly embeddingStatus: EmbeddingIndexStatus;
  readonly settings: unknown;
}

export interface StartIndexInput {
  readonly commandId: string;
  readonly repositoryId: string;
  readonly repositoryRevisionId: string;
  readonly configurationId: string;
  readonly mode: IndexMode;
  readonly parentIndexVersionId?: string;
}

export interface CompleteIndexInput {
  readonly commandId: string;
  readonly indexVersionId: string;
  readonly counts: {
    readonly files: number;
    readonly symbols: number;
    readonly relations: number;
    readonly chunks: number;
  };
  readonly snapshotChecksum: string;
}

export interface FailIndexInput {
  readonly commandId: string;
  readonly indexVersionId: string;
  readonly status: Extract<IndexVersionStatus, "partial" | "failed">;
  readonly error: { readonly category: string; readonly causeId: string };
}

export interface RepositoryAuditFinding {
  readonly code: "current-index" | "index-version" | "repository-pointer";
  readonly message: string;
}
