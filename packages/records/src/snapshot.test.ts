import { expect, it } from "vitest";

import { createRecordsSnapshot, type RecordsSnapshotBundle } from "./snapshot.js";

function bundle(): RecordsSnapshotBundle {
  return {
    organizationId: "organization-1",
    rendererVersion: "massion.records.markdown.v1",
    work: {
      organizationId: "organization-1",
      workId: "work-1",
      status: "verifying",
      revision: 9,
      organizationVersionId: "organization-version-1",
      activePlanVersionId: "plan-1",
      artifactVersionIds: ["artifact-version-2", "artifact-version-1"],
    },
    plan: {
      organizationId: "organization-1",
      workId: "work-1",
      planVersionId: "plan-1",
      checksum: "1".repeat(64),
    },
    events: [
      {
        organizationId: "organization-1",
        workId: "work-1",
        eventId: "event-2",
        sequence: 2,
        eventType: "verification_projected",
        requestHash: "2".repeat(64),
        resultHash: "3".repeat(64),
        causedByEventId: "event-1",
      },
      {
        organizationId: "organization-1",
        workId: "work-1",
        eventId: "event-1",
        sequence: 1,
        eventType: "work_created",
        requestHash: "4".repeat(64),
        resultHash: "5".repeat(64),
      },
    ],
    decisionMessages: [
      {
        organizationId: "organization-1",
        workId: "work-1",
        messageId: "message-2",
        sequence: 2,
        contentHash: "6".repeat(64),
        causedByMessageId: "message-1",
      },
      {
        organizationId: "organization-1",
        workId: "work-1",
        messageId: "message-1",
        sequence: 1,
        contentHash: "7".repeat(64),
      },
    ],
    artifactVersions: [
      {
        organizationId: "organization-1",
        workId: "work-1",
        artifactId: "artifact-2",
        artifactVersionId: "artifact-version-2",
        kind: "verification-evidence",
        name: "verification.json",
        checksum: "8".repeat(64),
      },
      {
        organizationId: "organization-1",
        workId: "work-1",
        artifactId: "artifact-1",
        artifactVersionId: "artifact-version-1",
        kind: "code-change",
        name: "change.patch",
        checksum: "9".repeat(64),
      },
    ],
    verification: {
      organizationId: "organization-1",
      workId: "work-1",
      verificationId: "verification-1",
      passed: true,
      targetWorkRevision: 8,
      projectedWorkRevision: 9,
      assuranceRunId: "assurance-run-1",
      assuranceSnapshotHash: "a".repeat(64),
      profileId: "massion.assurance.software-change.v1",
      profileVersion: "1.0.0",
      bindingVersionId: "binding-1",
      evidenceArtifactVersionId: "artifact-version-2",
    },
    governanceReferences: [
      {
        organizationId: "organization-1",
        workId: "work-1",
        decisionId: "decision-1",
        approvalId: "approval-1",
        outcomeHash: "b".repeat(64),
      },
    ],
  };
}

it("collection 순서와 object key 순서에 무관한 Records snapshot을 만든다", () => {
  const first = createRecordsSnapshot(bundle());
  const original = bundle();
  const reordered: RecordsSnapshotBundle = {
    ...original,
    work: { ...original.work, artifactVersionIds: [...original.work.artifactVersionIds].reverse() },
    events: [...original.events].reverse(),
    decisionMessages: [...original.decisionMessages].reverse(),
    artifactVersions: [...original.artifactVersions].reverse(),
  };

  expect(createRecordsSnapshot(reordered)).toEqual(first);
  expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(first.canonicalJson).not.toContain("request_json");
});

it("반복 permutation에서도 같은 hash를 유지하고 material 변경은 구분한다", () => {
  const expected = createRecordsSnapshot(bundle()).hash;
  for (let offset = 0; offset < 32; offset += 1) {
    const original = bundle();
    const rotate = <T>(values: readonly T[]): T[] => [
      ...values.slice(offset % values.length),
      ...values.slice(0, offset % values.length),
    ];
    expect(
      createRecordsSnapshot({
        ...original,
        work: { ...original.work, artifactVersionIds: rotate(original.work.artifactVersionIds) },
        events: rotate(original.events),
        decisionMessages: rotate(original.decisionMessages),
        artifactVersions: rotate(original.artifactVersions),
      }).hash,
    ).toBe(expected);
  }

  const changed = bundle();
  expect(
    createRecordsSnapshot({
      ...changed,
      plan: { ...changed.plan, checksum: "f".repeat(64) },
    }).hash,
  ).not.toBe(expected);
});

it("verifying N+1과 passed Verification 결속을 강제한다", () => {
  const original = bundle();
  const input = { ...original, work: { ...original.work, status: "running" } };
  expect(() => createRecordsSnapshot(input)).toThrow("verifying");

  const staleOriginal = bundle();
  const stale = {
    ...staleOriginal,
    verification: { ...staleOriginal.verification, projectedWorkRevision: 8 },
  };
  expect(() => createRecordsSnapshot(stale)).toThrow("revision");

  const failedOriginal = bundle();
  const failed = { ...failedOriginal, verification: { ...failedOriginal.verification, passed: false } };
  expect(() => createRecordsSnapshot(failed)).toThrow("passed");
});

it("다른 tenant·Work 자료와 누락 Artifact를 거부한다", () => {
  const otherTenantOriginal = bundle();
  const otherTenant = {
    ...otherTenantOriginal,
    artifactVersions: otherTenantOriginal.artifactVersions.map((artifact, index) =>
      index === 0 ? { ...artifact, organizationId: "organization-2" } : artifact,
    ),
  };
  expect(() => createRecordsSnapshot(otherTenant)).toThrow("소유권");

  const missingOriginal = bundle();
  const missing = { ...missingOriginal, artifactVersions: missingOriginal.artifactVersions.slice(0, -1) };
  expect(() => createRecordsSnapshot(missing)).toThrow("ArtifactVersion");
});
