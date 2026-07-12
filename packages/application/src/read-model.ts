import type { ApprovalDisplayPreview } from "@massion/governance";
import type { TenantContext } from "@massion/identity";

export type ApplicationSourceWatermarks = Readonly<Record<string, string | number>>;

export interface ApplicationOrganizationNodeSource {
  readonly handle: string;
  readonly name: string;
  readonly responsibility: string;
  readonly capabilities: readonly string[];
  readonly status: string;
  readonly role: string;
  readonly scope: string;
}

export interface ApplicationOrganizationSource {
  readonly organizationId: string;
  readonly version: number;
  readonly nodes: readonly ApplicationOrganizationNodeSource[];
}

export interface ApplicationWorkSource {
  readonly organizationId: string;
  readonly workId: string;
  readonly status: string;
  readonly revision: number;
  readonly artifactIds: readonly string[];
}

export interface ApplicationTaskSource {
  readonly organizationId: string;
  readonly workId: string;
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly revision: number;
}

export interface ApplicationAssignmentSource {
  readonly organizationId: string;
  readonly workId: string;
  readonly taskId: string;
  readonly agentHandle: string;
  readonly status: string;
  readonly revision: number;
}

export interface ApplicationExecutionSource {
  readonly organizationId: string;
  readonly executionId: string;
  readonly workId: string;
  readonly taskId?: string;
  readonly agentHandle: string;
  readonly modelRoute: string;
  readonly status: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicros: number;
}

export interface ApplicationRoomSource {
  readonly organizationId: string;
  readonly workId: string;
  readonly roomId: string;
  readonly name: string;
  readonly kind: string;
  readonly status: string;
  readonly participantIds: readonly string[];
  readonly lastMessageSequence: number;
}

export interface ApplicationMessageSource {
  readonly organizationId: string;
  readonly workId: string;
  readonly roomId: string;
  readonly messageId: string;
  readonly sequence: number;
  readonly messageType: string;
  readonly authorKind: string;
  readonly authorId: string;
  readonly content: string;
  readonly createdAt: string;
}

export interface ApplicationRecordSource {
  readonly organizationId: string;
  readonly workId: string;
  readonly recordId: string;
  readonly version: number;
  readonly summary: string;
  readonly artifactIds: readonly string[];
  readonly verificationIds: readonly string[];
  readonly finalizedAt: string;
}

export interface ApplicationApprovalSource {
  readonly organizationId: string;
  readonly approvalId: string;
  readonly action: string;
  readonly status: string;
  readonly requestedBy: string;
  readonly expiresAt: string;
  readonly displayPreview?: ApprovalDisplayPreview;
}

export interface ApplicationExtensionSource {
  readonly organizationId: string;
  readonly installationId: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly state: string;
  readonly contributions: readonly string[];
}

export interface ApplicationReadModel {
  watermarks(context: TenantContext): Promise<ApplicationSourceWatermarks>;
  organization(context: TenantContext): Promise<ApplicationOrganizationSource>;
  works(context: TenantContext): Promise<readonly ApplicationWorkSource[]>;
  tasks(context: TenantContext): Promise<readonly ApplicationTaskSource[]>;
  assignments(context: TenantContext): Promise<readonly ApplicationAssignmentSource[]>;
  executions(context: TenantContext): Promise<readonly ApplicationExecutionSource[]>;
  rooms(context: TenantContext): Promise<readonly ApplicationRoomSource[]>;
  messages?(context: TenantContext): Promise<readonly ApplicationMessageSource[]>;
  records?(context: TenantContext): Promise<readonly ApplicationRecordSource[]>;
  approvals(context: TenantContext): Promise<readonly ApplicationApprovalSource[]>;
  extensions(context: TenantContext): Promise<readonly ApplicationExtensionSource[]>;
}
