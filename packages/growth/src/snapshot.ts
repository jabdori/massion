import { growthChecksum, canonicalGrowthJson } from "./prompt-memory.js";

export interface ReflectionVersionReference {
  readonly kind: "prompt" | "memory" | "policy" | "organization";
  readonly versionId: string;
  readonly checksum: string;
}

export interface ReflectionSourceReference {
  readonly kind: "work-record" | "event" | "message" | "artifact" | "evidence" | "symbol" | "memory";
  readonly referenceId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly checksum: string;
  readonly capturedRevision: string;
}

export interface ReflectionSnapshotBundle {
  readonly organizationId: string;
  readonly workId: string;
  readonly recordsRunId: string;
  readonly workRecordId: string;
  readonly verificationId: string;
  readonly assuranceRunId: string;
  readonly configurationVersionId: string;
  readonly activeVersions: readonly ReflectionVersionReference[];
  readonly sources: readonly ReflectionSourceReference[];
}

export interface ReflectionSnapshot {
  readonly hash: string;
  readonly canonicalJson: string;
  readonly material: ReflectionSnapshotBundle;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const ALLOWED_KEYS = new Set([
  "organizationId",
  "workId",
  "recordsRunId",
  "workRecordId",
  "verificationId",
  "assuranceRunId",
  "configurationVersionId",
  "activeVersions",
  "sources",
]);

function identifier(value: string, label: string): void {
  if (!value || value.length > 200) throw new Error(`${label} identifier는 1~200자여야 합니다`);
}

export function createReflectionSnapshot(bundle: ReflectionSnapshotBundle): ReflectionSnapshot {
  for (const key of Object.keys(bundle)) {
    if (!ALLOWED_KEYS.has(key)) throw new Error(`Reflection snapshot에 허용되지 않은 필드입니다: ${key}`);
  }
  for (const [label, value] of [
    ["Organization", bundle.organizationId],
    ["Work", bundle.workId],
    ["Records run", bundle.recordsRunId],
    ["Work record", bundle.workRecordId],
    ["Verification", bundle.verificationId],
    ["Assurance run", bundle.assuranceRunId],
    ["Configuration version", bundle.configurationVersionId],
  ] as const) {
    identifier(value, label);
  }
  const sourceIds = new Set<string>();
  for (const source of bundle.sources) {
    if (source.organizationId !== bundle.organizationId || source.workId !== bundle.workId) {
      throw new Error("Reflection source 소유권이 snapshot 대상과 다릅니다");
    }
    identifier(source.referenceId, "Source reference");
    if (sourceIds.has(source.referenceId)) throw new Error("Reflection source가 중복됐습니다");
    sourceIds.add(source.referenceId);
    if (!SHA256.test(source.checksum)) throw new Error("Reflection source checksum이 유효하지 않습니다");
  }
  for (const version of bundle.activeVersions) {
    identifier(version.versionId, "Active version");
    if (!SHA256.test(version.checksum)) throw new Error("Active version checksum이 유효하지 않습니다");
  }
  const material: ReflectionSnapshotBundle = {
    ...bundle,
    activeVersions: [...bundle.activeVersions].sort(
      (left, right) => left.kind.localeCompare(right.kind) || left.versionId.localeCompare(right.versionId),
    ),
    sources: [...bundle.sources].sort(
      (left, right) => left.kind.localeCompare(right.kind) || left.referenceId.localeCompare(right.referenceId),
    ),
  };
  const serialized = canonicalGrowthJson(material);
  return { hash: growthChecksum(material), canonicalJson: serialized, material };
}
