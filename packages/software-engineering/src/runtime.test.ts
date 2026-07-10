import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@massion/identity";
import type { StructuredAgentRunner } from "@massion/runtime";

import { SoftwarePatchProposalService } from "./runtime.js";

describe("AgentRunner patch proposal 경계", () => {
  const context = { organizationId: "organization-1", userId: "user-1", role: "owner" } as TenantContext;

  it("Structured AgentRunner에는 proposal만 요청하고 filesystem side effect를 노출하지 않는다", async () => {
    const proposal = {
      testPatch: "diff --git a/test.ts b/test.ts\n",
      implementationPatch: "diff --git a/src.ts b/src.ts\n",
      focusedCommand: {
        executable: "node",
        args: ["test.ts"],
        cwd: ".",
        timeoutMs: 1_000,
        maxOutputBytes: 2_048,
        environment: {},
      },
      redFailureMarker: "EXPECTED_FAILURE",
      validationCommands: [],
      commitMessage: "feat: proposal",
    };
    const executeStructured = vi.fn().mockResolvedValue({
      executionId: "execution-1",
      status: "succeeded",
      output: proposal,
    });
    const runner = { executeStructured } as unknown as StructuredAgentRunner;
    const service = new SoftwarePatchProposalService(runner);
    await expect(
      service.propose(context, {
        commandId: "proposal-1",
        workId: "work-1",
        taskId: "task-1",
        agentHandle: "software-engineering.backend-specialist",
        modelRoute: "coding-balanced",
        correlationId: "delivery-1",
        estimatedTokens: 4_000,
        estimatedCostMicros: 10_000,
        objective: "테스트 우선 변경",
        acceptanceCriteria: ["GREEN"],
        evidenceBriefIds: ["brief-1"],
        allowedPaths: ["src", "test.ts"],
      }),
    ).resolves.toEqual(proposal);
    expect(executeStructured).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ input: expect.not.objectContaining({ workspacePath: expect.anything() }) }),
      expect.objectContaining({ name: "software_patch_proposal" }),
    );
    const source = await readFile(new URL("./runtime.ts", import.meta.url), "utf8");
    expect(source).not.toContain("@voltagent/");
  });

  it("실패 execution과 구조가 잘못된 proposal을 거부한다", async () => {
    const runner = {
      executeStructured: vi
        .fn()
        .mockResolvedValueOnce({ executionId: "failed", status: "failed", error: { category: "model" } })
        .mockResolvedValueOnce({ executionId: "invalid", status: "succeeded", output: { testPatch: 1 } }),
    } as unknown as StructuredAgentRunner;
    const service = new SoftwarePatchProposalService(runner);
    const request = {
      commandId: "proposal-1",
      workId: "work-1",
      taskId: "task-1",
      agentHandle: "software-engineering.backend-specialist",
      modelRoute: "coding-balanced",
      correlationId: "delivery-1",
      estimatedTokens: 4_000,
      estimatedCostMicros: 10_000,
      objective: "변경",
      acceptanceCriteria: ["GREEN"],
      evidenceBriefIds: [],
      allowedPaths: ["src"],
    };
    await expect(service.propose(context, request)).rejects.toThrow("proposal execution");
    await expect(service.propose(context, request)).rejects.toThrow("proposal 구조");
  });
});
