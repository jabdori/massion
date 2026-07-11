import type { ExtensionPermissionDeclaration } from "@massion/extension-sdk";
import type { TenantContext } from "@massion/identity";
import type { GovernedActionInput, GovernanceAuthorization } from "@massion/governance";
import { describe, expect, it } from "vitest";

import {
  ExtensionGovernanceAdapter,
  compareExtensionPermissions,
  type ExtensionGovernanceGate,
} from "./governance-adapter.js";
import { validManifest } from "./test-helpers.js";

const context: TenantContext = {
  userId: "user-1",
  organizationId: "organization-1",
  membershipId: "membership-1",
  role: "owner",
};

class RecordingGate implements ExtensionGovernanceGate {
  public readonly calls: GovernedActionInput[] = [];

  public async authorize(_context: TenantContext, input: GovernedActionInput): Promise<GovernanceAuthorization> {
    this.calls.push(input);
    return {
      outcome: "allow",
      decision: {
        decisionId: `decision-${input.action}`,
        organizationId: context.organizationId,
        requestHash: input.commandId.padEnd(64, "0").slice(0, 64),
        outcome: "allow",
        reasons: [],
        errors: [],
        createdAt: new Date(),
      },
    };
  }
}

describe("Extension permission diff", () => {
  it("초기 설치와 동일·감소 permission은 별도 증가로 보지 않는다", () => {
    const permissions = validManifest.permissions;
    expect(compareExtensionPermissions(undefined, permissions).increased).toBe(false);
    expect(compareExtensionPermissions(permissions, structuredClone(permissions)).increased).toBe(false);
    expect(
      compareExtensionPermissions(permissions, {
        ...permissions,
        network: [],
        storage: { quotaBytes: 512, maxValueBytes: 256 },
      }).increased,
    ).toBe(false);
  });

  it.each([
    ["tool operation", { tools: [{ id: "new-tool", operations: ["invoke"] }] }],
    ["network method", { network: [{ origin: "https://api.example.com", methods: ["POST"] }] }],
    ["file write", { files: [{ mount: "repository", access: "write" }] }],
    ["secret slot", { secrets: [{ slot: "api-token", purpose: "API 인증" }] }],
    ["process", { process: ["process.spawn.approved"] }],
    ["MCP", { mcp: ["github-mcp"] }],
    ["event", { events: ["work.completed.v1"] }],
    ["storage quota", { storage: { quotaBytes: 2_097_152, maxValueBytes: 65_536 } }],
  ])("%s 추가를 permission 증가로 판정한다", (_name, patch) => {
    const before = validManifest.permissions;
    const after = { ...before, ...patch } as ExtensionPermissionDeclaration;
    const result = compareExtensionPermissions(before, after);
    expect(result.increased).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.beforeDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.afterDigest).toMatch(/^[a-f0-9]{64}$/u);
  });
});

describe("ExtensionGovernanceAdapter", () => {
  it("초기 설치는 extension.install만 판정한다", async () => {
    const gate = new RecordingGate();
    const adapter = new ExtensionGovernanceAdapter(gate);

    const result = await adapter.authorize(context, {
      commandId: "install-1",
      packageName: "@massion-ext/echo",
      packageVersion: "1.0.0",
      artifactDigest: "a".repeat(64),
      environment: "local",
      riskClass: "extension-install",
      executionId: "surface-command-1",
      currentGeneration: 0,
      nextPermissions: validManifest.permissions,
    });

    expect(gate.calls.map((call) => call.action)).toEqual(["extension.install"]);
    expect(result.decisionIds).toEqual(["decision-extension.install"]);
    expect(gate.calls[0]?.resource).toMatchObject({
      type: "ExtensionResource",
      revision: 0,
      attributes: { artifactDigest: "a".repeat(64) },
    });
  });

  it("update permission이 넓어지면 별도 extension.permission_increase를 판정한다", async () => {
    const gate = new RecordingGate();
    const adapter = new ExtensionGovernanceAdapter(gate);
    const next = {
      ...validManifest.permissions,
      network: [{ origin: "https://api.example.com", methods: ["GET" as const] }],
    };

    const result = await adapter.authorize(context, {
      commandId: "update-1",
      packageName: "@massion-ext/echo",
      packageVersion: "1.1.0",
      artifactDigest: "b".repeat(64),
      environment: "production",
      riskClass: "extension-update",
      executionId: "surface-command-2",
      currentGeneration: 3,
      currentPermissions: validManifest.permissions,
      nextPermissions: next,
      installApprovalId: "approval-install",
      permissionApprovalId: "approval-permission",
    });

    expect(gate.calls.map((call) => call.action)).toEqual(["extension.install", "extension.permission_increase"]);
    expect(gate.calls.map((call) => call.approvalId)).toEqual(["approval-install", "approval-permission"]);
    expect(result.permissionDiff.increased).toBe(true);
    expect(result.decisionIds).toHaveLength(2);
  });
});
