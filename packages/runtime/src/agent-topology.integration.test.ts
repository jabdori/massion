import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { VoltAgent } from "@voltagent/core";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { OrganizationAgentTopology } from "./agent-topology.js";
import { VoltAgentTopologyRuntime } from "./voltagent-topology.js";

describe("Core Office → VoltAgent topology 통합", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let voltAgent: VoltAgent;
  let runtime: VoltAgentTopologyRuntime;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "owner@example.com", displayName: "Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    voltAgent = new VoltAgent({ agents: {} });
    await voltAgent.ready;
    runtime = new VoltAgentTopologyRuntime(voltAgent, "openai/test-model");
  });

  afterEach(async () => {
    for (const agent of runtime.list(`${context.organizationId}:`)) runtime.remove(agent.id);
    await voltAgent.shutdown();
    await database.close();
  });

  it("Core Office 8개와 Representative의 7개 subagent를 materialize한다", async () => {
    const organizations = await OrganizationService.create(database);
    const graph = await OrganizationGraphService.create(database, organizations);
    await graph.bootstrap(context);
    const topology = new OrganizationAgentTopology(
      context.organizationId,
      { listNodes: async () => await graph.listNodes(context) },
      runtime,
      async () => 0,
    );

    await topology.sync();

    const agents = runtime.list(`${context.organizationId}:`);
    const representative = agents.find((agent) => agent.handle === "representative");
    expect(agents).toHaveLength(8);
    expect(representative).toBeDefined();
    expect(runtime.childIds(representative?.id ?? "missing")).toHaveLength(7);
  });
});
