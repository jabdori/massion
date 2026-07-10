import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import type {
  DeliveryPrerequisiteReader,
  EngineeringDelivery,
  EngineeringDeliveryError,
  EngineeringDeliveryResult,
  EngineeringDeliveryStatus,
  StartEngineeringDeliveryInput,
  TransitionEngineeringDeliveryInput,
} from "./contracts.js";
import { SOFTWARE_ENGINEERING_DELIVERY_MIGRATION } from "./schema.js";

interface DeliveryRecord {
  readonly delivery_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly task_id: string;
  readonly assignment_id: string;
  readonly repository_id: string;
  readonly repository_revision_id: string;
  readonly base_revision: string;
  readonly agent_handle: string;
  readonly profile_version: string;
  readonly status: EngineeringDeliveryStatus;
  readonly version: number;
  readonly start_command_id: string;
  readonly workspace_id?: string;
  readonly branch_ref?: string;
  readonly commit_sha?: string;
  readonly test_patch_hash?: string;
  readonly implementation_patch_hash?: string;
  readonly change_set_hash?: string;
  readonly red_evidence_id?: string;
  readonly green_evidence_id?: string;
  readonly validation_evidence_ids: readonly string[];
  readonly artifact_version_id?: string;
  readonly error_json?: string;
  readonly created_by_user_id: string;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface EventRecord {
  readonly request_hash: string;
  readonly result_json: string;
}

const TERMINAL_STATUSES = new Set<EngineeringDeliveryStatus>(["committed", "failed", "cancelled"]);
const NEXT_STATUS: Readonly<Partial<Record<EngineeringDeliveryStatus, EngineeringDeliveryStatus>>> = {
  preparing: "test_applied",
  test_applied: "red_verified",
  red_verified: "implementation_applied",
  implementation_applied: "green_verified",
  green_verified: "committed",
};

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashRequest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assertText(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label}이 필요합니다`);
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label}은 SHA-256 형식이어야 합니다`);
}

export class EngineeringDeliveryStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly prerequisites: DeliveryPrerequisiteReader,
  ) {}

  public static async create(
    database: MassionDatabase,
    organizations: OrganizationService,
    prerequisites: DeliveryPrerequisiteReader,
  ): Promise<EngineeringDeliveryStore> {
    await applyMigrations(database, [SOFTWARE_ENGINEERING_DELIVERY_MIGRATION]);
    return new EngineeringDeliveryStore(database, organizations, prerequisites);
  }

  public async start(context: TenantContext, input: StartEngineeringDeliveryInput): Promise<EngineeringDeliveryResult> {
    await this.organizations.verifyTenantContext(context);
    this.validateStartInput(input);
    const requestHash = hashRequest({ operation: "start", input });
    const replayed = await this.replay(context.organizationId, input.commandId, requestHash);
    if (replayed) return { delivery: await this.get(context, replayed.deliveryId) };

    await this.verifyPrerequisites(context, input);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const concurrentReplay = await this.replay(context.organizationId, input.commandId, requestHash, tx);
      if (concurrentReplay)
        return { delivery: this.view(await this.find(tx, context.organizationId, concurrentReplay.deliveryId)) };

      const deliveryId = randomUUID();
      const [created] = await tx.query<[DeliveryRecord[]]>(
        "CREATE engineering_delivery CONTENT { delivery_id: $delivery_id, organization_id: $organization_id, work_id: $work_id, task_id: $task_id, assignment_id: $assignment_id, repository_id: $repository_id, repository_revision_id: $repository_revision_id, base_revision: $base_revision, agent_handle: $agent_handle, profile_version: $profile_version, status: 'preparing', version: 1, start_command_id: $start_command_id, validation_evidence_ids: [], created_by_user_id: $created_by_user_id, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          delivery_id: deliveryId,
          organization_id: context.organizationId,
          work_id: input.workId,
          task_id: input.taskId,
          assignment_id: input.assignmentId,
          repository_id: input.repositoryId,
          repository_revision_id: input.repositoryRevisionId,
          base_revision: input.baseRevision.trim(),
          agent_handle: input.agentHandle.trim(),
          profile_version: input.profileVersion.trim(),
          start_command_id: input.commandId,
          created_by_user_id: context.userId,
        },
      );
      if (!created[0]) throw new Error("EngineeringDelivery 생성 결과가 없습니다");
      await this.recordEvent(tx, context, {
        deliveryId,
        commandId: input.commandId,
        eventType: "engineering_delivery_started",
        requestHash,
        payload: { status: "preparing", repositoryRevisionId: input.repositoryRevisionId },
      });
      return { delivery: this.view(created[0]) };
    });
  }

  public async get(context: TenantContext, deliveryId: string): Promise<EngineeringDelivery> {
    await this.organizations.verifyTenantContext(context);
    return this.view(await this.find(this.database, context.organizationId, deliveryId));
  }

  public async transition(
    context: TenantContext,
    input: TransitionEngineeringDeliveryInput,
  ): Promise<EngineeringDeliveryResult> {
    await this.organizations.verifyTenantContext(context);
    assertText(input.commandId, "Command ID");
    assertText(input.deliveryId, "Delivery ID");
    this.validateError(input.target, input.error);
    const requestHash = hashRequest({ operation: "transition", input });
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const replayed = await this.replay(context.organizationId, input.commandId, requestHash, tx);
      if (replayed) return { delivery: this.view(await this.find(tx, context.organizationId, replayed.deliveryId)) };

      const current = await this.find(tx, context.organizationId, input.deliveryId);
      if (current.version !== input.expectedVersion) throw new Error("Engineering delivery version 충돌입니다");
      if (TERMINAL_STATUSES.has(current.status)) throw new Error("terminal delivery는 변경할 수 없습니다");
      const terminalFailure = input.target === "failed" || input.target === "cancelled";
      if (!terminalFailure && NEXT_STATUS[current.status] !== input.target) {
        throw new Error(`허용되지 않는 delivery 상태 전이입니다: ${current.status} -> ${input.target}`);
      }

      const [updated] = await tx.query<[DeliveryRecord[]]>(
        "UPDATE engineering_delivery SET status = $status, version = $version, workspace_id = $workspace_id, branch_ref = $branch_ref, commit_sha = $commit_sha, test_patch_hash = $test_patch_hash, implementation_patch_hash = $implementation_patch_hash, change_set_hash = $change_set_hash, red_evidence_id = $red_evidence_id, green_evidence_id = $green_evidence_id, validation_evidence_ids = $validation_evidence_ids, artifact_version_id = $artifact_version_id, error_json = $error_json, updated_at = time::now() WHERE organization_id = $organization_id AND delivery_id = $delivery_id AND version = $expected_version RETURN AFTER;",
        {
          organization_id: context.organizationId,
          delivery_id: input.deliveryId,
          expected_version: input.expectedVersion,
          status: input.target,
          version: current.version + 1,
          workspace_id: input.workspaceId ?? current.workspace_id,
          branch_ref: input.branchRef ?? current.branch_ref,
          commit_sha: input.commitSha ?? current.commit_sha,
          test_patch_hash: input.testPatchHash ?? current.test_patch_hash,
          implementation_patch_hash: input.implementationPatchHash ?? current.implementation_patch_hash,
          change_set_hash: input.changeSetHash ?? current.change_set_hash,
          red_evidence_id: input.redEvidenceId ?? current.red_evidence_id,
          green_evidence_id: input.greenEvidenceId ?? current.green_evidence_id,
          validation_evidence_ids: input.validationEvidenceIds ?? current.validation_evidence_ids,
          artifact_version_id: input.artifactVersionId ?? current.artifact_version_id,
          error_json: input.error ? canonicalJson(input.error) : current.error_json,
        },
      );
      if (!updated[0]) throw new Error("Engineering delivery version 충돌입니다");
      await this.recordEvent(tx, context, {
        deliveryId: input.deliveryId,
        commandId: input.commandId,
        eventType: this.eventType(input.target),
        requestHash,
        payload: { from: current.status, to: input.target, version: updated[0].version },
      });
      return { delivery: this.view(updated[0]) };
    });
  }

  private validateStartInput(input: StartEngineeringDeliveryInput): void {
    for (const [label, value] of [
      ["Command ID", input.commandId],
      ["Work ID", input.workId],
      ["Task ID", input.taskId],
      ["Assignment ID", input.assignmentId],
      ["Repository ID", input.repositoryId],
      ["Repository revision ID", input.repositoryRevisionId],
      ["Base revision", input.baseRevision],
      ["Agent handle", input.agentHandle],
      ["Profile version", input.profileVersion],
    ] as const) {
      assertText(value, label);
    }
  }

  private async verifyPrerequisites(context: TenantContext, input: StartEngineeringDeliveryInput): Promise<void> {
    const [work, task, assignment, repository, revision] = await Promise.all([
      this.prerequisites.getWork(context, input.workId),
      this.prerequisites.getTask(context, input.workId, input.taskId),
      this.prerequisites.getAssignment(context, input.workId, input.assignmentId),
      this.prerequisites.getRepository(context, input.repositoryId),
      this.prerequisites.getRepositoryRevision(context, input.repositoryRevisionId),
    ]);
    if (work.organizationId !== context.organizationId || work.workId !== input.workId) {
      throw new Error("Work 소유 계보가 tenant와 일치하지 않습니다");
    }
    if (
      task.organizationId !== context.organizationId ||
      task.workId !== input.workId ||
      task.taskId !== input.taskId
    ) {
      throw new Error("Task 소유 계보가 Work와 일치하지 않습니다");
    }
    if (
      assignment.organizationId !== context.organizationId ||
      assignment.workId !== input.workId ||
      assignment.taskId !== input.taskId ||
      assignment.assignmentId !== input.assignmentId
    ) {
      throw new Error("Assignment 소유 계보가 Task와 일치하지 않습니다");
    }
    if (assignment.status !== "active" || assignment.agentHandle !== input.agentHandle) {
      throw new Error("선택된 active Agent assignment가 아닙니다");
    }
    if (
      repository.organizationId !== context.organizationId ||
      repository.repositoryId !== input.repositoryId ||
      repository.status !== "active"
    ) {
      throw new Error("Repository 소유 계보 또는 상태가 유효하지 않습니다");
    }
    if (
      revision.organizationId !== context.organizationId ||
      revision.repositoryId !== input.repositoryId ||
      revision.repositoryRevisionId !== input.repositoryRevisionId
    ) {
      throw new Error("RepositoryRevision 소유 계보가 Repository와 일치하지 않습니다");
    }
    if (revision.dirty) throw new Error("Engineering delivery는 clean revision만 base로 사용할 수 있습니다");
    if (revision.providerRevision !== input.baseRevision.trim()) {
      throw new Error("Base revision이 RepositoryRevision provider revision과 일치하지 않습니다");
    }
  }

  private validateError(target: EngineeringDeliveryStatus, error: EngineeringDeliveryError | undefined): void {
    if (target === "failed" && !error) throw new Error("failed 상태에는 실패 error가 필요합니다");
    if (target !== "failed" && error) throw new Error("failed 상태가 아니면 error를 기록할 수 없습니다");
    if (error) {
      assertText(error.category, "Error category");
      assertSha256(error.causeId, "Error cause ID");
    }
  }

  private async find(executor: QueryExecutor, organizationId: string, deliveryId: string): Promise<DeliveryRecord> {
    const [records] = await executor.query<[DeliveryRecord[]]>(
      "SELECT * OMIT id FROM engineering_delivery WHERE organization_id = $organization_id AND delivery_id = $delivery_id LIMIT 1;",
      { organization_id: organizationId, delivery_id: deliveryId },
    );
    if (!records[0]) throw new Error(`Delivery를 찾을 수 없습니다: ${deliveryId}`);
    return records[0];
  }

  private async replay(
    organizationId: string,
    commandId: string,
    requestHash: string,
    executor: QueryExecutor = this.database,
  ): Promise<{ readonly deliveryId: string } | undefined> {
    const [events] = await executor.query<[EventRecord[]]>(
      "SELECT request_hash, result_json FROM engineering_delivery_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    const event = events[0];
    if (!event) return undefined;
    if (event.request_hash !== requestHash)
      throw new Error("같은 command ID에 다른 delivery 명령을 사용할 수 없습니다");
    return JSON.parse(event.result_json) as { readonly deliveryId: string };
  }

  private async recordEvent(
    executor: QueryExecutor,
    context: TenantContext,
    input: {
      readonly deliveryId: string;
      readonly commandId: string;
      readonly eventType: string;
      readonly requestHash: string;
      readonly payload: unknown;
    },
  ): Promise<void> {
    await executor.query(
      "CREATE engineering_delivery_event CONTENT { event_id: $event_id, organization_id: $organization_id, delivery_id: $delivery_id, command_id: $command_id, event_type: $event_type, request_hash: $request_hash, payload_json: $payload_json, result_json: $result_json, actor_user_id: $actor_user_id, created_at: time::now() };",
      {
        event_id: randomUUID(),
        organization_id: context.organizationId,
        delivery_id: input.deliveryId,
        command_id: input.commandId,
        event_type: input.eventType,
        request_hash: input.requestHash,
        payload_json: canonicalJson(input.payload),
        result_json: canonicalJson({ deliveryId: input.deliveryId }),
        actor_user_id: context.userId,
      },
    );
  }

  private eventType(status: EngineeringDeliveryStatus): string {
    const named: Partial<Record<EngineeringDeliveryStatus, string>> = {
      red_verified: "engineering_red_verified",
      green_verified: "engineering_green_verified",
      committed: "engineering_delivery_committed",
      failed: "engineering_delivery_failed",
    };
    return named[status] ?? "engineering_delivery_transitioned";
  }

  private view(record: DeliveryRecord): EngineeringDelivery {
    return {
      deliveryId: record.delivery_id,
      organizationId: record.organization_id,
      workId: record.work_id,
      taskId: record.task_id,
      assignmentId: record.assignment_id,
      repositoryId: record.repository_id,
      repositoryRevisionId: record.repository_revision_id,
      baseRevision: record.base_revision,
      agentHandle: record.agent_handle,
      profileVersion: record.profile_version,
      status: record.status,
      version: record.version,
      startCommandId: record.start_command_id,
      ...(record.workspace_id ? { workspaceId: record.workspace_id } : {}),
      ...(record.branch_ref ? { branchRef: record.branch_ref } : {}),
      ...(record.commit_sha ? { commitSha: record.commit_sha } : {}),
      ...(record.test_patch_hash ? { testPatchHash: record.test_patch_hash } : {}),
      ...(record.implementation_patch_hash ? { implementationPatchHash: record.implementation_patch_hash } : {}),
      ...(record.change_set_hash ? { changeSetHash: record.change_set_hash } : {}),
      ...(record.red_evidence_id ? { redEvidenceId: record.red_evidence_id } : {}),
      ...(record.green_evidence_id ? { greenEvidenceId: record.green_evidence_id } : {}),
      validationEvidenceIds: record.validation_evidence_ids,
      ...(record.artifact_version_id ? { artifactVersionId: record.artifact_version_id } : {}),
      ...(record.error_json ? { error: JSON.parse(record.error_json) as EngineeringDeliveryError } : {}),
      createdByUserId: record.created_by_user_id,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
    };
  }
}
