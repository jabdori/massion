import { Agent, AgentRegistry, VoltAgent, type AgentModelValue, type SubAgentConfig } from "@voltagent/core";

import type { AgentTopologyRuntime, MaterializedAgent } from "./agent-topology.js";

function subAgentId(config: SubAgentConfig): string {
  return config instanceof Agent ? config.id : config.agent.id;
}

export class VoltAgentTopologyRuntime implements AgentTopologyRuntime {
  private readonly metadata = new Map<string, MaterializedAgent>();

  public constructor(
    private readonly voltAgent: VoltAgent,
    private readonly defaultModel: AgentModelValue,
  ) {}

  public list(prefix: string): MaterializedAgent[] {
    return this.voltAgent
      .getAgents()
      .filter((agent) => agent.id.startsWith(prefix))
      .map((agent) => this.metadata.get(agent.id) ?? this.fromAgent(agent));
  }

  public get(id: string): MaterializedAgent | undefined {
    const agent = this.voltAgent.getAgent(id);
    return agent ? (this.metadata.get(id) ?? this.fromAgent(agent)) : undefined;
  }

  public create(agent: MaterializedAgent): void {
    if (
      this.voltAgent.getAgent(agent.id) ||
      this.voltAgent.getAgents().some((existing) => existing.name === agent.name)
    ) {
      throw new Error(`VoltAgent ID 또는 name 충돌: ${agent.id}`);
    }
    const instance = new Agent({
      id: agent.id,
      name: agent.name,
      purpose: agent.handle,
      instructions: agent.instructions,
      model: this.defaultModel,
      maxRetries: 0,
    });
    this.voltAgent.registerAgent(instance);
    this.metadata.set(agent.id, agent);
  }

  public remove(id: string): void {
    const target = this.requireAgent(id);
    for (const parent of this.voltAgent.getAgents()) {
      if (parent.getSubAgents().some((child) => subAgentId(child) === id)) parent.removeSubAgent(id);
    }
    for (const child of target.getSubAgents()) target.removeSubAgent(subAgentId(child));
    AgentRegistry.getInstance().removeAgent(id);
    this.metadata.delete(id);
  }

  public connect(parentId: string, childId: string): void {
    const parent = this.requireAgent(parentId);
    const child = this.requireAgent(childId);
    if (!parent.getSubAgents().some((config) => subAgentId(config) === childId)) parent.addSubAgent(child);
  }

  public disconnect(parentId: string, childId: string): void {
    const parent = this.requireAgent(parentId);
    if (parent.getSubAgents().some((config) => subAgentId(config) === childId)) parent.removeSubAgent(childId);
  }

  public childIds(parentId: string): string[] {
    return this.requireAgent(parentId).getSubAgents().map(subAgentId);
  }

  private requireAgent(id: string): Agent {
    const agent = this.voltAgent.getAgent(id);
    if (!agent) throw new Error(`VoltAgent Agent를 찾을 수 없습니다: ${id}`);
    return agent;
  }

  private fromAgent(agent: Agent): MaterializedAgent {
    const separator = agent.name.indexOf(":");
    const handle = separator >= 0 ? agent.name.slice(separator + 1) : agent.name;
    return {
      id: agent.id,
      name: agent.name,
      handle,
      instructions: typeof agent.instructions === "string" ? agent.instructions : handle,
      role: "operator",
    };
  }
}
