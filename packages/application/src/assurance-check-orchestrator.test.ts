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
          artifactVersionIds: ["task-output-version", "code-change-version"],
        }),
      ]),
    );
  });
});
