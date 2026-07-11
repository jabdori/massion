import semver from "semver";

export type RegistryVersionState = "staged" | "published" | "recalled";
export type AssessmentOutcome = "pass" | "fail" | "unknown";
export type PublicationPolicy = "manual" | "risk-based" | "automatic";
export type RegistryVisibility = "public" | "private";
export type RecallSeverity = "low" | "medium" | "high" | "critical";

export interface RegistryAssessment {
  readonly archive: AssessmentOutcome;
  readonly provenance: AssessmentOutcome;
  readonly sbom: AssessmentOutcome;
  readonly vulnerability: AssessmentOutcome;
  readonly contract: AssessmentOutcome;
  readonly policy: AssessmentOutcome;
}

export interface RegistryRecall {
  readonly recallId: string;
  readonly category: "security" | "malware" | "publisher-compromise" | "policy" | "compatibility";
  readonly severity: RecallSeverity;
  readonly reason: string;
  readonly action?: "recall" | "supersede";
  readonly supersedesRecallId?: string;
  readonly createdAt?: string;
}

export interface RegistryVersionInput {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly artifactDigest: string;
  readonly contentDigest: string;
  readonly visibility: RegistryVisibility;
  readonly ownerOrganizationId: string;
  readonly manifest: Readonly<Record<string, unknown>>;
}

export interface RegistryVersion extends RegistryVersionInput {
  readonly versionId: string;
  readonly state: RegistryVersionState;
  readonly assessment?: RegistryAssessment;
  readonly publishedByDecisionId?: string;
  readonly createdAt: string;
  readonly publishedAt?: string;
}

const PACKAGE = /^@massion-ext\/[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/u;

export function normalizePackageIdentity(name: string, version: string): { name: string; version: string } {
  if (!PACKAGE.test(name)) throw new Error("Extension package는 @massion-ext scope여야 합니다");
  if (!semver.valid(version) || semver.clean(version) !== version)
    throw new Error("version은 canonical SemVer여야 합니다");
  return { name, version };
}

export function assertDigest(value: string, label: string): void {
  if (!DIGEST.test(value)) throw new Error(`${label} SHA-256 digest가 유효하지 않습니다`);
}

export function assertRegistryId(value: string, label: string): void {
  if (!ID.test(value)) throw new Error(`${label} 식별자가 유효하지 않습니다`);
}

export function transitionVersion(current: RegistryVersionState, next: RegistryVersionState): RegistryVersionState {
  if (!((current === "staged" && next === "published") || (current === "published" && next === "recalled"))) {
    throw new Error(`Registry version 상태 전이를 허용하지 않습니다: ${current} -> ${next}`);
  }
  return next;
}

export function assessmentPassed(assessment: RegistryAssessment | undefined): assessment is RegistryAssessment {
  return assessment !== undefined && Object.values(assessment).every((outcome) => outcome === "pass");
}
