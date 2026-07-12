import { decodeApprovalDisplayPreview } from "@massion/governance";
import type { OrganizationService, TenantContext } from "@massion/identity";
import type { MassionDatabase } from "@massion/storage";

import type {
  ApplicationApprovalSource,
  ApplicationAssignmentSource,
  ApplicationExecutionSource,
  ApplicationExtensionSource,
  ApplicationMessageSource,
  ApplicationOrganizationSource,
  ApplicationReadModel,
  ApplicationRoomSource,
  ApplicationRecordSource,
  ApplicationSourceWatermarks,
  ApplicationTaskSource,
  ApplicationWorkSource,
} from "../read-model.js";

interface OrganizationVersionRecord {
  readonly version: number;
}

interface OrganizationNodeRecord {
  readonly handle: string;
  readonly name: string;
  readonly responsibility: string;
  readonly capabilities: readonly string[];
  readonly status: string;
  readonly role: string;
  readonly scope: string;
}

interface WorkRecord {
  readonly organization_id: string;
  readonly work_id: string;
  readonly status: string;
  readonly revision: number;
  readonly artifact_version_ids: readonly string[];
  readonly updated_at: unknown;
}

interface TaskRecord {
  readonly organization_id: string;
  readonly work_id: string;
  readonly task_id: string;
  readonly title: string;
  readonly status: string;
  readonly revision: number;
  readonly created_at: unknown;
}

interface AssignmentRecord {
  readonly organization_id: string;
  readonly work_id: string;
  readonly task_id: string;
  readonly agent_handle: string;
  readonly status: string;
  readonly revision: number;
  readonly created_at: unknown;
}

interface ExecutionRecord {
  readonly organization_id: string;
  readonly execution_id: string;
  readonly work_id: string;
  readonly task_id?: string;
  readonly agent_handle: string;
  readonly model_route: string;
  readonly status: string;
  readonly created_at: unknown;
}

interface UsageRecord {
  readonly execution_id?: string;
  readonly token_count: number;
  readonly cost_micros: number;
}

interface RoomRecord {
  readonly organization_id: string;
  readonly work_id: string;
  readonly room_id: string;
  readonly title: string;
  readonly status: string;
  readonly next_sequence: number;
  readonly created_at: unknown;
}

interface ParticipantRecord {
  readonly room_id: string;
  readonly subject_id: string;
  readonly status: string;
}

interface MessageRecord {
  readonly organization_id: string;
  readonly work_id: string;
  readonly room_id: string;
  readonly message_id: string;
  readonly sequence: number;
  readonly message_type: string;
  readonly author_kind: string;
  readonly author_id: string;
  readonly content: string;
  readonly created_at: unknown;
}

interface WorkRecordProjection {
  readonly organization_id: string;
  readonly work_id: string;
  readonly work_record_id: string;
  readonly version: number;
  readonly summary: string;
  readonly artifact_version_ids: readonly string[];
  readonly verification_ids: readonly string[];
  readonly finalized_at: unknown;
}

interface ApprovalRecord {
  readonly organization_id: string;
  readonly approval_id: string;
  readonly status: string;
  readonly requester_user_id: string;
  readonly requirement_json: string;
  readonly display_preview_json?: string;
  readonly expires_at: unknown;
  readonly created_at: unknown;
}

interface ExtensionInstallationRecord {
  readonly organization_id: string;
  readonly installation_id: string;
  readonly package_name: string;
  readonly state: string;
  readonly active_version_id?: string;
}

interface ExtensionVersionRecord {
  readonly version_id: string;
  readonly package_version: string;
  readonly manifest_json: string;
}

function scalar(value: unknown): string | number {
  if (typeof value === "number" || typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return 0;
}

function iso(value: unknown): string {
  const serialized =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "string" || typeof value === "number"
        ? value
        : value && typeof value === "object" && "toISOString" in value
          ? String((value as { toISOString(): unknown }).toISOString())
          : undefined;
  if (serialized === undefined) throw new Error("datetime 값이 유효하지 않습니다");
  const date = new Date(serialized);
  if (Number.isNaN(date.getTime())) throw new Error("datetime 값이 유효하지 않습니다");
  return date.toISOString();
}

function contributionIds(manifestJson: string): readonly string[] {
  try {
    const manifest = JSON.parse(manifestJson) as {
      contributions?: Readonly<Record<string, unknown>>;
    };
    const result: string[] = [];
    for (const [kind, candidates] of Object.entries(manifest.contributions ?? {})) {
      if (!Array.isArray(candidates)) continue;
      for (const candidate of candidates) {
        if (candidate && typeof candidate === "object" && typeof (candidate as { id?: unknown }).id === "string") {
          result.push(`${kind}:${(candidate as { id: string }).id}`);
        }
      }
    }
    return result.sort();
  } catch {
    throw new Error("Extension manifest contribution을 해석할 수 없습니다");
  }
}

export class SurrealApplicationReadModel implements ApplicationReadModel {
  public constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public async watermarks(context: TenantContext): Promise<ApplicationSourceWatermarks> {
    await this.organizations.verifyTenantContext(context);
    const queries = [
      "SELECT version AS watermark FROM organization_version WHERE organization_id = $organization_id ORDER BY version DESC LIMIT 1;",
      "SELECT updated_at AS watermark FROM work WHERE organization_id = $organization_id ORDER BY updated_at DESC LIMIT 1;",
      "SELECT updated_at AS watermark FROM runtime_execution WHERE organization_id = $organization_id ORDER BY updated_at DESC LIMIT 1;",
      "SELECT created_at AS watermark FROM collaboration_message WHERE organization_id = $organization_id ORDER BY created_at DESC LIMIT 1;",
      "SELECT updated_at AS watermark FROM governance_approval WHERE organization_id = $organization_id ORDER BY updated_at DESC LIMIT 1;",
      "SELECT updated_at AS watermark FROM extension_installation WHERE organization_id = $organization_id ORDER BY updated_at DESC LIMIT 1;",
    ];
    const values = await Promise.all(
      queries.map(async (query) => {
        const [records] = await this.database.query<[Array<{ watermark?: unknown }>]>(query, {
          organization_id: context.organizationId,
        });
        return scalar(records[0]?.watermark);
      }),
    );
    return {
      organization: values[0] ?? 0,
      work: values[1] ?? 0,
      runtime: values[2] ?? 0,
      collaboration: values[3] ?? 0,
      governance: values[4] ?? 0,
      extension: values[5] ?? 0,
    };
  }

  public async organization(context: TenantContext): Promise<ApplicationOrganizationSource> {
    await this.organizations.verifyTenantContext(context);
    const [versions] = await this.database.query<[OrganizationVersionRecord[]]>(
      "SELECT version FROM organization_version WHERE organization_id = $organization_id ORDER BY version DESC LIMIT 1;",
      { organization_id: context.organizationId },
    );
    if (!versions[0]) throw new Error("Application snapshot OrganizationVersion을 찾을 수 없습니다");
    const [nodes] = await this.database.query<[OrganizationNodeRecord[]]>(
      "SELECT handle, name, responsibility, capabilities, status, role, scope FROM organization_node WHERE organization_id = $organization_id ORDER BY handle ASC;",
      { organization_id: context.organizationId },
    );
    return {
      organizationId: context.organizationId,
      version: versions[0].version,
      nodes: nodes.map((node) => ({
        handle: node.handle,
        name: node.name,
        responsibility: node.responsibility,
        capabilities: node.capabilities,
        status: node.status,
        role: node.role,
        scope: node.scope,
      })),
    };
  }

  public async works(context: TenantContext): Promise<readonly ApplicationWorkSource[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[WorkRecord[]]>(
      "SELECT organization_id, work_id, status, revision, artifact_version_ids, updated_at FROM work WHERE organization_id = $organization_id ORDER BY updated_at DESC, work_id ASC;",
      { organization_id: context.organizationId },
    );
    return records.map((record) => ({
      organizationId: record.organization_id,
      workId: record.work_id,
      status: record.status,
      revision: record.revision,
      artifactIds: record.artifact_version_ids,
    }));
  }

  public async tasks(context: TenantContext): Promise<readonly ApplicationTaskSource[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[TaskRecord[]]>(
      "SELECT organization_id, work_id, task_id, title, status, revision, created_at FROM work_task WHERE organization_id = $organization_id ORDER BY created_at ASC, task_id ASC;",
      { organization_id: context.organizationId },
    );
    return records.map((record) => ({
      organizationId: record.organization_id,
      workId: record.work_id,
      taskId: record.task_id,
      title: record.title,
      status: record.status,
      revision: record.revision,
    }));
  }

  public async assignments(context: TenantContext): Promise<readonly ApplicationAssignmentSource[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[AssignmentRecord[]]>(
      "SELECT organization_id, work_id, task_id, agent_handle, status, revision, created_at, assignment_id FROM task_assignment WHERE organization_id = $organization_id ORDER BY created_at ASC, assignment_id ASC;",
      { organization_id: context.organizationId },
    );
    return records.map((record) => ({
      organizationId: record.organization_id,
      workId: record.work_id,
      taskId: record.task_id,
      agentHandle: record.agent_handle,
      status: record.status,
      revision: record.revision,
    }));
  }

  public async executions(context: TenantContext): Promise<readonly ApplicationExecutionSource[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[ExecutionRecord[]]>(
      "SELECT organization_id, execution_id, work_id, task_id, agent_handle, model_route, status, created_at FROM runtime_execution WHERE organization_id = $organization_id ORDER BY created_at ASC, execution_id ASC;",
      { organization_id: context.organizationId },
    );
    const [usages] = await this.database.query<[UsageRecord[]]>(
      "SELECT execution_id, token_count, cost_micros FROM collaboration_message WHERE organization_id = $organization_id AND execution_id != NONE;",
      { organization_id: context.organizationId },
    );
    return records.map((record) => {
      const linked = usages.filter((usage) => usage.execution_id === record.execution_id);
      return {
        organizationId: record.organization_id,
        executionId: record.execution_id,
        workId: record.work_id,
        ...(record.task_id === undefined ? {} : { taskId: record.task_id }),
        agentHandle: record.agent_handle,
        modelRoute: record.model_route,
        status: record.status,
        inputTokens: linked.reduce((sum, usage) => sum + usage.token_count, 0),
        outputTokens: 0,
        costMicros: linked.reduce((sum, usage) => sum + usage.cost_micros, 0),
      };
    });
  }

  public async rooms(context: TenantContext): Promise<readonly ApplicationRoomSource[]> {
    await this.organizations.verifyTenantContext(context);
    const [rooms] = await this.database.query<[RoomRecord[]]>(
      "SELECT organization_id, work_id, room_id, title, status, next_sequence, created_at FROM collaboration_room WHERE organization_id = $organization_id ORDER BY created_at ASC, room_id ASC;",
      { organization_id: context.organizationId },
    );
    const [participants] = await this.database.query<[ParticipantRecord[]]>(
      "SELECT room_id, subject_id, status FROM collaboration_participant WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );
    return rooms.map((room) => ({
      organizationId: room.organization_id,
      workId: room.work_id,
      roomId: room.room_id,
      name: room.title,
      kind: "work",
      status: room.status,
      participantIds: participants
        .filter((participant) => participant.room_id === room.room_id && participant.status === "active")
        .map((participant) => participant.subject_id),
      lastMessageSequence: Math.max(0, room.next_sequence - 1),
    }));
  }

  public async messages(context: TenantContext): Promise<readonly ApplicationMessageSource[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[MessageRecord[]]>(
      "SELECT organization_id, work_id, room_id, message_id, sequence, message_type, author_kind, author_id, content, created_at FROM collaboration_message WHERE organization_id = $organization_id ORDER BY room_id ASC, sequence ASC;",
      { organization_id: context.organizationId },
    );
    return records.map((record) => ({
      organizationId: record.organization_id,
      workId: record.work_id,
      roomId: record.room_id,
      messageId: record.message_id,
      sequence: record.sequence,
      messageType: record.message_type,
      authorKind: record.author_kind,
      authorId: record.author_id,
      content: record.content,
      createdAt: iso(record.created_at),
    }));
  }

  public async records(context: TenantContext): Promise<readonly ApplicationRecordSource[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[WorkRecordProjection[]]>(
      "SELECT organization_id, work_id, work_record_id, version, summary, artifact_version_ids, verification_ids, finalized_at FROM work_record WHERE organization_id = $organization_id AND finalized = true ORDER BY work_id ASC, version ASC;",
      { organization_id: context.organizationId },
    );
    return records.map((record) => ({
      organizationId: record.organization_id,
      workId: record.work_id,
      recordId: record.work_record_id,
      version: record.version,
      summary: record.summary,
      artifactIds: record.artifact_version_ids,
      verificationIds: record.verification_ids,
      finalizedAt: iso(record.finalized_at),
    }));
  }

  public async approvals(context: TenantContext): Promise<readonly ApplicationApprovalSource[]> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[ApprovalRecord[]]>(
      "SELECT organization_id, approval_id, status, requester_user_id, requirement_json, display_preview_json, expires_at, created_at FROM governance_approval WHERE organization_id = $organization_id ORDER BY created_at ASC, approval_id ASC;",
      { organization_id: context.organizationId },
    );
    return records.map((record) => {
      const requirement = JSON.parse(record.requirement_json) as { actions?: readonly string[] };
      const displayPreview = decodeApprovalDisplayPreview(record.display_preview_json);
      return {
        organizationId: record.organization_id,
        approvalId: record.approval_id,
        action: requirement.actions?.[0] ?? "unknown",
        status: record.status,
        requestedBy: record.requester_user_id,
        expiresAt: iso(record.expires_at),
        ...(displayPreview === undefined ? {} : { displayPreview }),
      };
    });
  }

  public async extensions(context: TenantContext): Promise<readonly ApplicationExtensionSource[]> {
    await this.organizations.verifyTenantContext(context);
    const [installations] = await this.database.query<[ExtensionInstallationRecord[]]>(
      "SELECT organization_id, installation_id, package_name, state, active_version_id FROM extension_installation WHERE organization_id = $organization_id ORDER BY package_name ASC;",
      { organization_id: context.organizationId },
    );
    const [versions] = await this.database.query<[ExtensionVersionRecord[]]>(
      "SELECT version_id, package_version, manifest_json FROM extension_version WHERE organization_id = $organization_id;",
      { organization_id: context.organizationId },
    );
    return installations.map((installation) => {
      const version = versions.find((candidate) => candidate.version_id === installation.active_version_id);
      return {
        organizationId: installation.organization_id,
        installationId: installation.installation_id,
        packageName: installation.package_name,
        packageVersion: version?.package_version ?? "inactive",
        state: installation.state,
        contributions: version ? contributionIds(version.manifest_json) : [],
      };
    });
  }
}
