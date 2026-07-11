import type { ApprovalRequirement, PolicyBundle } from "./contracts.js";

const ACTIONS = [
  "work.read",
  "work.execute",
  "agent.invoke",
  "tool.call",
  "organization.change",
  "extension.install",
  "extension.permission_increase",
  "policy.activate",
  "growth.configure",
  "growth.strategy.activate",
  "growth.reflect",
  "growth.adopt",
  "growth.revert",
  "declaration.apply",
  "approval.decide",
  "emergency.stop",
  "emergency.stop.disable",
  "audit.disable",
] as const;

function entityShape() {
  return {
    shape: {
      type: "Record",
      attributes: {
        organizationId: { type: "String", required: true },
        kind: { type: "String", required: false },
        role: { type: "String", required: false },
        subjectId: { type: "String", required: false },
      },
    },
  };
}

function resourceShape() {
  return {
    shape: {
      type: "Record",
      attributes: {
        organizationId: { type: "String", required: true },
        dataClassification: { type: "String", required: false },
        subjectType: { type: "String", required: false },
        subjectId: { type: "String", required: false },
      },
    },
  };
}

export function createDefaultPolicy(kind: "personal" | "team"): {
  bundle: PolicyBundle;
  requirements: readonly ApprovalRequirement[];
} {
  const principalTypes = ["Human", "Agent", "Extension"];
  const resourceTypes = [
    "Work",
    "Tool",
    "Organization",
    "ExtensionResource",
    "Policy",
    "Suggestion",
    "Declaration",
    "Approval",
    "AssuranceBindingVersion",
    "GrowthConfiguration",
  ];
  const context = {
    type: "Record",
    attributes: {
      environment: { type: "String", required: true },
      riskClass: { type: "String", required: true },
      external: { type: "Boolean", required: true },
      automationMode: { type: "String", required: false },
    },
  };
  const actions = Object.fromEntries(
    ACTIONS.map((action) => [action, { appliesTo: { principalTypes, resourceTypes, context } }]),
  );
  const dangerousActions = [
    "work.execute",
    "tool.call",
    "organization.change",
    "extension.install",
    "extension.permission_increase",
    "policy.activate",
    "declaration.apply",
    "emergency.stop.disable",
  ];
  return {
    bundle: {
      schema: {
        Massion: {
          entityTypes: {
            Human: entityShape(),
            Agent: entityShape(),
            Extension: entityShape(),
            Work: resourceShape(),
            Tool: resourceShape(),
            Organization: resourceShape(),
            ExtensionResource: resourceShape(),
            Policy: resourceShape(),
            Suggestion: resourceShape(),
            Declaration: resourceShape(),
            Approval: resourceShape(),
            AssuranceBindingVersion: resourceShape(),
            GrowthConfiguration: resourceShape(),
          },
          actions,
        },
      },
      policies: {
        tenant: "permit(principal, action, resource) when { principal.organizationId == resource.organizationId };",
        "invariant-local-private":
          'forbid(principal, action, resource) when { resource has dataClassification && resource.dataClassification == "local-private" && context.external };',
        "invariant-agent-approval":
          'forbid(principal is Massion::Agent, action == Massion::Action::"approval.decide", resource);',
        "invariant-audit": 'forbid(principal, action == Massion::Action::"audit.disable", resource);',
        "invariant-emergency":
          'forbid(principal, action == Massion::Action::"emergency.stop.disable", resource) when { principal is Massion::Agent };',
        "growth-organization-configuration":
          'forbid(principal is Massion::Human, action == Massion::Action::"growth.configure", resource) when { resource has subjectType && resource.subjectType == "organization" && principal has role && principal.role == "member" };',
        "growth-user-configuration":
          'forbid(principal is Massion::Human, action == Massion::Action::"growth.configure", resource) when { resource has subjectType && resource.subjectType == "user" && resource has subjectId && principal has subjectId && resource.subjectId != principal.subjectId };',
      },
    },
    requirements: [
      {
        requirementId: `${kind}-dangerous-action`,
        actions: dangerousActions,
        environments: ["*"],
        riskClasses: ["*"],
        approverRoles: ["owner", "admin"],
        quorum: 1,
        separationOfDuty: kind === "team",
        expiresInSeconds: 3600,
      },
    ],
  };
}
