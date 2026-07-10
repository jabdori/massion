import { createHash } from "node:crypto";

import {
  validateDocumentationImpactAssessment,
  type DocumentationImpactAssessment,
  type DocumentationKind,
} from "./contracts.js";

export const RECORDS_IMPACT_EVALUATOR_VERSION = "massion.records.impact.v1";

export type DocumentationImpactProposalKind = "decision" | "user-visible" | "operational" | "reference";
export type DocumentationSourceType = "verification" | "event" | "message" | "artifact" | "decision";
type ConditionalDocumentationKind = Exclude<DocumentationKind, "work-record">;

export interface DocumentationImpactProposalInput {
  readonly kind: DocumentationImpactProposalKind;
  readonly ruleHint: string;
  readonly reason: string;
  readonly sourceReferenceIds: readonly string[];
}

export interface DocumentationSourceReference {
  readonly referenceId: string;
  readonly organizationId: string;
  readonly workId: string;
  readonly sourceType: DocumentationSourceType;
}

export interface DocumentationImpactEvaluationInput {
  readonly organizationId: string;
  readonly workId: string;
  readonly recordsRunId: string;
  readonly verificationReferenceId: string;
  readonly evaluatedAt: string;
  readonly proposals: readonly DocumentationImpactProposalInput[];
  readonly sources: readonly DocumentationSourceReference[];
}

export type DocumentationImpactEvaluation = Readonly<Record<DocumentationKind, DocumentationImpactAssessment>>;

const PROPOSAL_KINDS = new Set<DocumentationImpactProposalKind>([
  "decision",
  "user-visible",
  "operational",
  "reference",
]);
const SOURCE_TYPES = new Set<DocumentationSourceType>(["verification", "event", "message", "artifact", "decision"]);
const ALLOWED_SOURCES: Readonly<Record<DocumentationImpactProposalKind, ReadonlySet<DocumentationSourceType>>> = {
  decision: new Set(["message", "decision"]),
  "user-visible": new Set(["event", "message", "artifact"]),
  operational: new Set(["event", "artifact", "decision"]),
  reference: new Set(["verification", "event", "message", "artifact", "decision"]),
};
const TARGET_KIND: Readonly<
  Record<Exclude<DocumentationImpactProposalKind, "reference">, ConditionalDocumentationKind>
> = {
  decision: "adr",
  "user-visible": "changelog",
  operational: "runbook",
};
const RULE_ID: Readonly<Record<Exclude<DocumentationImpactProposalKind, "reference">, string>> = {
  decision: "adr.decision.v1",
  "user-visible": "changelog.user-visible.v1",
  operational: "runbook.operational.v1",
};

function identifier(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new Error(`${name}은 1~200자여야 합니다`);
  }
}

function assessmentId(recordsRunId: string, kind: DocumentationKind): string {
  return createHash("sha256").update(`${recordsRunId}:${kind}:${RECORDS_IMPACT_EVALUATOR_VERSION}`).digest("hex");
}

function assertNoInjectedProjection(proposal: DocumentationImpactProposalInput): void {
  const input = proposal as unknown as Readonly<Record<string, unknown>>;
  for (const field of ["outcome", "required", "documentKind", "status"] as const) {
    if (Object.hasOwn(input, field)) throw new Error(`caller의 ${field} 주입은 허용되지 않습니다`);
  }
}

function validateSourceReferenceIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error("Proposal source reference는 중복 없이 1~100개여야 합니다");
  }
  const references: string[] = [];
  for (const candidate of value as unknown[]) {
    identifier(candidate, "Source reference ID");
    references.push(candidate);
  }
  if (new Set(references).size !== references.length) {
    throw new Error("Proposal source reference는 중복 없이 1~100개여야 합니다");
  }
  return references;
}

export function evaluateDocumentationImpacts(input: DocumentationImpactEvaluationInput): DocumentationImpactEvaluation {
  identifier(input.organizationId, "Organization ID");
  identifier(input.workId, "Work ID");
  identifier(input.recordsRunId, "Records run ID");
  identifier(input.verificationReferenceId, "Verification reference ID");

  const sourceById = new Map<string, DocumentationSourceReference>();
  for (const source of input.sources) {
    identifier(source.referenceId, "Source reference ID");
    if (sourceById.has(source.referenceId)) throw new Error("Source reference identity는 중복될 수 없습니다");
    if (!SOURCE_TYPES.has(source.sourceType)) throw new Error("지원하지 않는 source 종류입니다");
    sourceById.set(source.referenceId, source);
  }

  const verificationSource = sourceById.get(input.verificationReferenceId);
  if (!verificationSource || verificationSource.sourceType !== "verification") {
    throw new Error("WorkRecord에는 실제 Verification source가 필요합니다");
  }
  if (verificationSource.organizationId !== input.organizationId || verificationSource.workId !== input.workId) {
    throw new Error("Verification source 소유권이 대상 Work와 다릅니다");
  }

  const proposalsByTarget: Record<ConditionalDocumentationKind, DocumentationImpactProposalInput[]> = {
    adr: [],
    changelog: [],
    runbook: [],
  };
  for (const proposal of input.proposals) {
    assertNoInjectedProjection(proposal);
    if (!PROPOSAL_KINDS.has(proposal.kind)) throw new Error("지원하지 않는 documentation impact proposal kind입니다");
    identifier(proposal.ruleHint, "Rule hint");
    if (typeof proposal.reason !== "string" || proposal.reason.length === 0 || proposal.reason.length > 2_000) {
      throw new Error("Proposal reason은 1~2000자여야 합니다");
    }
    const sourceReferenceIds = validateSourceReferenceIds(proposal.sourceReferenceIds);
    for (const referenceId of sourceReferenceIds) {
      const source = sourceById.get(referenceId);
      if (!source) throw new Error(`Proposal source를 찾을 수 없습니다: ${referenceId}`);
      if (source.organizationId !== input.organizationId || source.workId !== input.workId) {
        throw new Error("Proposal source 소유권이 대상 Work와 다릅니다");
      }
      if (!ALLOWED_SOURCES[proposal.kind].has(source.sourceType)) {
        throw new Error(`${proposal.kind} proposal의 source 종류가 올바르지 않습니다`);
      }
    }
    if (proposal.kind !== "reference") proposalsByTarget[TARGET_KIND[proposal.kind]].push(proposal);
  }

  const common = {
    organizationId: input.organizationId,
    workId: input.workId,
    recordsRunId: input.recordsRunId,
    evaluatorVersion: RECORDS_IMPACT_EVALUATOR_VERSION,
    createdAt: input.evaluatedAt,
  } as const;
  const result = {} as Record<DocumentationKind, DocumentationImpactAssessment>;
  result["work-record"] = {
    ...common,
    assessmentId: assessmentId(input.recordsRunId, "work-record"),
    kind: "work-record",
    outcome: "required",
    ruleId: "work-record.always.v1",
    reason: "완료되는 모든 Work에는 검증 계보를 가진 WorkRecord가 필요합니다",
    sourceReferenceIds: [input.verificationReferenceId],
  };

  for (const kind of ["adr", "changelog", "runbook"] as const) {
    const proposals = proposalsByTarget[kind].sort((left, right) => {
      const leftKey = `${left.ruleHint}:${left.reason}:${[...left.sourceReferenceIds].sort().join(",")}`;
      const rightKey = `${right.ruleHint}:${right.reason}:${[...right.sourceReferenceIds].sort().join(",")}`;
      return leftKey.localeCompare(rightKey);
    });
    if (proposals.length === 0) {
      result[kind] = {
        ...common,
        assessmentId: assessmentId(input.recordsRunId, kind),
        kind,
        outcome: "not-applicable",
        ruleId: `${kind}.none.v1`,
        reason: `${kind} 문서가 필요한 검증된 영향 source가 없습니다`,
        sourceReferenceIds: [],
      };
      continue;
    }
    const reason = [...new Set(proposals.map((proposal) => proposal.reason))].join("; ");
    if (reason.length > 2_000) throw new Error(`${kind} impact reason 합계는 2000자 이하여야 합니다`);
    const sourceReferenceIds = [...new Set(proposals.flatMap((proposal) => [...proposal.sourceReferenceIds]))].sort();
    const firstProposal = proposals[0];
    if (!firstProposal || firstProposal.kind === "reference") {
      throw new Error(`${kind} required 판정에는 조건부 documentation proposal이 필요합니다`);
    }
    result[kind] = {
      ...common,
      assessmentId: assessmentId(input.recordsRunId, kind),
      kind,
      outcome: "required",
      ruleId: RULE_ID[firstProposal.kind],
      reason,
      sourceReferenceIds,
    };
  }

  for (const assessment of Object.values(result)) validateDocumentationImpactAssessment(assessment);
  return result;
}
