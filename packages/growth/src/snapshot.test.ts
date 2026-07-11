import { describe, expect, it } from "vitest";

import { createReflectionSnapshot, type ReflectionSnapshotBundle } from "./snapshot.js";

describe("ReflectionSnapshot", () => {
  function bundle(): ReflectionSnapshotBundle {
    return {
      organizationId: "organization-1",
      workId: "work-1",
      recordsRunId: "records-run-1",
      workRecordId: "work-record-1",
      verificationId: "verification-1",
      assuranceRunId: "assurance-run-1",
      configurationVersionId: "configuration-1",
      activeVersions: [
        { kind: "prompt", versionId: "prompt-1", checksum: "a".repeat(64) },
        { kind: "memory", versionId: "memory-1", checksum: "b".repeat(64) },
      ],
      sources: [
        {
          kind: "work-record",
          referenceId: "work-record-1",
          organizationId: "organization-1",
          workId: "work-1",
          checksum: "c".repeat(64),
          capturedRevision: "10",
        },
        {
          kind: "evidence",
          referenceId: "evidence-1",
          organizationId: "organization-1",
          workId: "work-1",
          checksum: "d".repeat(64),
          capturedRevision: "repository-1",
        },
      ],
    };
  }

  it("입력 배열 순서와 무관하게 같은 canonical hash를 만든다", () => {
    const original = bundle();
    const reordered = {
      ...original,
      activeVersions: [...original.activeVersions].reverse(),
      sources: [...original.sources].reverse(),
    };

    expect(createReflectionSnapshot(reordered).hash).toBe(createReflectionSnapshot(original).hash);
  });

  it("다른 tenant·Work source와 허용되지 않은 원문 필드를 거부한다", () => {
    const original = bundle();
    const source = original.sources[0];
    if (!source) throw new Error("테스트 Reflection source가 없습니다");
    expect(() =>
      createReflectionSnapshot({
        ...original,
        sources: [{ ...source, organizationId: "other-organization" }],
      }),
    ).toThrow("소유권");
    expect(() => createReflectionSnapshot({ ...original, rawToolOutput: "secret-value" } as never)).toThrow(
      "허용되지 않은",
    );
  });
});
