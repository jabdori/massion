import { describe, expect, it, vi } from "vitest";

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

  it("provider list가 credential과 fallback route를 함께 조회한다", async () => {
    const operations: string[] = [];
    const client = {
      status: async () => ({}),
      snapshot: async () => ({}),
      query: async (operation: string) => {
        operations.push(operation);
        return { operation };
      },
      command: async () => ({}),
      inspectArtifact: async () => ({}),
      installArtifact: async () => ({}),
      updateArtifact: async () => ({}),
    };
    await expect(executeCliInvocation(client, parseCliArguments(["provider", "list"]))).resolves.toMatchObject({
      credentials: { operation: "router.credentials" },
      routes: { operation: "router.routes" },
    });
    expect(operations).toEqual(["router.credentials", "router.routes"]);
  });

  it("공식 Integration 상태와 연결 변경을 같은 Application 경계로 호출한다", async () => {
    const calls: unknown[] = [];
    const client: CliApplicationClient = {
      status: async () => ({}),
      snapshot: async () => ({}),
      query: async (operation, payload) => {
        calls.push([operation, payload]);
        return {};
      },
      command: async (input) => {
        calls.push(input);
        return {};
      },
      inspectArtifact: async () => ({}),
      installArtifact: async () => ({}),
      updateArtifact: async () => ({}),
    };
    await executeCliInvocation(client, parseCliArguments(["integration", "list"]));
    await executeCliInvocation(client, parseCliArguments(["integration", "deliveries", "25"]));
    await executeCliInvocation(client, parseCliArguments(["integration", "channel-bind"]), {
      readJson: async () => ({
        installationId: "installation-12345678",
        externalResourceId: "massion/project",
        resourceKind: "repository",
        events: ["issues"],
      }),
    });
    expect(calls[0]).toEqual(["integration.list", {}]);
    expect(calls[1]).toEqual(["integration.deliveries", { limit: 25 }]);
    expect(calls[2]).toMatchObject({ operation: "integration.channel.bind" });
  });

  it("Marketplace 검색·설치·inventory를 Registry Application operation으로 전달한다", async () => {
    const calls: unknown[] = [];
    const client: CliApplicationClient = {
      status: async () => ({}),
      snapshot: async () => ({}),
      query: async (operation, payload) => {
        calls.push([operation, payload]);
        return {};
      },
      command: async (input) => {
        calls.push(input);
        return {};
      },
      inspectArtifact: async () => ({}),
      installArtifact: async () => ({}),
      updateArtifact: async () => ({}),
    };
    await executeCliInvocation(client, parseCliArguments(["ext", "search", "slack"]));
    await executeCliInvocation(client, parseCliArguments(["ext", "install", "version-12345678"]));
    await executeCliInvocation(client, parseCliArguments(["ext", "inventory"]));
    expect(calls[0]).toEqual(["registry.search", { query: "slack", limit: 20 }]);
    expect(calls[1]).toMatchObject({ operation: "registry.install", payload: { versionId: "version-12345678" } });
    expect(calls[2]).toEqual(["registry.inventory", {}]);
  });

  it("Registry publish는 artifact와 stdin trust metadata를 분리해 전달한다", async () => {
    const publishArtifact = vi.fn(async () => ({}));
    const client: CliApplicationClient = {
      status: async () => ({}),
      snapshot: async () => ({}),
      query: async () => ({}),
      command: async () => ({}),
      inspectArtifact: async () => ({}),
      installArtifact: async () => ({}),
      updateArtifact: async () => ({}),
      publishArtifact,
    };
    await executeCliInvocation(client, parseCliArguments(["ext", "publish", "extension.tgz"]), {
      readArtifact: async () => Buffer.from("artifact"),
      readJson: async () => ({ uploadGrant: "grant-reference", provenanceBundle: {} }),
    });
    expect(publishArtifact).toHaveBeenCalledWith(expect.any(String), Buffer.from("artifact"), {
      uploadGrant: "grant-reference",
      provenanceBundle: {},
    });
  });
});
