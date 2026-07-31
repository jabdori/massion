import { describe, expect, it } from "vitest";

import { DatabaseCoreAssuranceCheckOrchestrator } from "./assurance-check-orchestrator.js";

describe("DatabaseCoreAssuranceCheckOrchestrator", () => {
  it("다른 검사 결과를 요구하는 coverage 검사는 일반 검사가 끝난 뒤에 기록한다", async () => {
    const recorded: string[] = [];
    const orchestrator = new DatabaseCoreAssuranceCheckOrchestrator({
      runs: {
        listCriteria: async () => [
          { criterionId: "coverage", criterionKey: "profile:acceptance:coverage", status: "pending" },
          { criterionId: "deliverable", criterionKey: "deliverable-created", status: "pending" },
        ],
      },
      bindings: {
        get: async () => ({
          bindings: [
            {
              criterionKey: "profile:acceptance:coverage",
              bindingKey: "coverage",
              kind: "evidence",
              evidenceKinds: ["check-result"],
            },
            {
              criterionKey: "deliverable-created",
              bindingKey: "deliverable",
              kind: "evidence",
              evidenceKinds: ["artifact-version"],
            },
          ],
        }),
      },
      works: { recoverWork: async () => ({ work: { artifact_version_ids: ["artifact-version-1"] } }) },
      checks: {
        record: async (_context: unknown, value: { readonly bindingKey: string }) => {
          recorded.push(value.bindingKey);
          return {};
        },
      },
    } as never);

    await expect(
      orchestrator.execute({} as never, {
        commandId: "assurance-checks-command",
        run: { assuranceRunId: "assurance-run", bindingVersionId: "binding-version", workId: "work-1" } as never,
        request: {},
      }),
    ).resolves.toEqual({ outcome: "ready" });
    expect(recorded).toEqual(["deliverable", "coverage"]);
  });

  it("caller verdict 없이 criterion·binding·실제 Work evidence를 검사 원장에 연결한다", async () => {
    const recorded: unknown[] = [];
    const orchestrator = new DatabaseCoreAssuranceCheckOrchestrator({
      runs: {
        listCriteria: async () => [{ criterionId: "criterion-1", criterionKey: "criterion-key", status: "pending" }],
      },
      bindings: {
        get: async () => ({ bindings: [{ criterionKey: "criterion-key", bindingKey: "binding-key" }] }),
      },
      works: { recoverWork: async () => ({ work: { artifact_version_ids: ["artifact-version-1"] } }) },
      checks: {
        record: async (_context: unknown, input: unknown) => {
          recorded.push(input);
          return {};
        },
      },
    } as never);
    await expect(
      orchestrator.execute({} as never, {
        commandId: "assurance-checks-command",
        run: { assuranceRunId: "assurance-run", bindingVersionId: "binding-version", workId: "work-1" } as never,
        request: { assuranceEvidence: { evidenceBriefIds: ["brief-1"] } },
      }),
    ).resolves.toEqual({ outcome: "ready" });
    expect(recorded).toEqual([
      expect.objectContaining({
        criterionId: "criterion-1",
        bindingKey: "binding-key",
        artifactVersionIds: ["artifact-version-1"],
        evidenceBriefIds: ["brief-1"],
      }),
    ]);
    expect(JSON.stringify(recorded)).not.toContain("verdict");
  });

  it("소프트웨어 재검증에는 해당 code-change ArtifactVersion 하나만 전달한다", async () => {
    const recorded: unknown[] = [];
    const orchestrator = new DatabaseCoreAssuranceCheckOrchestrator({
      runs: {
        listCriteria: async () => [
          { criterionId: "software", criterionKey: "profile:software:correctness", status: "pending" },
          { criterionId: "other", criterionKey: "deliverable-created", status: "pending" },
        ],
      },
      bindings: {
        get: async () => ({
          bindings: [
            {
              criterionKey: "profile:software:correctness",
              bindingKey: "software-correctness",
              kind: "test",
              executor: { kind: "system_adapter", adapterId: "massion.software-command.v1" },
            },
            {
              criterionKey: "deliverable-created",
              bindingKey: "deliverable",
              kind: "evidence",
              evidenceKinds: ["artifact-version"],
            },
          ],
        }),
      },
      works: {
        recoverWork: async () => ({
          work: { artifact_version_ids: ["task-output-version", "code-change-version"] },
          artifacts: [
            { artifact_id: "task-output", kind: "task-output" },
            { artifact_id: "code-change", kind: "code-change" },
          ],
          artifactVersions: [
            { artifact_id: "task-output", artifact_version_id: "task-output-version" },
            { artifact_id: "code-change", artifact_version_id: "code-change-version" },
          ],
        }),
      },
      checks: {
        record: async (_context: unknown, input: unknown) => {
          recorded.push(input);
          return {};
        },
      },
    } as never);

    await expect(
      orchestrator.execute({} as never, {
        commandId: "assurance-checks-command",
        run: { assuranceRunId: "assurance-run", bindingVersionId: "binding-version", workId: "work-1" } as never,
        request: {},
      }),
    ).resolves.toEqual({ outcome: "ready" });
    expect(recorded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bindingKey: "software-correctness", artifactVersionIds: ["code-change-version"] }),
        expect.objectContaining({
          bindingKey: "deliverable",
          artifactVersionIds: [],
        }),
      ]),
    );
  });

  it("각 완료 기준에는 그 기준을 담당한 Task의 ArtifactVersion만 연결한다", async () => {
    const recorded: Array<{ readonly criterionId: string; readonly artifactVersionIds: readonly string[] }> = [];
    const plan = {
      objective: "두 산출물을 검증한다",
      summary: "각 Task 산출물을 개별 검증한다",
      scopeIn: [],
      scopeOut: [],
      assumptions: [],
      unknowns: [],
      acceptanceCriteria: [
        {
          key: "analysis-correct",
          statement: "분석이 정확하다",
          method: "evidence",
          evidenceKinds: ["artifact-version"],
          planLevel: false,
        },
        {
          key: "recommendation-written",
          statement: "권고안이 작성된다",
          method: "evidence",
          evidenceKinds: ["artifact-version"],
          planLevel: false,
        },
        {
          key: "plan-complete",
          statement: "계획 전체가 완료된다",
          method: "evidence",
          evidenceKinds: ["artifact-version"],
          planLevel: true,
        },
      ],
      risks: [],
      tasks: [
        {
          key: "analysis",
          title: "분석",
          objective: "분석한다",
          criterionKeys: ["analysis-correct"],
          dependencyKeys: [],
          requiredCapabilities: ["statistical-analysis"],
          recommendedAgentHandles: [],
          parallelizable: false,
        },
        {
          key: "recommendation",
          title: "권고",
          objective: "권고한다",
          criterionKeys: ["recommendation-written"],
          dependencyKeys: ["analysis"],
          requiredCapabilities: ["context-strategy"],
          recommendedAgentHandles: ["context-strategy"],
          parallelizable: false,
        },
      ],
      evidenceRequests: [],
    };
    const orchestrator = new DatabaseCoreAssuranceCheckOrchestrator({
      runs: {
        listCriteria: async () => [
          { criterionId: "criterion-analysis", criterionKey: "analysis-correct", status: "pending" },
          { criterionId: "criterion-plan", criterionKey: "plan-complete", status: "pending" },
          { criterionId: "criterion-recommendation", criterionKey: "recommendation-written", status: "pending" },
        ],
      },
      bindings: {
        get: async () => ({
          bindings: [
            {
              criterionKey: "analysis-correct",
              bindingKey: "analysis",
              kind: "evidence",
              evidenceKinds: ["artifact-version"],
            },
            {
              criterionKey: "plan-complete",
              bindingKey: "plan",
              kind: "evidence",
              evidenceKinds: ["artifact-version"],
            },
            {
              criterionKey: "recommendation-written",
              bindingKey: "recommendation",
              kind: "evidence",
              evidenceKinds: ["artifact-version"],
            },
          ],
        }),
      },
      works: {
        recoverWork: async () => ({
          work: {
            active_plan_version_id: "plan-1",
            artifact_version_ids: ["artifact-a", "artifact-b", "artifact-stale"],
          },
          plans: [{ plan_version_id: "plan-1", valid: true, content_json: JSON.stringify(plan) }],
          tasks: [
            { task_id: "task-a", task_key: "analysis", plan_version_id: "plan-1" },
            { task_id: "task-b", task_key: "recommendation", plan_version_id: "plan-1" },
            { task_id: "task-stale", task_key: "analysis", plan_version_id: "plan-stale" },
          ],
          messages: [
            { task_id: "task-a", artifact_version_id: "artifact-a" },
            { task_id: "task-b", artifact_version_id: "artifact-b" },
            { task_id: "task-stale", artifact_version_id: "artifact-stale" },
          ],
          artifacts: [],
          artifactVersions: [],
        }),
      },
      checks: {
        record: async (
          _context: unknown,
          value: { readonly criterionId: string; readonly artifactVersionIds: readonly string[] },
        ) => {
          recorded.push({ criterionId: value.criterionId, artifactVersionIds: value.artifactVersionIds });
          return {};
        },
      },
    } as never);

    await orchestrator.execute({} as never, {
      commandId: "assurance-checks-command",
      run: { assuranceRunId: "assurance-run", bindingVersionId: "binding-version", workId: "work-1" } as never,
      request: {},
    });

    expect(recorded).toEqual([
      { criterionId: "criterion-analysis", artifactVersionIds: ["artifact-a"] },
      { criterionId: "criterion-plan", artifactVersionIds: ["artifact-a", "artifact-b"] },
      { criterionId: "criterion-recommendation", artifactVersionIds: ["artifact-b"] },
    ]);
  });
});
