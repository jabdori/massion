import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { CORE_OFFICE_HANDLES, OrganizationGraphService } from "@massion/organization";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import {
  SOFTWARE_ENGINEERING_TEAM_PROFILE,
  installSoftwareEngineeringTeam,
  selectEngineeringAgent,
} from "./team-profile.js";

describe("기본 Software Engineering 전문 팀", () => {
  let database: MassionDatabase;
  let context: TenantContext;
  let graph: OrganizationGraphService;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "team@example.com", displayName: "Team Owner" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    graph = await OrganizationGraphService.create(database, organizations);
    await graph.bootstrap(context);
  });

  afterEach(async () => database.close());

  it("9개 stable handle·capability·책임·산출물 profile을 고정한다", () => {
    expect(SOFTWARE_ENGINEERING_TEAM_PROFILE).toMatchObject({
      profileId: "massion.software-engineering",
      profileVersion: "1.0.0",
    });
    expect(
      SOFTWARE_ENGINEERING_TEAM_PROFILE.nodes.map((node) => ({
        handle: node.handle,
        capabilities: node.capabilities,
        parentHandle: node.parentHandle,
        role: node.role,
      })),
    ).toEqual([
      {
        handle: "software-engineering",
        capabilities: ["software-delivery"],
        parentHandle: "delivery-coordination",
        role: "coordinator",
      },
      {
        handle: "software-engineering.engineering-lead",
        capabilities: ["engineering-lead"],
        parentHandle: "software-engineering",
        role: "coordinator",
      },
      {
        handle: "software-engineering.frontend-specialist",
        capabilities: ["frontend-engineering"],
        parentHandle: "software-engineering",
        role: "operator",
      },
      {
        handle: "software-engineering.backend-specialist",
        capabilities: ["backend-engineering"],
        parentHandle: "software-engineering",
        role: "operator",
      },
      {
        handle: "software-engineering.database-specialist",
        capabilities: ["database-engineering"],
        parentHandle: "software-engineering",
        role: "operator",
      },
      {
        handle: "software-engineering.infrastructure-specialist",
        capabilities: ["infrastructure-engineering"],
        parentHandle: "software-engineering",
        role: "operator",
      },
      {
        handle: "software-engineering.test-engineer",
        capabilities: ["test-engineering"],
        parentHandle: "software-engineering",
        role: "operator",
      },
      {
        handle: "software-engineering.security-reviewer",
        capabilities: ["secure-coding-review"],
        parentHandle: "software-engineering",
        role: "operator",
      },
      {
        handle: "software-engineering.release-engineer",
        capabilities: ["release-engineering"],
        parentHandle: "software-engineering",
        role: "operator",
      },
    ]);
    for (const node of SOFTWARE_ENGINEERING_TEAM_PROFILE.nodes) {
      expect(node.name.trim()).not.toBe("");
      expect(node.responsibility.trim()).not.toBe("");
      expect(node.outputs.length).toBeGreaterThan(0);
    }
  });

  it("한 OrganizationVersion에서 profile 전체를 원자·멱등 설치한다", async () => {
    const commandId = crypto.randomUUID();
    const first = await installSoftwareEngineeringTeam(graph, context, { commandId, expectedVersion: 1 });
    const repeated = await installSoftwareEngineeringTeam(graph, context, { commandId, expectedVersion: 1 });

    expect(first.version).toMatchObject({ version: 2, previous_version: 1, command_kind: "install-profile" });
    expect(repeated.version.version_id).toBe(first.version.version_id);
    expect(first.impact.nodeHandles).toEqual(SOFTWARE_ENGINEERING_TEAM_PROFILE.nodes.map((node) => node.handle).sort());
    const core = first.nodes.filter((node) => (CORE_OFFICE_HANDLES as readonly string[]).includes(node.handle));
    const installed = first.nodes.filter((node) => node.handle.startsWith("software-engineering"));
    expect(core).toHaveLength(8);
    expect(core.every((node) => node.builtin && node.status === "active")).toBe(true);
    expect(installed).toHaveLength(9);
    expect(installed.every((node) => !node.builtin && node.scope === "persistent" && node.status === "active")).toBe(
      true,
    );
  });

  it("handle 하나라도 충돌하면 일부 profile 노드를 남기지 않는다", async () => {
    await graph.execute(context, {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      kind: "create",
      handle: "software-engineering",
      name: "Conflicting Team",
      responsibility: "충돌 검증",
      parentHandle: "delivery-coordination",
      scope: "persistent",
    });

    await expect(
      installSoftwareEngineeringTeam(graph, context, { commandId: crypto.randomUUID(), expectedVersion: 2 }),
    ).rejects.toThrow("이미 존재하는 handle");
    const nodes = await graph.listNodes(context);
    expect(nodes).toHaveLength(9);
    expect(nodes.filter((node) => node.handle.startsWith("software-engineering"))).toHaveLength(1);
  });

  it("추천 handle 또는 capability가 정확히 한 active Agent를 가리킬 때만 선택한다", async () => {
    const installed = await installSoftwareEngineeringTeam(graph, context, {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
    });
    expect(
      selectEngineeringAgent(installed.nodes, {
        requiredCapabilities: ["backend-engineering"],
        recommendedAgentHandles: ["software-engineering.backend-specialist"],
      }),
    ).toEqual({ outcome: "selected", agentHandle: "software-engineering.backend-specialist" });
    expect(
      selectEngineeringAgent(installed.nodes, {
        requiredCapabilities: ["missing-capability"],
        recommendedAgentHandles: [],
      }),
    ).toEqual({ outcome: "staffing_gap", reason: "no_exact_candidate" });
    expect(
      selectEngineeringAgent(installed.nodes, {
        requiredCapabilities: ["backend-engineering"],
        recommendedAgentHandles: ["software-engineering.frontend-specialist"],
      }),
    ).toEqual({ outcome: "staffing_gap", reason: "no_exact_candidate" });

    const duplicateCapability = installed.nodes.map((node) =>
      node.handle === "software-engineering.frontend-specialist"
        ? { ...node, capabilities: ["backend-engineering"] }
        : node,
    );
    expect(
      selectEngineeringAgent(duplicateCapability, {
        requiredCapabilities: ["backend-engineering"],
        recommendedAgentHandles: [],
      }),
    ).toEqual({ outcome: "staffing_gap", reason: "ambiguous_exact_candidates" });
  });
});
