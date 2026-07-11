import { describe, expect, it } from "vitest";

import type { TenantContext } from "@massion/identity";

import {
  AgentInstructionRegistry,
  MASSION_RUNTIME_EXECUTION_CONTEXT_KEY,
  MASSION_TENANT_CONTEXT_KEY,
  type AgentConfigurationReader,
} from "./agent-configuration.js";
import { RUNTIME_PROMPT_LINEAGE_MIGRATION } from "./schema.js";

describe("Runtime AgentConfiguration consumer port", () => {
  const tenant: TenantContext = {
    userId: "user-1",
    organizationId: "organization-1",
    membershipId: "membership-1",
    role: "owner",
  };

  it("0054 Runtime Prompt 계보 migration checksum을 고정한다", () => {
    expect(RUNTIME_PROMPT_LINEAGE_MIGRATION.id).toBe("0054-runtime-prompt-lineage");
    expect(RUNTIME_PROMPT_LINEAGE_MIGRATION.checksum).toBe(
      "70d223ba2c60392616a8b08254dcee2b9528f3e98aec75e1c7e926b3068cffe0",
    );
  });

  it("execution ID와 Agent handle로 고정된 instruction을 읽는다", async () => {
    const calls: Array<{ executionId: string; agentHandle: string }> = [];
    const reader: AgentConfigurationReader = {
      resolve: async (_context, input) => {
        calls.push(input);
        return {
          promptVersionId: "prompt-version-1",
          promptChecksum: "a".repeat(64),
          memoryVersionIds: ["memory-version-1"],
          instruction: "항상 설정 파일 변경을 검사한다",
          instructionChecksum: "b".repeat(64),
        };
      },
    };
    const registry = new AgentInstructionRegistry(reader);
    const instructions = registry.instructions("assurance", "기본 지시문");

    await expect(
      instructions({
        context: new Map([
          [MASSION_RUNTIME_EXECUTION_CONTEXT_KEY, "execution-1"],
          [MASSION_TENANT_CONTEXT_KEY, tenant],
        ]),
      } as never),
    ).resolves.toBe("항상 설정 파일 변경을 검사한다");
    expect(calls).toEqual([{ executionId: "execution-1", agentHandle: "assurance" }]);
  });

  it("실행 문맥이 없으면 정적 기본 지시문으로 조용히 실행하지 않는다", async () => {
    const reader: AgentConfigurationReader = {
      resolve: async () => {
        throw new Error("호출되면 안 됩니다");
      },
    };
    const instructions = new AgentInstructionRegistry(reader).instructions("assurance", "기본 지시문");

    await expect(instructions({ context: new Map() } as never)).rejects.toThrow("execution ID");
  });
});
