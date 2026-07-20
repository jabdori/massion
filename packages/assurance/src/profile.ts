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
    statement: "고정된 target revision에서 기록된 테스트 명령을 독립 재실행한다",
    method: "test",
    requiredEvidenceKinds: ["command-output", "code-change"],
    controlReferences: [],
    planLevel: true,
  },
  {
    key: "profile:software:security",
    statement: "변경된 코드에서 기본 위험 패턴을 독립 검사한다",
    method: "inspection",
    requiredEvidenceKinds: ["code-change"],
    controlReferences: ["OWASP-ASVS-5.0.0", "OWASP-AISVS-1.0"],
    planLevel: true,
  },
  {
    key: "profile:software:reliability",
    statement: "고정된 target revision에서 focused test를 독립 재실행한다",
    method: "test",
    requiredEvidenceKinds: ["command-output", "code-change"],
    controlReferences: [],
    planLevel: true,
  },
  {
    key: "profile:software:operability",
    statement: "고정된 target revision에서 기록된 validation 명령을 독립 재실행한다",
    method: "test",
    requiredEvidenceKinds: ["command-output", "code-change"],
    controlReferences: [],
    planLevel: true,
  },
  {
    key: "profile:software:supply-chain",
    statement: "repository·commit·tree·Artifact checksum을 확인한 뒤 validation 명령을 재실행한다",
    method: "test",
    requiredEvidenceKinds: ["command-output", "code-change"],
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
