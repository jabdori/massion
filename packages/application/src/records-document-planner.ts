import type { RecordsDocumentSource } from "@massion/records";
import type { TenantContext } from "@massion/identity";

import type { CoreRecordsDocumentPlanner } from "./core-records-stage.js";

function bounded(value: string, fallback: string, maximum = 4_000): string {
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
  return (normalized || fallback).slice(0, maximum);
}

export class DeterministicRecordsDocumentPlanner implements CoreRecordsDocumentPlanner {
  public plan(
    _context: TenantContext,
    input: Parameters<CoreRecordsDocumentPlanner["plan"]>[1],
  ): Promise<readonly RecordsDocumentSource[]> {
    const referenceIds = [...new Set(input.sourceReferences.map((source) => source.referenceId))].slice(0, 100);
    if (input.requiredKinds.length > 0 && referenceIds.length === 0) {
      throw new Error("Records 문서에는 검증된 source reference가 필요합니다");
    }
    const objective = bounded(input.recovery.request.text, `Work ${input.workId}`);
    const decisions = input.recovery.messages
      .filter((message) => message.message_type === "decision")
      .map((message) => bounded(message.content, "결정 내용 없음"));
    const decision = decisions.join("\n") || objective;
    const documents: RecordsDocumentSource[] = [];
    for (const kind of [...new Set(input.requiredKinds)]) {
      if (kind === "adr") {
        documents.push({
          kind,
          title: `Work ${input.workId} 의사결정`,
          sourceReferenceIds: referenceIds,
          status: "accepted",
          context: objective,
          options: [
            {
              name: "검증된 변경 적용",
              description: decision,
              positiveConsequences: ["검증된 Work 결과를 반영합니다"],
              negativeConsequences: ["변경에 따른 유지보수 비용이 발생할 수 있습니다"],
            },
            {
              name: "현재 상태 유지",
              description: "검증된 변경을 반영하지 않습니다",
              positiveConsequences: ["현재 동작을 유지합니다"],
              negativeConsequences: ["Work 목표가 달성되지 않습니다"],
            },
          ],
          outcome: decision,
          consequences: ["검증·산출물·결정 source의 계보를 유지합니다"],
        });
      } else if (kind === "changelog") {
        documents.push({
          kind,
          title: `Work ${input.workId} 변경 이력`,
          sourceReferenceIds: referenceIds,
          category: "changed",
          audience: "Massion AgentOS 사용자와 운영자",
          notableChange: objective,
          compatibilityImpact: "연결된 검증 결과와 산출물 참조를 확인해주세요",
        });
      } else {
        documents.push({
          kind,
          title: `Work ${input.workId} 운영 절차`,
          sourceReferenceIds: referenceIds,
          triggers: ["이 Work 결과를 배포하거나 운영 환경에 반영할 때"],
          preconditions: ["연결된 Assurance 결과가 passed인지 확인합니다"],
          steps: ["Work 기록과 산출물을 확인합니다", "승인된 변경을 대상 환경에 적용합니다"],
          validation: ["Work의 acceptance criteria와 실제 결과를 다시 확인합니다"],
          rollback: ["변경 전 버전 또는 이전 산출물로 복구합니다"],
          escalation: ["검증 실패나 계보 불일치 시 Assurance 담당 조직에 전달합니다"],
        });
      }
    }
    return Promise.resolve(documents);
  }
}
