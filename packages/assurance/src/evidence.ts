import { createHash } from "node:crypto";

export interface ArtifactEvidence {
  readonly artifactVersionId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly checksum: string;
  readonly contentJson: string;
  readonly createdAt: string;
}

export interface EvidenceBriefEvidence {
  readonly evidenceBriefId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly repositoryId: string;
  readonly repositoryRevisionId: string;
  readonly indexVersionId: string;
  readonly configurationChecksum: string;
  readonly status: "ready" | "stale_warning" | "blocked" | "failed";
  readonly query: string;
  readonly referencesJson: string;
  readonly claimsJson: string;
  readonly checksum: string;
  readonly createdAt: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

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

function assertHash(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label}는 SHA-256 형식이어야 합니다`);
}

function timestamp(value: string, label: string): number {
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) throw new Error(`${label} 시각이 유효하지 않습니다`);
  return parsed;
}

function verifyFreshness(createdAt: string, observedAt: string, maximumAgeMs: number): void {
  if (!Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 0)
    throw new Error("Evidence freshness 상한이 유효하지 않습니다");
  const created = timestamp(createdAt, "Evidence createdAt");
  const observed = timestamp(observedAt, "Evidence observedAt");
  if (created > observed) throw new Error("Evidence가 관측 시각보다 미래에 생성됐습니다");
  if (observed - created > maximumAgeMs) throw new Error("Evidence freshness 상한을 초과했습니다");
}

export function verifyArtifactEvidence(input: {
  readonly organizationId: string;
  readonly workId: string;
  readonly allowedArtifactVersionIds: readonly string[];
  readonly observedAt: string;
  readonly maximumAgeMs: number;
  readonly artifact: ArtifactEvidence;
}): { readonly artifactVersionId: string; readonly checksum: string } {
  const { artifact } = input;
  if (artifact.organizationId !== input.organizationId)
    throw new Error("ArtifactVersion organization이 일치하지 않습니다");
  if (artifact.workId !== input.workId) throw new Error("ArtifactVersion Work가 일치하지 않습니다");
  if (!input.allowedArtifactVersionIds.includes(artifact.artifactVersionId)) {
    throw new Error("허용된 ArtifactVersion ID가 아닙니다");
  }
  assertHash(artifact.checksum, "ArtifactVersion checksum");
  if (sha256(artifact.contentJson) !== artifact.checksum)
    throw new Error("ArtifactVersion content checksum이 일치하지 않습니다");
  verifyFreshness(artifact.createdAt, input.observedAt, input.maximumAgeMs);
  return { artifactVersionId: artifact.artifactVersionId, checksum: artifact.checksum };
}

export function verifyEvidenceBriefFreshness(input: {
  readonly organizationId: string;
  readonly workId: string;
  readonly observedAt: string;
  readonly maximumAgeMs: number;
  readonly current: {
    readonly repositoryRevisionId: string;
    readonly indexVersionId: string;
    readonly configurationChecksum: string;
  };
  readonly brief: EvidenceBriefEvidence;
}): { readonly evidenceBriefId: string; readonly checksum: string } {
  const { brief, current } = input;
  if (brief.organizationId !== input.organizationId) throw new Error("EvidenceBrief organization이 일치하지 않습니다");
  if (brief.workId !== input.workId) throw new Error("EvidenceBrief Work가 일치하지 않습니다");
  if (brief.status !== "ready") throw new Error("ready EvidenceBrief만 검증 증거로 사용할 수 있습니다");
  if (brief.repositoryRevisionId !== current.repositoryRevisionId) {
    throw new Error("EvidenceBrief repository revision이 현재 revision과 다릅니다");
  }
  if (brief.indexVersionId !== current.indexVersionId) {
    throw new Error("EvidenceBrief index version이 현재 index와 다릅니다");
  }
  if (brief.configurationChecksum !== current.configurationChecksum) {
    throw new Error("EvidenceBrief configuration checksum이 현재 구성과 다릅니다");
  }
  assertHash(brief.configurationChecksum, "EvidenceBrief configuration checksum");
  assertHash(brief.checksum, "EvidenceBrief checksum");
  let references: unknown;
  let claims: unknown;
  try {
    references = JSON.parse(brief.referencesJson) as unknown;
    claims = JSON.parse(brief.claimsJson) as unknown;
  } catch {
    throw new Error("EvidenceBrief references 또는 claims JSON이 올바르지 않습니다");
  }
  if (!Array.isArray(references) || !Array.isArray(claims)) {
    throw new Error("EvidenceBrief references와 claims는 배열이어야 합니다");
  }
  const checksum = sha256(
    canonicalJson({
      workId: brief.workId,
      repositoryId: brief.repositoryId,
      repositoryRevisionId: brief.repositoryRevisionId,
      indexVersionId: brief.indexVersionId,
      configurationChecksum: brief.configurationChecksum,
      query: brief.query,
      status: brief.status,
      references,
      claims,
    }),
  );
  if (checksum !== brief.checksum) throw new Error("EvidenceBrief content checksum이 일치하지 않습니다");
  verifyFreshness(brief.createdAt, input.observedAt, input.maximumAgeMs);
  return { evidenceBriefId: brief.evidenceBriefId, checksum: brief.checksum };
}
