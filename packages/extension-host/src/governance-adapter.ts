import { createHash } from "node:crypto";

import type { ExtensionPermissionDeclaration } from "@massion/extension-sdk";
import type { TenantContext } from "@massion/identity";
import type { GovernedActionInput, GovernanceAuthorization } from "@massion/governance";

export interface ExtensionPermissionDiff {
  readonly increased: boolean;
  readonly reasons: readonly string[];
  readonly beforeDigest: string;
  readonly afterDigest: string;
}

export interface ExtensionGovernanceGate {
  authorize(context: TenantContext, input: GovernedActionInput): Promise<GovernanceAuthorization>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function capabilities(permissions: ExtensionPermissionDeclaration): ReadonlySet<string> {
  const values = new Set<string>();
  for (const tool of permissions.tools) {
    for (const operation of tool.operations) values.add(`tool:${tool.id}:${operation}`);
  }
  for (const network of permissions.network) {
    for (const method of network.methods) values.add(`network:${network.origin}:${method}`);
  }
  for (const file of permissions.files) {
    values.add(`file:${file.mount}:read`);
    if (file.access === "write") values.add(`file:${file.mount}:write`);
  }
  for (const secret of permissions.secrets) values.add(`secret:${secret.slot}`);
  for (const operation of permissions.process) values.add(`process:${operation}`);
  for (const server of permissions.mcp) values.add(`mcp:${server}`);
  for (const event of permissions.events) values.add(`event:${event}`);
  return values;
}

function normalized(permissions: ExtensionPermissionDeclaration): unknown {
  return {
    capabilities: [...capabilities(permissions)].sort(),
    storage: {
      maxValueBytes: permissions.storage.maxValueBytes,
      quotaBytes: permissions.storage.quotaBytes,
    },
  };
}

export function compareExtensionPermissions(
  before: ExtensionPermissionDeclaration | undefined,
  after: ExtensionPermissionDeclaration,
): ExtensionPermissionDiff {
  const beforeDigest = sha256(canonicalJson(before ? normalized(before) : { capabilities: [], storage: null }));
  const afterDigest = sha256(canonicalJson(normalized(after)));
  if (!before) return { increased: false, reasons: [], beforeDigest, afterDigest };
  const previous = capabilities(before);
  const reasons = [...capabilities(after)]
    .filter((capability) => !previous.has(capability))
    .map((capability) => `capability:${capability}`);
  if (after.storage.quotaBytes > before.storage.quotaBytes) reasons.push("storage:quotaBytes");
  if (after.storage.maxValueBytes > before.storage.maxValueBytes) reasons.push("storage:maxValueBytes");
  reasons.sort();
  return { increased: reasons.length > 0, reasons, beforeDigest, afterDigest };
}

export interface AuthorizeExtensionChangeInput {
  readonly commandId: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly artifactDigest: string;
  readonly environment: string;
  readonly riskClass: string;
  readonly executionId: string;
  readonly currentGeneration: number;
  readonly currentPermissions?: ExtensionPermissionDeclaration;
  readonly nextPermissions: ExtensionPermissionDeclaration;
  readonly installApprovalId?: string;
  readonly permissionApprovalId?: string;
  readonly external?: boolean;
}

export class ExtensionGovernanceAdapter {
  public constructor(private readonly gate: ExtensionGovernanceGate) {}

  public async authorize(
    context: TenantContext,
    input: AuthorizeExtensionChangeInput,
  ): Promise<{
    readonly decisionIds: readonly string[];
    readonly permissionDiff: ExtensionPermissionDiff;
  }> {
    const permissionDiff = compareExtensionPermissions(input.currentPermissions, input.nextPermissions);
    const resourceId = `${input.packageName}@${input.packageVersion}#${input.artifactDigest}`;
    const common = {
      resource: {
        type: "ExtensionResource",
        id: resourceId,
        revision: input.currentGeneration,
        dataClassification: "internal",
        attributes: {
          artifactDigest: input.artifactDigest,
          packageName: input.packageName,
          packageVersion: input.packageVersion,
          permissionDigest: permissionDiff.afterDigest,
        },
      },
      environment: input.environment,
      riskClass: input.riskClass,
      external: input.external ?? false,
      executionId: input.executionId,
    } as const;
    const install = await this.gate.authorize(context, {
      ...common,
      commandId: `${input.commandId}:install`,
      action: "extension.install",
      ...(input.installApprovalId === undefined ? {} : { approvalId: input.installApprovalId }),
    });
    const decisions = [install.decision.decisionId];
    if (permissionDiff.increased) {
      const permission = await this.gate.authorize(context, {
        ...common,
        commandId: `${input.commandId}:permission`,
        action: "extension.permission_increase",
        resource: {
          ...common.resource,
          attributes: {
            ...common.resource.attributes,
            beforePermissionDigest: permissionDiff.beforeDigest,
          },
        },
        ...(input.permissionApprovalId === undefined ? {} : { approvalId: input.permissionApprovalId }),
      });
      decisions.push(permission.decision.decisionId);
    }
    return { decisionIds: decisions, permissionDiff };
  }
}
