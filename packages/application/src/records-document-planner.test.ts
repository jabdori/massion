import { renderDocument } from "@massion/records";
import { describe, expect, it } from "vitest";

import { DeterministicRecordsDocumentPlanner } from "./records-document-planner.js";

describe("DeterministicRecordsDocumentPlanner", () => {
  it("검증된 source만으로 세 문서 형식을 renderer 계약에 맞게 생성한다", async () => {
    const planner = new DeterministicRecordsDocumentPlanner();
    const documents = await planner.plan(
      {} as never,
      {
        commandId: "records-documents-command",
        workId: "records-work",
        requiredKinds: ["adr", "changelog", "runbook"],
        sourceReferences: [
          { referenceId: "verification-1", organizationId: "org", workId: "records-work", sourceType: "verification" },
        ],
        recovery: {
          request: { text: "사용자 승인 정책을 선택형으로 변경", request_id: "request-1" },
          messages: [{ message_type: "decision", content: "자동 또는 검토 정책을 조직이 선택한다" }],
        },
      } as never,
    );
    expect(documents.map((document) => document.kind)).toEqual(["adr", "changelog", "runbook"]);
    expect(documents.map((document) => renderDocument(document).markdown)).toEqual([
      expect.stringContaining("자동 또는 검토 정책"),
      expect.stringContaining("사용자 승인 정책"),
      expect.stringContaining("Assurance"),
    ]);
  });
});
