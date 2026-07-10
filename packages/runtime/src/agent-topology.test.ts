import { describe, expect, it } from "vitest";

import type { OrganizationNode } from "@massion/organization";

import {
  OrganizationAgentTopology,
  type AgentTopologyRuntime,
  type MaterializedAgent,
  type OrganizationNodeSource,
} from "./agent-topology.js";

class MutableNodeSource implements OrganizationNodeSource {
  public constructor(public nodes: OrganizationNode[]) {}
  public async listNodes(): Promise<OrganizationNode[]> {
    return this.nodes;
  }
}

class FakeTopologyRuntime implements AgentTopologyRuntime {
  public readonly agents = new Map<string, MaterializedAgent>();
  public readonly children = new Map<string, Set<string>>();

  public list(prefix: string): MaterializedAgent[] {
    return [...this.agents.values()].filter((agent) => agent.id.startsWith(prefix));
  }
  public get(id: string): MaterializedAgent | undefined {
    return this.agents.get(id);
  }
  public create(agent: MaterializedAgent): void {
    if (this.agents.has(agent.id) || [...this.agents.values()].some((item) => item.name === agent.name))
      throw new Error("Agent 충돌");
    this.agents.set(agent.id, agent);
    this.children.set(agent.id, new Set());
  }
  public remove(id: string): void {
    this.agents.delete(id);
    this.children.delete(id);
    for (const children of this.children.values()) children.delete(id);
  }
  public connect(parentId: string, childId: string): void {
    this.children.get(parentId)?.add(childId);
  }
  public disconnect(parentId: string, childId: string): void {
    this.children.get(parentId)?.delete(childId);
  }
  public childIds(parentId: string): string[] {
    return [...(this.children.get(parentId) ?? [])];
  }
}

function node(handle: string, parentHandle?: string, status: OrganizationNode["status"] = "active"): OrganizationNode {
  return {
    node_id: `node-${handle}`,
    organization_id: "organization-a",
    handle,
    name: handle,
    responsibility: `${handle} responsibility`,
    outputs: [],
    ...(parentHandle ? { parent_handle: parentHandle } : {}),
    scope: "persistent",
    builtin: false,
    status,
    role: parentHandle ? "operator" : "orchestrator",
    created_at: new Date(),
  };
}

describe("Organization Agent topology", () => {
  it("활성 node를 tenant namespace Agent와 단일 부모 topology로 멱등 동기화한다", async () => {
    const source = new MutableNodeSource([
      node("representative"),
      node("research", "representative"),
      node("inactive", undefined, "inactive"),
    ]);
    const runtime = new FakeTopologyRuntime();
    const topology = new OrganizationAgentTopology("organization-a", source, runtime, async () => 0);

    await topology.sync();
    await topology.sync();

    expect(
      runtime
        .list("organization-a:")
        .map((agent) => agent.name)
        .sort(),
    ).toEqual(["organization-a:representative", "organization-a:research"]);
    expect(runtime.childIds("organization-a:node-representative")).toEqual(["organization-a:node-research"]);
  });

  it("parent 이동은 이전 관계를 제거하고 새 관계를 연결한다", async () => {
    const source = new MutableNodeSource([
      node("root"),
      node("team-a", "root"),
      node("team-b", "root"),
      node("worker", "team-a"),
    ]);
    const runtime = new FakeTopologyRuntime();
    const topology = new OrganizationAgentTopology("organization-a", source, runtime, async () => 0);
    await topology.sync();
    source.nodes = source.nodes.map((item) => (item.handle === "worker" ? node("worker", "team-b") : item));

    await topology.sync();

    expect(runtime.childIds("organization-a:node-team-a")).not.toContain("organization-a:node-worker");
    expect(runtime.childIds("organization-a:node-team-b")).toContain("organization-a:node-worker");
  });

  it("비활성화된 Agent는 active execution이 있으면 제거를 거부하고 drain 후 제거한다", async () => {
    const source = new MutableNodeSource([node("root"), node("worker", "root")]);
    const runtime = new FakeTopologyRuntime();
    let active = 1;
    const topology = new OrganizationAgentTopology("organization-a", source, runtime, async () => active);
    await topology.sync();
    source.nodes = [node("root"), node("worker", "root", "inactive")];

    await expect(topology.sync()).rejects.toThrow("활성 Runtime Execution");
    expect(runtime.get("organization-a:node-worker")).toBeDefined();
    active = 0;
    await topology.sync();
    expect(runtime.get("organization-a:node-worker")).toBeUndefined();
  });

  it("orphan·cycle·중복 handle을 materialize 전에 거부한다", async () => {
    const runtime = new FakeTopologyRuntime();
    await expect(
      new OrganizationAgentTopology(
        "organization-a",
        new MutableNodeSource([node("worker", "missing")]),
        runtime,
        async () => 0,
      ).sync(),
    ).rejects.toThrow("부모");
    await expect(
      new OrganizationAgentTopology(
        "organization-a",
        new MutableNodeSource([node("a", "b"), node("b", "a")]),
        runtime,
        async () => 0,
      ).sync(),
    ).rejects.toThrow("순환");
  });
});
