import { createHash } from "node:crypto";

export interface RecordsSnapshotWork {
  readonly organizationId: string;
  readonly workId: string;
  readonly status: string;
  readonly revision: number;
  readonly organizationVersionId: string;
  readonly activePlanVersionId: string;
  readonly contextVersionId?: string;
  readonly policyVersionId?: string;
  readonly promptVersionId?: string;
  readonly artifactVersionIds: readonly string[];
}

export interface RecordsSnapshotPlan {
  readonly organizationId: string;
  readonly workId: string;
  readonly planVersionId: string;
  readonly checksum: string;
}

export interface RecordsSnapshotEvent {
  readonly organizationId: string;
  readonly workId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly requestHash: string;
  readonly resultHash: string;
  readonly causedByEventId?: string;
}

export interface RecordsSnapshotDecisionMessage {
  readonly organizationId: string;
  readonly workId: string;
  readonly messageId: string;
  readonly sequence: number;
  readonly contentHash: string;
  readonly replyToMessageId?: string;
  readonly causedByMessageId?: string;
}

export interface RecordsSnapshotArtifactVersion {
  readonly organizationId: string;
  readonly workId: string;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly kind: string;
  readonly name: string;
  readonly checksum: string;
}

export interface RecordsSnapshotVerification {
  readonly organizationId: string;
  readonly workId: string;
  readonly verificationId: string;
  readonly passed: boolean;
  readonly targetWorkRevision: number;
  readonly projectedWorkRevision: number;
  readonly assuranceRunId: string;
  readonly assuranceSnapshotHash: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly bindingVersionId: string;
  readonly evidenceArtifactVersionId: string;
}

export interface RecordsSnapshotGovernanceReference {
  readonly organizationId: string;
  readonly workId: string;
  readonly decisionId: string;
  readonly approvalId?: string;
  readonly outcomeHash: string;
}

export interface RecordsSnapshotBundle {
  readonly organizationId: string;
  readonly rendererVersion: string;
  readonly work: RecordsSnapshotWork;
  readonly plan: RecordsSnapshotPlan;
  readonly events: readonly RecordsSnapshotEvent[];
  readonly decisionMessages: readonly RecordsSnapshotDecisionMessage[];
  readonly artifactVersions: readonly RecordsSnapshotArtifactVersion[];
  readonly verification: RecordsSnapshotVerification;
  readonly governanceReferences: readonly RecordsSnapshotGovernanceReference[];
}

export interface RecordsSnapshot {
  readonly hash: string;
  readonly canonicalJson: string;
  readonly material: Readonly<Record<string, unknown>>;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

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

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new Error(`${label} identifier는 1~200자여야 합니다`);
  }
}

function assertSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${label}은 lowercase SHA-256이어야 합니다`);
}

function assertOwnership(
  expectedOrganizationId: string,
  expectedWorkId: string,
  value: { readonly organizationId: string; readonly workId: string },
  label: string,
): void {
  if (value.organizationId !== expectedOrganizationId || value.workId !== expectedWorkId) {
    throw new Error(`${label} 소유권이 Records snapshot 대상과 다릅니다`);
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} identity는 중복될 수 없습니다`);
}

export function createRecordsSnapshot(bundle: RecordsSnapshotBundle): RecordsSnapshot {
  assertIdentifier(bundle.organizationId, "Organization");
  assertIdentifier(bundle.rendererVersion, "Renderer version");
  assertOwnership(bundle.organizationId, bundle.work.workId, bundle.work, "Work");
  assertIdentifier(bundle.work.workId, "Work");
  if (bundle.work.status !== "verifying") throw new Error("Records snapshot의 Work는 verifying 상태여야 합니다");
  if (!Number.isSafeInteger(bundle.work.revision) || bundle.work.revision < 1) {
    throw new Error("Work revision은 1 이상인 안전한 정수여야 합니다");
  }
  assertOwnership(bundle.organizationId, bundle.work.workId, bundle.plan, "PlanVersion");
  if (bundle.plan.planVersionId !== bundle.work.activePlanVersionId) {
    throw new Error("활성 PlanVersion과 snapshot PlanVersion이 다릅니다");
  }
  assertSha256(bundle.plan.checksum, "Plan checksum");

  assertOwnership(bundle.organizationId, bundle.work.workId, bundle.verification, "Verification");
  if (!bundle.verification.passed) throw new Error("Records snapshot에는 passed Verification이 필요합니다");
  if (bundle.verification.projectedWorkRevision !== bundle.work.revision) {
    throw new Error("Verification projected revision과 Work revision이 다릅니다");
  }
  if (bundle.verification.targetWorkRevision + 1 !== bundle.verification.projectedWorkRevision) {
    throw new Error("Verification은 target revision의 정확한 N+1 projection이어야 합니다");
  }
  assertSha256(bundle.verification.assuranceSnapshotHash, "Assurance snapshot hash");

  for (const event of bundle.events) {
    assertOwnership(bundle.organizationId, bundle.work.workId, event, "WorkEvent");
    assertSha256(event.requestHash, "WorkEvent request hash");
    assertSha256(event.resultHash, "WorkEvent result hash");
  }
  for (const message of bundle.decisionMessages) {
    assertOwnership(bundle.organizationId, bundle.work.workId, message, "Decision message");
    assertSha256(message.contentHash, "Decision message content hash");
  }
  for (const artifact of bundle.artifactVersions) {
    assertOwnership(bundle.organizationId, bundle.work.workId, artifact, "ArtifactVersion");
    assertSha256(artifact.checksum, "ArtifactVersion checksum");
  }
  for (const reference of bundle.governanceReferences) {
    assertOwnership(bundle.organizationId, bundle.work.workId, reference, "Governance reference");
    assertSha256(reference.outcomeHash, "Governance outcome hash");
  }

  assertUnique(
    bundle.events.map((event) => event.eventId),
    "WorkEvent",
  );
  assertUnique(
    bundle.events.map((event) => String(event.sequence)),
    "WorkEvent sequence",
  );
  assertUnique(
    bundle.decisionMessages.map((message) => message.messageId),
    "Decision message",
  );
  assertUnique(
    bundle.artifactVersions.map((artifact) => artifact.artifactVersionId),
    "ArtifactVersion",
  );
  assertUnique(
    bundle.governanceReferences.map((reference) => reference.decisionId),
    "Governance decision",
  );
  assertUnique(bundle.work.artifactVersionIds, "Work ArtifactVersion reference");

  const artifactsById = new Map(
    bundle.artifactVersions.map((artifact) => [artifact.artifactVersionId, artifact] as const),
  );
  for (const artifactVersionId of bundle.work.artifactVersionIds) {
    if (!artifactsById.has(artifactVersionId)) {
      throw new Error(`Work가 참조하는 ArtifactVersion을 찾을 수 없습니다: ${artifactVersionId}`);
    }
  }
  if (!artifactsById.has(bundle.verification.evidenceArtifactVersionId)) {
    throw new Error("Verification evidence ArtifactVersion을 찾을 수 없습니다");
  }

  const material = {
    organizationId: bundle.organizationId,
    rendererVersion: bundle.rendererVersion,
    work: {
      ...bundle.work,
      artifactVersionIds: [...bundle.work.artifactVersionIds].sort(),
    },
    plan: bundle.plan,
    events: [...bundle.events].sort(
      (left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId),
    ),
    decisionMessages: [...bundle.decisionMessages].sort(
      (left, right) => left.sequence - right.sequence || left.messageId.localeCompare(right.messageId),
    ),
    artifactVersions: [...bundle.artifactVersions].sort((left, right) =>
      left.artifactVersionId.localeCompare(right.artifactVersionId),
    ),
    verification: bundle.verification,
    governanceReferences: [...bundle.governanceReferences].sort((left, right) =>
      left.decisionId.localeCompare(right.decisionId),
    ),
  } as const;
  const serialized = canonicalJson(material);
  return {
    hash: createHash("sha256").update(serialized).digest("hex"),
    canonicalJson: serialized,
    material,
  };
}
