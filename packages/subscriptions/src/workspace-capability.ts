import { createHmac, timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";

export const EDGE_WORKSPACE_ROOT_CAPABILITY_PREFIX = "massion.workspace-root.v1." as const;
export const EDGE_WORKSPACE_EXECUTION_CAPABILITY_PREFIX = "massion.workspace-execution.v1." as const;

export interface EdgeWorkspaceExecutionLineage {
  readonly organizationId: string;
  readonly connectorId: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly routeAttemptId: string;
  readonly sessionLeaseId: string;
  readonly executionId: string;
  readonly workId: string;
  readonly agentHandle: string;
}

const ROOT_CAPABILITY = /^massion\.workspace-root\.v1\.([A-Za-z0-9_-]{43})$/u;
const EXECUTION_CAPABILITY = /^massion\.workspace-execution\.v1\.([A-Za-z0-9_-]{43})$/u;

function text(value: string, label: string): string {
  if (!value || value !== value.trim() || value.length > 512 || /[\0\r\n]/u.test(value)) {
    throw new Error(`${label}가 유효하지 않습니다`);
  }
  return value;
}

function canonicalLineage(lineage: EdgeWorkspaceExecutionLineage): string {
  return JSON.stringify({
    organizationId: text(lineage.organizationId, "조직 ID"),
    connectorId: text(lineage.connectorId, "Connector ID"),
    providerId: text(lineage.providerId, "Provider ID"),
    accountId: text(lineage.accountId, "구독 계정 ID"),
    routeAttemptId: text(lineage.routeAttemptId, "Route Attempt ID"),
    sessionLeaseId: text(lineage.sessionLeaseId, "Session Lease ID"),
    executionId: text(lineage.executionId, "Execution ID"),
    workId: text(lineage.workId, "Work ID"),
    agentHandle: text(lineage.agentHandle, "Agent handle"),
  });
}

function rootCapabilityKey(capability: string): Buffer {
  const match = ROOT_CAPABILITY.exec(capability);
  if (!match?.[1]) throw new Error("Edge 작업공간 root capability가 유효하지 않습니다");
  const key = Buffer.from(match[1], "base64url");
  if (key.byteLength !== 32) throw new Error("Edge 작업공간 root capability가 유효하지 않습니다");
  return key;
}

export function createEdgeWorkspaceRootCapability(secret: Uint8Array, canonicalWorkspaceRoot: string): string {
  const key = Buffer.from(secret);
  if (key.byteLength !== 32) throw new Error("Edge 작업공간 capability 비밀이 유효하지 않습니다");
  if (
    !isAbsolute(canonicalWorkspaceRoot) ||
    canonicalWorkspaceRoot !== canonicalWorkspaceRoot.trim() ||
    canonicalWorkspaceRoot.length > 4096 ||
    canonicalWorkspaceRoot.includes("\0")
  ) {
    throw new Error("Edge 로컬 작업공간 root가 유효하지 않습니다");
  }
  const digest = createHmac("sha256", key)
    .update("massion.workspace-root.v1\0", "utf8")
    .update(canonicalWorkspaceRoot, "utf8")
    .digest("base64url");
  return `${EDGE_WORKSPACE_ROOT_CAPABILITY_PREFIX}${digest}`;
}

export function createEdgeWorkspaceExecutionCapability(
  rootCapability: string,
  lineage: EdgeWorkspaceExecutionLineage,
): string {
  const digest = createHmac("sha256", rootCapabilityKey(rootCapability))
    .update("massion.workspace-execution.v1\0", "utf8")
    .update(canonicalLineage(lineage), "utf8")
    .digest("base64url");
  return `${EDGE_WORKSPACE_EXECUTION_CAPABILITY_PREFIX}${digest}`;
}

export function matchesEdgeWorkspaceExecutionCapability(
  capability: string,
  rootCapability: string,
  lineage: EdgeWorkspaceExecutionLineage,
): boolean {
  try {
    const actual = EXECUTION_CAPABILITY.exec(capability)?.[1];
    if (!actual) return false;
    const expected = createEdgeWorkspaceExecutionCapability(rootCapability, lineage).slice(
      EDGE_WORKSPACE_EXECUTION_CAPABILITY_PREFIX.length,
    );
    const actualBytes = Buffer.from(actual, "base64url");
    const expectedBytes = Buffer.from(expected, "base64url");
    return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes);
  } catch {
    return false;
  }
}

export function selectEdgeWorkspaceRootCapability(
  connectorCapabilities: readonly string[],
  lineage: EdgeWorkspaceExecutionLineage,
): string {
  canonicalLineage(lineage);
  const malformed = connectorCapabilities.find(
    (capability) => capability.startsWith(EDGE_WORKSPACE_ROOT_CAPABILITY_PREFIX) && !ROOT_CAPABILITY.test(capability),
  );
  if (malformed) throw new Error("Edge 작업공간 root capability가 유효하지 않습니다");
  const roots = [...new Set(connectorCapabilities.filter((capability) => ROOT_CAPABILITY.test(capability)))].sort();
  if (roots.length !== 1) throw new Error("Edge 전용 작업공간 root capability가 정확히 1개 필요합니다");
  const selected = roots[0];
  if (!selected) throw new Error("Edge 작업공간 root capability를 선택할 수 없습니다");
  return selected;
}
