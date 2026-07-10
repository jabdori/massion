import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  EvidenceValidationError,
  verifyArtifactEvidence,
  verifyEvidenceBriefFreshness,
  type ArtifactEvidence,
  type EvidenceBriefEvidence,
} from "./evidence.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function evidenceBrief(change: Partial<EvidenceBriefEvidence> = {}): EvidenceBriefEvidence {
  const core = {
    workId: "work-1",
    repositoryId: "repository-1",
    repositoryRevisionId: "revision-2",
    indexVersionId: "index-3",
    configurationChecksum: "b".repeat(64),
    query: "release evidence",
    status: "ready" as const,
    references: [],
    claims: [],
  };
  return {
    evidenceBriefId: "brief-1",
    organizationId: "organization-1",
    ...core,
    referencesJson: "[]",
    claimsJson: "[]",
    checksum: sha256(canonicalJson(core)),
    createdAt: "2026-07-10T11:58:00.000Z",
    ...change,
  };
}

describe("Assurance evidence", () => {
  const now = "2026-07-10T12:00:00.000Z";

  it("같은 organization·Work의 허용된 ArtifactVersion content checksum을 검증한다", () => {
    const contentJson = '{"result":"pass"}';
    expect(
      verifyArtifactEvidence({
        organizationId: "organization-1",
        workId: "work-1",
        allowedArtifactVersionIds: ["artifact-version-1"],
        observedAt: now,
        maximumAgeMs: 60_000,
        artifact: {
          artifactVersionId: "artifact-version-1",
          organizationId: "organization-1",
          workId: "work-1",
          checksum: sha256(contentJson),
          contentJson,
          createdAt: "2026-07-10T11:59:30.000Z",
        },
      }),
    ).toEqual({ artifactVersionId: "artifact-version-1", checksum: sha256(contentJson) });
  });

  it.each([
    ["다른 organization", { organizationId: "organization-2" }, "organization"],
    ["다른 Work", { workId: "work-2" }, "Work"],
    ["허용되지 않은 ID", { artifactVersionId: "artifact-version-2" }, "허용"],
    ["checksum 변조", { checksum: "a".repeat(64) }, "checksum"],
    ["미래 생성", { createdAt: "2026-07-10T12:00:01.000Z" }, "미래"],
    ["오래된 증거", { createdAt: "2026-07-10T11:58:00.000Z" }, "freshness"],
  ])("ArtifactVersion %s를 거부한다", (_label, change, error) => {
    const contentJson = '{"result":"pass"}';
    expect(() =>
      verifyArtifactEvidence({
        organizationId: "organization-1",
        workId: "work-1",
        allowedArtifactVersionIds: ["artifact-version-1"],
        observedAt: now,
        maximumAgeMs: 60_000,
        artifact: {
          artifactVersionId: "artifact-version-1",
          organizationId: "organization-1",
          workId: "work-1",
          checksum: sha256(contentJson),
          contentJson,
          createdAt: "2026-07-10T11:59:30.000Z",
          ...(change as Partial<ArtifactEvidence>),
        },
      }),
    ).toThrow(error);
  });

  it("현재 RepositoryRevision·IndexVersion·configuration에 결속된 ready EvidenceBrief만 인정한다", () => {
    expect(
      verifyEvidenceBriefFreshness({
        organizationId: "organization-1",
        workId: "work-1",
        observedAt: now,
        maximumAgeMs: 300_000,
        current: {
          repositoryRevisionId: "revision-2",
          indexVersionId: "index-3",
          configurationChecksum: "b".repeat(64),
        },
        brief: evidenceBrief(),
      }),
    ).toEqual({ evidenceBriefId: "brief-1", checksum: evidenceBrief().checksum });
  });

  it.each([
    [{ status: "stale_warning" }, "ready"],
    [{ repositoryRevisionId: "revision-old" }, "revision"],
    [{ indexVersionId: "index-old" }, "index"],
    [{ configurationChecksum: "d".repeat(64) }, "configuration"],
    [{ createdAt: "2026-07-10T11:00:00.000Z" }, "freshness"],
  ])("stale EvidenceBrief를 거부한다: %s", (change, error) => {
    expect(() =>
      verifyEvidenceBriefFreshness({
        organizationId: "organization-1",
        workId: "work-1",
        observedAt: now,
        maximumAgeMs: 300_000,
        current: {
          repositoryRevisionId: "revision-2",
          indexVersionId: "index-3",
          configurationChecksum: "b".repeat(64),
        },
        brief: evidenceBrief(change as Partial<EvidenceBriefEvidence>),
      }),
    ).toThrow(error);
  });

  it("현재 configuration checksum 불일치는 integrity tamper가 아니라 stale로 분류한다", () => {
    expect(() =>
      verifyEvidenceBriefFreshness({
        organizationId: "organization-1",
        workId: "work-1",
        observedAt: now,
        maximumAgeMs: 300_000,
        current: {
          repositoryRevisionId: "revision-2",
          indexVersionId: "index-3",
          configurationChecksum: "c".repeat(64),
        },
        brief: evidenceBrief(),
      }),
    ).toThrow(expect.objectContaining({ name: EvidenceValidationError.name, reason: "stale" }));
  });

  it("EvidenceBrief query·references·claims content checksum 변조를 거부한다", () => {
    for (const brief of [
      evidenceBrief({ query: "tampered" }),
      evidenceBrief({ referencesJson: '[{"uri":"tampered"}]' }),
      evidenceBrief({ claimsJson: '[{"statement":"tampered"}]' }),
    ]) {
      expect(() =>
        verifyEvidenceBriefFreshness({
          organizationId: "organization-1",
          workId: "work-1",
          observedAt: now,
          maximumAgeMs: 300_000,
          current: {
            repositoryRevisionId: "revision-2",
            indexVersionId: "index-3",
            configurationChecksum: "b".repeat(64),
          },
          brief,
        }),
      ).toThrow("content checksum");
    }
  });
});
