import { describe, expect, it } from "vitest";

import { executeCliInvocation, type CliApplicationClient } from "./commands.js";
import { parseCliArguments } from "./parser.js";

describe("CLI Application adapter", () => {
  it("조회와 mutation을 ApplicationClient 경계만으로 호출한다", async () => {
    const calls: unknown[] = [];
    const client: CliApplicationClient = {
      status: async () => ({ ok: true }),
      snapshot: async () => ({ graph: true }),
      query: async (operation, payload) => {
        calls.push([operation, payload]);
        return { operation };
      },
      command: async (input) => {
        calls.push(input);
        return { outcome: "succeeded" };
      },
      inspectArtifact: async () => ({}),
      installArtifact: async () => ({}),
      updateArtifact: async () => ({}),
    };
    await executeCliInvocation(client, parseCliArguments(["work", "list"]));
    await executeCliInvocation(client, parseCliArguments(["approval", "approve", "approval-1", "동의"]));
    expect(calls[0]).toEqual(["work.list", {}]);
    expect(calls[1]).toMatchObject({
      operation: "approval.vote",
      payload: { approvalId: "approval-1", vote: "approve", reason: "동의" },
    });
  });

  it("credential·route·조직 변경은 argv가 아닌 stdin JSON을 사용한다", async () => {
    let command: unknown;
    const client: CliApplicationClient = {
      status: async () => ({}),
      snapshot: async () => ({}),
      query: async () => ({}),
      command: async (input) => {
        command = input;
        return {};
      },
      inspectArtifact: async () => ({}),
      installArtifact: async () => ({}),
      updateArtifact: async () => ({}),
    };
    await executeCliInvocation(client, parseCliArguments(["provider", "credential-add"]), {
      readJson: async () => ({ providerId: "openai", secret: "reference-only" }),
    });
    expect(command).toMatchObject({ operation: "router.credential.add", payload: { providerId: "openai" } });
  });
});
