import { describe, expect, it } from "vitest";

import { DatabaseCoreAssuranceCheckOrchestrator } from "./assurance-check-orchestrator.js";

describe("DatabaseCoreAssuranceCheckOrchestrator", () => {
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
});
