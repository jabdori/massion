import { describe, expect, it } from "vitest";

import {
  RECORDS_MARKDOWN_RENDERER_VERSION,
  renderAdr,
  renderChangelog,
  renderDocument,
  renderRunbook,
  type AdrDocumentSource,
  type ChangelogDocumentSource,
  type RunbookDocumentSource,
} from "./renderer.js";

const adr: AdrDocumentSource = {
  kind: "adr",
  title: "SurrealDB를 기록 정본으로 사용",
  sourceReferenceIds: ["message-decision-1"],
  status: "accepted",
  context: "문서와 완료 계보를 하나의 정본에서 검증해야 합니다.",
  options: [
    {
      name: "SurrealDB typed record",
      description: "구조화 source와 checksum을 저장합니다.",
      positiveConsequences: ["완료 계보를 transaction으로 검증할 수 있습니다."],
      negativeConsequences: ["migration 관리가 필요합니다."],
    },
    {
      name: "Markdown file only",
      description: "저장소 파일만 정본으로 사용합니다.",
      positiveConsequences: ["사람이 바로 읽을 수 있습니다."],
      negativeConsequences: ["동시 수정과 계보 검증이 어렵습니다."],
    },
  ],
  outcome: "SurrealDB typed record를 선택합니다.",
  consequences: ["Markdown은 같은 source에서 파생된 immutable ArtifactVersion입니다."],
};

const changelog: ChangelogDocumentSource = {
  kind: "changelog",
  title: "Records completion gate",
  sourceReferenceIds: ["event-public-api-1"],
  category: "security",
  audience: "Massion 운영자와 extension 개발자",
  notableChange: "검증된 문서 계보가 없으면 Work 완료가 거부됩니다.",
  compatibilityImpact: "기존 Phase 12 Work는 legacy schema로 읽습니다.",
};

const runbook: RunbookDocumentSource = {
  kind: "runbook",
  title: "Records projection 복구",
  sourceReferenceIds: ["artifact-migration-1"],
  triggers: ["WorkRecord 생성 뒤 completed 전이가 중단됐습니다."],
  preconditions: ["Records snapshot checksum을 확인합니다."],
  steps: ["같은 records run ID의 completion command를 재생합니다."],
  validation: ["Work revision이 N+3인지 확인합니다."],
  rollback: ["snapshot이 달라졌다면 기존 run을 blocked 처리합니다."],
  escalation: ["checksum 불일치는 보안 담당 조직에 전달합니다."],
};

describe("Records Markdown renderer", () => {
  it("MADR 구조의 accepted ADR을 렌더링한다", () => {
    const markdown = renderAdr(adr);
    expect(markdown).toMatch(/^# SurrealDB를 기록 정본으로 사용\n\n## Status\n\nAccepted/mu);
    expect(markdown).toContain("## Context and Problem Statement");
    expect(markdown).toContain("## Considered Options");
    expect(markdown).toContain("## Decision Outcome");
    expect(markdown).toContain("## Consequences");
  });

  it("Keep a Changelog category와 Runbook rollback을 렌더링한다", () => {
    expect(renderChangelog(changelog)).toContain("## Security");
    expect(renderChangelog(changelog)).toContain("### Compatibility");
    expect(renderRunbook(runbook)).toContain("## Rollback");
    expect(renderRunbook(runbook)).toContain("## Validation");
  });

  it("같은 source에 byte-identical LF·checksum 결과를 만든다", () => {
    const before = structuredClone(runbook);
    const first = renderDocument(runbook);
    const clone = JSON.parse(JSON.stringify(runbook)) as RunbookDocumentSource;
    const second = renderDocument(clone);

    expect(second).toEqual(first);
    expect(first.rendererVersion).toBe(RECORDS_MARKDOWN_RENDERER_VERSION);
    expect(first.sourceChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(first.markdownChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(first.markdown.endsWith("\n")).toBe(true);
    expect(first.markdown).not.toContain("\r");
    expect(runbook).toEqual(before);
  });

  it("필수 ADR option과 Runbook rollback이 없으면 거부한다", () => {
    expect(() => renderAdr({ ...adr, options: adr.options.slice(0, 1) })).toThrow("2~20개");
    expect(() => renderRunbook({ ...runbook, rollback: [] })).toThrow("rollback");
  });
});
