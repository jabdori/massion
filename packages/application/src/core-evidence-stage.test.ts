import { describe, expect, it } from "vitest";

import { CoreEvidenceStage } from "./core-evidence-stage.js";

const context = {
  userId: "evidence-user",
  organizationId: "evidence-org",
  membershipId: "evidence-member",
  role: "owner" as const,
};
const input = {
  runId: "evidence-run-0001",
  workId: "evidence-work-0001",
  commandId: "evidence-run-0001:evidence",
  correlationId: "evidence-correlation-0001",
  request: {},
};
const checksum = "a".repeat(64);
const evidenceSource = {
  kind: "evidence",
  sourceId: "brief-active",
  revision: "index-active",
  contentHash: checksum,
  observedAt: "2026-07-25T00:00:00.000Z",
  classification: "internal",
  priority: 80,
  estimatedTokens: 0,
  mandatory: true,
  evidenceRef: {
    evidenceBriefId: "brief-active",
    repositoryId: "repository-active",
    repositoryRevisionId: "revision-active",
    indexVersionId: "index-active",
    briefChecksum: checksum,
    freshnessStatus: "fresh",
  },
} as const;
const materialized = {
  evidenceBriefId: "brief-active",
  indexVersionId: "index-active",
  briefChecksum: checksum,
  snippets: [
    {
      referenceId: "chunk-active",
      citation: "src/active.ts:1-2",
      relativePath: "src/active.ts",
      startLine: 1,
      endLine: 2,
      content: "export const active = true;",
      estimatedTokens: 8,
    },
  ],
  estimatedTokens: 8,
  truncated: false,
} as const;
const automaticReady = {
  ...evidenceSource.evidenceRef,
  evidenceBriefId: evidenceSource.sourceId,
  workId: input.workId,
  status: "ready",
  checksum,
} as const;

describe("CoreEvidenceStage", () => {
  it("active Context의 metadata source와 같은 Work materialized evidence만 통과시킨다", async () => {
    const briefReads: string[] = [];
    const materializeInputs: unknown[] = [];
    const stage = new CoreEvidenceStage({
      works: {
        getActivePlan: async () => ({ content_json: "{}" }),
        getWork: async () => ({ workspace_id: "workspace-active", context_version_id: "context-active" }),
      },
      contexts: { get: async () => ({ workId: input.workId, selectedSources: [evidenceSource] }) as never },
      briefs: {
        getBrief: async (_context: unknown, evidenceBriefId: string) => {
          briefReads.push(evidenceBriefId);
          return {
            ...evidenceSource.evidenceRef,
            workId: input.workId,
            status: "ready",
            checksum,
          } as never;
        },
        findAutomaticByWork: async () => automaticReady as never,
      },
      materializer: {
        materialize: async (_context: unknown, materializeInput: unknown) => {
          materializeInputs.push(materializeInput);
          return materialized;
        },
      },
    } as never);

    await expect(
      stage.execute(context, { ...input, request: { evidenceBriefIds: ["brief-request-only"] } }),
    ).resolves.toMatchObject({ outcome: "advanced", data: { evidenceBriefIds: ["brief-active"] } });
    expect(briefReads).toEqual(["brief-active"]);
    expect(materializeInputs).toEqual([
      { workId: input.workId, evidenceBriefId: "brief-active", maxEstimatedTokens: 24_000 },
    ]);
  });

  it("active Context에 ready EvidenceBrief가 둘이면 materialize 전에 차단한다", async () => {
    let materializeCalls = 0;
    const duplicate = {
      ...evidenceSource,
      sourceId: "brief-duplicate",
      revision: "index-duplicate",
      contentHash: "b".repeat(64),
      evidenceRef: {
        ...evidenceSource.evidenceRef,
        evidenceBriefId: "brief-duplicate",
        indexVersionId: "index-duplicate",
        briefChecksum: "b".repeat(64),
      },
    };
    const stage = new CoreEvidenceStage({
      works: {
        getActivePlan: async () => ({ content_json: "{}" }),
        getWork: async () => ({ workspace_id: "workspace-active", context_version_id: "context-active" }),
      },
      contexts: {
        get: async () => ({ workId: input.workId, selectedSources: [evidenceSource, duplicate] }) as never,
      },
      briefs: { getBrief: async () => ({}) as never, findAutomaticByWork: async () => undefined },
      materializer: {
        materialize: async () => {
          materializeCalls += 1;
          return materialized;
        },
      },
    } as never);

    await expect(stage.execute(context, input)).resolves.toEqual({ outcome: "blocked", reason: "evidence-invalid" });
    expect(materializeCalls).toBe(0);
  });

  it("request에만 있는 임의 EvidenceBrief ID는 active Context를 우회하지 못한다", async () => {
    let briefReads = 0;
    const stage = new CoreEvidenceStage({
      works: {
        getActivePlan: async () => ({ content_json: "{}" }),
        getWork: async () => ({ workspace_id: "workspace-active" }),
      },
      briefs: {
        getBrief: async () => {
          briefReads += 1;
          return {} as never;
        },
        findAutomaticByWork: async () => undefined,
      },
    } as never);

    await expect(
      stage.execute(context, { ...input, request: { evidenceBriefIds: ["brief-request-only"] } }),
    ).resolves.toEqual({ outcome: "blocked", reason: "evidence-invalid" });
    expect(briefReads).toBe(0);
  });

  it("active Context와 materialized evidence checksum이 다르면 차단한다", async () => {
    const stage = new CoreEvidenceStage({
      works: {
        getActivePlan: async () => ({ content_json: "{}" }),
        getWork: async () => ({ workspace_id: "workspace-active", context_version_id: "context-active" }),
      },
      contexts: { get: async () => ({ workId: input.workId, selectedSources: [evidenceSource] }) as never },
      briefs: {
        getBrief: async () =>
          ({
            ...evidenceSource.evidenceRef,
            workId: input.workId,
            status: "ready",
            checksum,
          }) as never,
        findAutomaticByWork: async () => automaticReady as never,
      },
      materializer: { materialize: async () => ({ ...materialized, briefChecksum: "b".repeat(64) }) },
    } as never);

    await expect(stage.execute(context, input)).resolves.toEqual({ outcome: "blocked", reason: "evidence-invalid" });
  });

  it.each([
    { name: "누락", automatic: undefined },
    {
      name: "revision 불일치",
      automatic: { ...automaticReady, repositoryRevisionId: "revision-other" },
    },
  ])("automatic ready EvidenceBrief가 $name 상태면 manual active source로 우회하지 못한다", async ({ automatic }) => {
    let materializeCalls = 0;
    const stage = new CoreEvidenceStage({
      works: {
        getActivePlan: async () => ({ content_json: "{}" }),
        getWork: async () => ({ workspace_id: "workspace-active", context_version_id: "context-active" }),
      },
      contexts: { get: async () => ({ workId: input.workId, selectedSources: [evidenceSource] }) as never },
      briefs: {
        getBrief: async () => automaticReady as never,
        findAutomaticByWork: async () => automatic as never,
      },
      materializer: {
        materialize: async () => {
          materializeCalls += 1;
          return materialized;
        },
      },
    } as never);

    await expect(stage.execute(context, input)).resolves.toEqual({ outcome: "blocked", reason: "evidence-invalid" });
    expect(materializeCalls).toBe(0);
  });

  it.each([
    {
      name: "Workspace 없는 Work",
      work: { context_version_id: "context-unused" },
      contextVersion: undefined,
      receipt: undefined,
    },
    {
      name: "Workspace Work의 automatic no_match receipt",
      work: { workspace_id: "workspace-no-match", context_version_id: "context-no-match" },
      contextVersion: { workId: input.workId, selectedSources: [] },
      receipt: { evidenceBriefId: "brief-no-match", workId: input.workId, status: "no_match", checksum },
    },
  ])("$name은 knowledge source 없이 진행한다", async ({ work, contextVersion, receipt }) => {
    const stage = new CoreEvidenceStage({
      works: { getActivePlan: async () => ({ content_json: "{}" }), getWork: async () => work },
      contexts: {
        get: async () => {
          if (!contextVersion) throw new Error("Workspace 없는 Work는 Context를 읽으면 안 됩니다");
          return contextVersion as never;
        },
      },
      briefs: {
        getBrief: async () => {
          throw new Error("Evidence source가 없으면 Brief를 직접 읽으면 안 됩니다");
        },
        findAutomaticByWork: async () => receipt as never,
      },
      materializer: {
        materialize: async () => {
          throw new Error("Evidence source가 없으면 materialize하면 안 됩니다");
        },
        verifyNoMatch: async () => {
          if (!receipt) throw new Error("Workspace 없는 Work는 no-match를 검증하면 안 됩니다");
          return receipt as never;
        },
      },
    } as never);

    await expect(stage.execute(context, input)).resolves.toMatchObject({
      outcome: "advanced",
      data: { evidenceBriefIds: [] },
    });
  });

  it("automatic no_match receipt의 Evidence 계층 검증이 없거나 실패하면 차단한다", async () => {
    const dependencies = {
      works: {
        getActivePlan: async () => ({ content_json: "{}" }),
        getWork: async () => ({ workspace_id: "workspace-no-match", context_version_id: "context-no-match" }),
      },
      contexts: { get: async () => ({ workId: input.workId, selectedSources: [] }) as never },
      briefs: {
        getBrief: async () => {
          throw new Error("ready Brief가 아닙니다");
        },
        findAutomaticByWork: async () =>
          ({ evidenceBriefId: "brief-no-match", workId: input.workId, status: "no_match", checksum }) as never,
      },
    };
    await expect(new CoreEvidenceStage(dependencies as never).execute(context, input)).resolves.toEqual({
      outcome: "blocked",
      reason: "evidence-invalid",
    });
    await expect(
      new CoreEvidenceStage({
        ...dependencies,
        materializer: {
          materialize: async () => materialized,
          verifyNoMatch: async () => {
            throw new Error("손상된 no-match receipt");
          },
        },
      } as never).execute(context, input),
    ).resolves.toEqual({ outcome: "blocked", reason: "evidence-invalid" });
  });
});
