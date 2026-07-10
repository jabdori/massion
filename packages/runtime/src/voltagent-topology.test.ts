import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentRegistry, VoltAgent } from "@voltagent/core";

import type { MaterializedAgent } from "./agent-topology.js";
import { VoltAgentTopologyRuntime } from "./voltagent-topology.js";

describe("VoltAgent 2.9 topology adapter", () => {
  let voltAgent: VoltAgent;
  let runtime: VoltAgentTopologyRuntime;
  const createdIds = ["organization-a:parent", "organization-a:child"];

  beforeEach(async () => {
    voltAgent = new VoltAgent({ agents: {} });
    await voltAgent.ready;
    runtime = new VoltAgentTopologyRuntime(voltAgent, "openai/test-model");
  });

  afterEach(async () => {
    for (const id of createdIds) AgentRegistry.getInstance().removeAgent(id);
    await voltAgent.shutdown();
  });

  function agent(id: string, handle: string): MaterializedAgent {
    return {
      id,
      name: `organization-a:${handle}`,
      handle,
      instructions: `${handle} instructions`,
      role: handle === "parent" ? "orchestrator" : "operator",
    };
  }

  it("Agent 등록·subagent 연결·delegate_task 자동 생성과 제거를 실제 artifact에서 검증한다", () => {
    runtime.create(agent("organization-a:parent", "parent"));
    runtime.create(agent("organization-a:child", "child"));
    runtime.connect("organization-a:parent", "organization-a:child");

    expect(runtime.childIds("organization-a:parent")).toEqual(["organization-a:child"]);
    expect(
      voltAgent
        .getAgent("organization-a:parent")
        ?.getTools()
        .map((tool) => tool.name),
    ).toContain("delegate_task");

    runtime.disconnect("organization-a:parent", "organization-a:child");
    expect(runtime.childIds("organization-a:parent")).toEqual([]);
    expect(
      voltAgent
        .getAgent("organization-a:parent")
        ?.getTools()
        .map((tool) => tool.name),
    ).not.toContain("delegate_task");
  });

  it("중복 ID·name을 덮어쓰지 않고 관계를 정리한 뒤 registry에서 제거한다", () => {
    runtime.create(agent("organization-a:parent", "parent"));
    runtime.create(agent("organization-a:child", "child"));
    runtime.connect("organization-a:parent", "organization-a:child");
    expect(() => runtime.create(agent("organization-a:parent", "other"))).toThrow("충돌");

    runtime.remove("organization-a:child");
    expect(voltAgent.getAgent("organization-a:child")).toBeUndefined();
    expect(runtime.childIds("organization-a:parent")).toEqual([]);
  });
});
