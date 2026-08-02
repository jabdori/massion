import { renderDocument } from "@massion/records";
import { describe, expect, it } from "vitest";

import { DeterministicRecordsDocumentPlanner } from "./records-document-planner.js";

describe("DeterministicRecordsDocumentPlanner", () => {
  it.each([
    { outputLocale: "en", expectedTitle: "decision", expectedRunbook: "When deploying" },
    { outputLocale: "ko", expectedTitle: "의사결정", expectedRunbook: "배포하거나" },
  ] as const)(
    "$outputLocale 문서를 검증된 source만으로 생성한다",
    async ({ outputLocale, expectedTitle, expectedRunbook }) => {
      const planner = new DeterministicRecordsDocumentPlanner();
      const documents = await planner.plan(
        {} as never,
        {
          commandId: "records-documents-command",
          workId: "records-work",
          requiredKinds: ["adr", "changelog", "runbook"],
          sourceReferences: [
            {
              referenceId: "verification-1",
              organizationId: "org",
              workId: "records-work",
              sourceType: "verification",
            },
          ],
          recovery: {
            request: {
              text: "사용자 승인 정책을 선택형으로 변경",
              request_id: "request-1",
              output_locale: outputLocale,
            },
            messages: [{ message_type: "decision", content: "자동 또는 검토 정책을 조직이 선택한다" }],
          },
        } as never,
      );
      expect(documents.map((document) => document.kind)).toEqual(["adr", "changelog", "runbook"]);
      expect(documents[0]?.title).toContain(expectedTitle);
      expect((documents[2] as { readonly triggers: readonly string[] }).triggers[0]).toContain(expectedRunbook);
      expect(documents.map((document) => renderDocument(document).markdown)).toEqual([
        expect.stringContaining("자동 또는 검토 정책"),
        expect.stringContaining("사용자 승인 정책"),
        expect.stringContaining("Assurance"),
      ]);
    },
  );
});
