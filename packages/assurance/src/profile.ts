import type { AssuranceCriterionMethod } from "./contracts.js";

export interface AssuranceProfileCriterionTemplate {
  readonly key: string;
  readonly statement: string;
  readonly method: AssuranceCriterionMethod;
  readonly requiredEvidenceKinds: readonly string[];
  readonly controlReferences: readonly string[];
  readonly planLevel: boolean;
}

export interface AssuranceProfile {
  readonly profileId: string;
  readonly version: string;
  readonly criteria: readonly AssuranceProfileCriterionTemplate[];
  readonly allowedExclusionRules: readonly string[];
  readonly controlVersions: Readonly<Record<string, string>>;
}

const ACCEPTANCE_CRITERION: AssuranceProfileCriterionTemplate = {
  key: "profile:acceptance:coverage",
  statement: "제외되지 않은 모든 Acceptance Criterion을 검증 증거로 판정한다",
  method: "evidence",
  requiredEvidenceKinds: ["check-result"],
  controlReferences: [],
  planLevel: true,
};

const SOFTWARE_CRITERIA: readonly AssuranceProfileCriterionTemplate[] = [
  {
    key: "profile:software:correctness",
    statement: "고정된 target revision에서 테스트와 validation을 독립 재실행한다",
    method: "test",
    requiredEvidenceKinds: ["command", "artifact-version"],
    controlReferences: [],
    planLevel: true,
  },
  {
    key: "profile:software:security",
    statement: "보안 도구 결과와 적용 가능한 보안 finding을 판정한다",
    method: "inspection",
    requiredEvidenceKinds: ["sarif", "finding"],
    controlReferences: ["OWASP-ASVS-5.0.0", "OWASP-AISVS-1.0"],
    planLevel: true,
  },
  {
    key: "profile:software:reliability",
    statement: "계획에서 요구한 timeout·복구·동시성 동작을 검증한다",
    method: "test",
    requiredEvidenceKinds: ["command"],
    controlReferences: [],
    planLevel: true,
  },
  {
    key: "profile:software:operability",
    statement: "build·구성·실행·rollback 근거를 검증한다",
    method: "test",
    requiredEvidenceKinds: ["command", "artifact-version"],
    controlReferences: [],
    planLevel: true,
  },
  {
    key: "profile:software:supply-chain",
    statement: "repository·commit·tree·Artifact checksum과 도구 version을 결속한다",
    method: "evidence",
    requiredEvidenceKinds: ["artifact-version", "provenance"],
    controlReferences: ["SLSA-1.2"],
    planLevel: true,
  },
];

const CONTROL_VERSIONS = {
  asvs: "5.0.0",
  aisvs: "1.0",
  slsa: "1.2",
  sarif: "2.1.0-errata-01",
} as const;

export function selectAssuranceProfile(artifactKinds: readonly string[]): AssuranceProfile {
  const software = artifactKinds.includes("code-change");
  return {
    profileId: software ? "massion.assurance.software-change.v1" : "massion.assurance.acceptance.v1",
    version: "1.0.0",
    criteria: software ? [ACCEPTANCE_CRITERION, ...SOFTWARE_CRITERIA] : [ACCEPTANCE_CRITERION],
    allowedExclusionRules: ["cancelled-task-only"],
    controlVersions: software ? CONTROL_VERSIONS : {},
  };
}
