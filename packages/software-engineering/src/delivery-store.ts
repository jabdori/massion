import { createHash, randomUUID } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";
import { redactSecrets } from "@massion/evidence";

import type {
  DeliveryPrerequisiteReader,
  EngineeringDelivery,
  EngineeringDeliveryError,
  EngineeringAssuranceRecipe,
  EngineeringDeliveryResult,
  EngineeringDeliveryStatus,
  StartEngineeringDeliveryInput,
  TransitionEngineeringDeliveryInput,
} from "./contracts.js";
import type { EngineeringCommandEvidence } from "./command-runner.js";
import type { GitFileChange } from "./git-workspace.js";
import {
  SOFTWARE_ENGINEERING_DELIVERY_MIGRATION,
  SOFTWARE_ENGINEERING_COMMAND_ENVIRONMENT_MIGRATION,
  SOFTWARE_ENGINEERING_ROOT_BINDING_MIGRATION,
  SOFTWARE_ENGINEERING_TDD_EVIDENCE_MIGRATION,
} from "./schema.js";

interface DeliveryRecord {
  readonly delivery_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly task_id: string;
  readonly assignment_id: string;
  readonly repository_id: string;
  readonly repository_revision_id: string;
  readonly base_revision: string;
  readonly repository_root_real_path_hash?: string;
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
  readonly assurance_recipe_json?: string;
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

interface CommandEvidenceRecord {
  readonly command_evidence_id: string;
  readonly delivery_id?: string;
  readonly stage?: EngineeringCommandEvidence["stage"];
  readonly evidence_hash?: string;
  readonly created_at?: unknown;
}

interface FileChangeRecord {
  readonly file_change_id: string;
  readonly organization_id: string;
  readonly delivery_id: string;
  readonly relative_path: string;
  readonly kind: GitFileChange["kind"];
  readonly before_hash?: string;
  readonly after_hash?: string;
  readonly test_file: boolean;
  readonly change_hash?: string;
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

function assertGitObjectHash(value: string, label: string): void {
  if (!/^[a-f0-9]{40,64}$/u.test(value)) throw new Error(`${label}는 Git object hash 형식이어야 합니다`);
}

function validateAssuranceCommand(command: EngineeringAssuranceRecipe["focusedCommand"]): void {
  assertText(command.executable, "Assurance command executable");
  if (command.args.length > 50) throw new Error("Assurance command argument는 50개 이하여야 합니다");
  for (const argument of command.args) {
    if (!argument.trim() || argument.length > 500 || argument.includes("\0")) {
      throw new Error("Assurance command argument 형식이 잘못됐습니다");
    }
  }
  assertText(command.cwd, "Assurance command cwd");
  if (command.cwd.startsWith("/") || command.cwd.split(/[\\/]/u).includes("..")) {
    throw new Error("Assurance command cwd는 상대 경로여야 합니다");
  }
  if (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1_000 || command.timeoutMs > 3_600_000) {
    throw new Error("Assurance command timeout은 1초 이상 1시간 이하여야 합니다");
  }
  if (!Number.isSafeInteger(command.maxOutputBytes) || command.maxOutputBytes < 1 || command.maxOutputBytes > 10_000_000) {
    throw new Error("Assurance command output limit은 1~10000000 byte여야 합니다");
  }
}

function validateAssuranceRecipe(recipe: EngineeringAssuranceRecipe): void {
  if (recipe.schemaVersion !== "massion.software-assurance-recipe.v1") {
    throw new Error("Software assurance recipe 버전이 올바르지 않습니다");
  }
  validateAssuranceCommand(recipe.focusedCommand);
  if (recipe.validationCommands.length > 20) throw new Error("Assurance validation command는 20개 이하여야 합니다");
  for (const command of recipe.validationCommands) validateAssuranceCommand(command);
  if (redactSecrets(JSON.stringify(recipe)).redactions.length > 0) {
    throw new Error("Assurance recipe에 credential을 저장할 수 없습니다");
  }
}

function decodeAssuranceRecipe(value: string): EngineeringAssuranceRecipe {
  const parsed = JSON.parse(value) as EngineeringAssuranceRecipe;
  validateAssuranceRecipe(parsed);
  return parsed;
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
    await applyMigrations(database, [
      SOFTWARE_ENGINEERING_DELIVERY_MIGRATION,
      SOFTWARE_ENGINEERING_TDD_EVIDENCE_MIGRATION,
      SOFTWARE_ENGINEERING_ROOT_BINDING_MIGRATION,
      SOFTWARE_ENGINEERING_COMMAND_ENVIRONMENT_MIGRATION,
    ]);
    return new EngineeringDeliveryStore(database, organizations, prerequisites);
  }

  public async start(context: TenantContext, input: StartEngineeringDeliveryInput): Promise<EngineeringDeliveryResult> {
    await this.organizations.verifyTenantContext(context);
    this.validateStartInput(input);
    const requestHash = hashRequest({ operation: "start", input });
    const replayed = await this.replay(context.organizationId, input.commandId, requestHash);
    if (replayed) return { delivery: await this.get(context, replayed.deliveryId) };

    const repositoryRootRealPathHash = await this.verifyPrerequisites(context, input);
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const concurrentReplay = await this.replay(context.organizationId, input.commandId, requestHash, tx);
      if (concurrentReplay)
        return { delivery: this.view(await this.find(tx, context.organizationId, concurrentReplay.deliveryId)) };

      const deliveryId = randomUUID();
      const [created] = await tx.query<[DeliveryRecord[]]>(
        "CREATE engineering_delivery CONTENT { delivery_id: $delivery_id, organization_id: $organization_id, work_id: $work_id, task_id: $task_id, assignment_id: $assignment_id, repository_id: $repository_id, repository_revision_id: $repository_revision_id, base_revision: $base_revision, repository_root_real_path_hash: $repository_root_real_path_hash, agent_handle: $agent_handle, profile_version: $profile_version, status: 'preparing', version: 1, start_command_id: $start_command_id, validation_evidence_ids: [], created_by_user_id: $created_by_user_id, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
        {
          delivery_id: deliveryId,
          organization_id: context.organizationId,
          work_id: input.workId,
          task_id: input.taskId,
          assignment_id: input.assignmentId,
          repository_id: input.repositoryId,
          repository_revision_id: input.repositoryRevisionId,
          base_revision: input.baseRevision.trim(),
          repository_root_real_path_hash: repositoryRootRealPathHash,
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

  public async findByStartCommand(context: TenantContext, commandId: string): Promise<EngineeringDelivery | undefined> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[DeliveryRecord[]]>(
      "SELECT * OMIT id FROM engineering_delivery WHERE organization_id = $organization_id AND start_command_id = $start_command_id LIMIT 1;",
      { organization_id: context.organizationId, start_command_id: commandId },
    );
    return records[0] ? this.view(records[0]) : undefined;
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
      const validationEvidenceIds = input.validationEvidenceIds ?? current.validation_evidence_ids;
      if (input.assuranceRecipe) validateAssuranceRecipe(input.assuranceRecipe);
      const assuranceRecipeJson = input.assuranceRecipe
        ? canonicalJson(input.assuranceRecipe)
        : current.assurance_recipe_json;
      if (input.target === "committed") {
        await this.validateCommandEvidenceIds(
          tx,
          context.organizationId,
          input.deliveryId,
          validationEvidenceIds,
          "validation",
        );
      }

      const [updated] = await tx.query<[DeliveryRecord[]]>(
        "UPDATE engineering_delivery SET status = $status, version = $version, workspace_id = $workspace_id, branch_ref = $branch_ref, commit_sha = $commit_sha, test_patch_hash = $test_patch_hash, implementation_patch_hash = $implementation_patch_hash, change_set_hash = $change_set_hash, red_evidence_id = $red_evidence_id, green_evidence_id = $green_evidence_id, validation_evidence_ids = $validation_evidence_ids, assurance_recipe_json = $assurance_recipe_json, artifact_version_id = $artifact_version_id, error_json = $error_json, updated_at = time::now() WHERE organization_id = $organization_id AND delivery_id = $delivery_id AND version = $expected_version RETURN AFTER;",
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
          validation_evidence_ids: validationEvidenceIds,
          assurance_recipe_json: assuranceRecipeJson,
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

  public async recordCommandEvidence(
    context: TenantContext,
    input: {
      readonly deliveryId: string;
      readonly evidenceKey: string;
      readonly evidence: EngineeringCommandEvidence;
    },
  ): Promise<{ readonly commandEvidenceId: string }> {
    await this.organizations.verifyTenantContext(context);
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(input.evidenceKey)) {
      throw new Error("Command evidence key 형식이 잘못됐습니다");
    }
    for (const [label, hash] of [
      ["Arguments hash", input.evidence.argumentsHash],
      ["Environment hash", input.evidence.environmentHash],
      ["Stdout hash", input.evidence.stdoutHash],
      ["Stderr hash", input.evidence.stderrHash],
    ] as const) {
      assertSha256(hash, label);
    }
    const excerptRedaction = redactSecrets(input.evidence.outputExcerpt);
    const evidence = {
      ...input.evidence,
      outputExcerpt: excerptRedaction.content,
      credentialRedacted: input.evidence.credentialRedacted || excerptRedaction.redactions.length > 0,
    };
    const evidenceHash = hashRequest(evidence);
    const commandEvidenceId = hashRequest({
      organizationId: context.organizationId,
      deliveryId: input.deliveryId,
      evidenceKey: input.evidenceKey,
    });
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      await this.find(transaction, context.organizationId, input.deliveryId);
      const [existing] = await transaction.query<[CommandEvidenceRecord[]]>(
        "SELECT command_evidence_id, evidence_hash FROM engineering_command_evidence WHERE organization_id = $organization_id AND command_evidence_id = $command_evidence_id LIMIT 1;",
        { organization_id: context.organizationId, command_evidence_id: commandEvidenceId },
      );
      if (existing[0]) {
        if (existing[0].evidence_hash !== evidenceHash) {
          throw new Error("같은 command evidence key에 다른 evidence를 저장할 수 없습니다");
        }
        return { commandEvidenceId };
      }
      await transaction.query(
        "CREATE engineering_command_evidence CONTENT { command_evidence_id: $command_evidence_id, organization_id: $organization_id, delivery_id: $delivery_id, stage: $stage, executable: $executable, arguments_hash: $arguments_hash, environment_hash: $environment_hash, cwd: $cwd, exit_code: $exit_code, stdout_hash: $stdout_hash, stderr_hash: $stderr_hash, output_excerpt: $output_excerpt, duration_ms: $duration_ms, timed_out: $timed_out, credential_redacted: $credential_redacted, evidence_hash: $evidence_hash, created_at: time::now() };",
        {
          command_evidence_id: commandEvidenceId,
          organization_id: context.organizationId,
          delivery_id: input.deliveryId,
          stage: evidence.stage,
          executable: evidence.executable,
          arguments_hash: evidence.argumentsHash,
          environment_hash: evidence.environmentHash,
          cwd: evidence.cwd,
          exit_code: evidence.exitCode,
          stdout_hash: evidence.stdoutHash,
          stderr_hash: evidence.stderrHash,
          output_excerpt: evidence.outputExcerpt,
          duration_ms: evidence.durationMs,
          timed_out: evidence.timedOut,
          credential_redacted: evidence.credentialRedacted,
          evidence_hash: evidenceHash,
        },
      );
      return { commandEvidenceId };
    });
  }

  public async recordFileChanges(
    context: TenantContext,
    deliveryId: string,
    changes: readonly GitFileChange[],
  ): Promise<{ readonly fileChangeIds: readonly string[] }> {
    await this.organizations.verifyTenantContext(context);
    if (changes.length === 0) throw new Error("하나 이상의 Engineering file change가 필요합니다");
    if (new Set(changes.map((change) => change.relativePath)).size !== changes.length) {
      throw new Error("Engineering file change path가 중복됐습니다");
    }
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      await this.find(transaction, context.organizationId, deliveryId);
      const fileChangeIds: string[] = [];
      for (const change of changes) {
        if (!change.relativePath.trim()) throw new Error("Engineering file change path가 필요합니다");
        if (change.beforeHash) assertGitObjectHash(change.beforeHash, "File before hash");
        if (change.afterHash) assertGitObjectHash(change.afterHash, "File after hash");
        const changeHash = hashRequest(change);
        const fileChangeId = hashRequest({
          organizationId: context.organizationId,
          deliveryId,
          relativePath: change.relativePath,
        });
        const [existing] = await transaction.query<[FileChangeRecord[]]>(
          "SELECT file_change_id, change_hash FROM engineering_file_change WHERE organization_id = $organization_id AND file_change_id = $file_change_id LIMIT 1;",
          { organization_id: context.organizationId, file_change_id: fileChangeId },
        );
        if (existing[0]) {
          if (existing[0].change_hash !== changeHash) {
            throw new Error("같은 file change path에 다른 manifest를 저장할 수 없습니다");
          }
          fileChangeIds.push(fileChangeId);
          continue;
        }
        await transaction.query(
          "CREATE engineering_file_change CONTENT { file_change_id: $file_change_id, organization_id: $organization_id, delivery_id: $delivery_id, relative_path: $relative_path, kind: $kind, before_hash: $before_hash, after_hash: $after_hash, test_file: $test_file, change_hash: $change_hash, created_at: time::now() };",
          {
            file_change_id: fileChangeId,
            organization_id: context.organizationId,
            delivery_id: deliveryId,
            relative_path: change.relativePath,
            kind: change.kind,
            before_hash: change.beforeHash,
            after_hash: change.afterHash,
            test_file: change.testFile,
            change_hash: changeHash,
          },
        );
        fileChangeIds.push(fileChangeId);
      }
      return { fileChangeIds };
    });
  }

  public async listFileChanges(context: TenantContext, deliveryId: string): Promise<GitFileChange[]> {
    await this.organizations.verifyTenantContext(context);
    await this.find(this.database, context.organizationId, deliveryId);
    const [records] = await this.database.query<[FileChangeRecord[]]>(
      "SELECT * OMIT id FROM engineering_file_change WHERE organization_id = $organization_id AND delivery_id = $delivery_id ORDER BY relative_path ASC;",
      { organization_id: context.organizationId, delivery_id: deliveryId },
    );
    return records.map((record) => ({
      relativePath: record.relative_path,
      kind: record.kind,
      ...(record.before_hash ? { beforeHash: record.before_hash } : {}),
      ...(record.after_hash ? { afterHash: record.after_hash } : {}),
      testFile: record.test_file,
    }));
  }

  public async listCommandEvidenceIds(
    context: TenantContext,
    deliveryId: string,
    stage?: EngineeringCommandEvidence["stage"],
  ): Promise<string[]> {
    await this.organizations.verifyTenantContext(context);
    await this.find(this.database, context.organizationId, deliveryId);
    const [records] = await this.database.query<[CommandEvidenceRecord[]]>(
      "SELECT command_evidence_id, stage, created_at FROM engineering_command_evidence WHERE organization_id = $organization_id AND delivery_id = $delivery_id ORDER BY created_at ASC;",
      { organization_id: context.organizationId, delivery_id: deliveryId },
    );
    return records
      .filter((record) => stage === undefined || record.stage === stage)
      .map((record) => record.command_evidence_id);
  }

  public async findRecoveryReplay(
    context: TenantContext,
    input: { readonly commandId: string; readonly deliveryId: string; readonly request: unknown },
  ): Promise<{ readonly deliveryId: string; readonly result: string } | undefined> {
    await this.organizations.verifyTenantContext(context);
    const requestHash = hashRequest({ operation: "recovery", request: input.request });
    const [events] = await this.database.query<[EventRecord[]]>(
      "SELECT request_hash, result_json FROM engineering_delivery_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: context.organizationId, command_id: input.commandId },
    );
    const event = events[0];
    if (!event) return undefined;
    if (event.request_hash !== requestHash) {
      throw new Error("같은 command ID에 다른 recovery 명령을 사용할 수 없습니다");
    }
    const replay = JSON.parse(event.result_json) as { readonly deliveryId: string; readonly result?: string };
    if (replay.deliveryId !== input.deliveryId || !replay.result) {
      throw new Error("Recovery command replay 계보가 잘못됐습니다");
    }
    return { deliveryId: replay.deliveryId, result: replay.result };
  }

  public async recordRecoveryEvent(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly deliveryId: string;
      readonly request: unknown;
      readonly result: string;
    },
  ): Promise<void> {
    await this.organizations.verifyTenantContext(context);
    const requestHash = hashRequest({ operation: "recovery", request: input.request });
    await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const replayed = await this.replay(context.organizationId, input.commandId, requestHash, transaction);
      if (replayed) {
        if (replayed.deliveryId !== input.deliveryId) throw new Error("Recovery command replay 계보가 잘못됐습니다");
        return;
      }
      await this.find(transaction, context.organizationId, input.deliveryId);
      await this.recordEvent(transaction, context, {
        deliveryId: input.deliveryId,
        commandId: input.commandId,
        eventType: "engineering_delivery_recovered",
        requestHash,
        payload: { result: input.result },
        result: { deliveryId: input.deliveryId, result: input.result },
      });
    });
  }

  public async attachArtifactVersion(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly deliveryId: string;
      readonly expectedVersion: number;
      readonly artifactVersionId: string;
    },
  ): Promise<EngineeringDeliveryResult> {
    await this.organizations.verifyTenantContext(context);
    assertText(input.commandId, "Command ID");
    assertText(input.artifactVersionId, "ArtifactVersion ID");
    const requestHash = hashRequest({ operation: "attach-artifact", input });
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const replayed = await this.replay(context.organizationId, input.commandId, requestHash, transaction);
      if (replayed) {
        return { delivery: this.view(await this.find(transaction, context.organizationId, replayed.deliveryId)) };
      }
      const current = await this.find(transaction, context.organizationId, input.deliveryId);
      if (current.artifact_version_id) {
        if (current.artifact_version_id !== input.artifactVersionId) {
          throw new Error("EngineeringDelivery에는 다른 ArtifactVersion이 이미 연결됐습니다");
        }
        return { delivery: this.view(current) };
      }
      if (current.status !== "committed")
        throw new Error("committed Delivery에만 ArtifactVersion을 연결할 수 있습니다");
      if (current.version !== input.expectedVersion) throw new Error("Engineering delivery version 충돌입니다");
      const [updated] = await transaction.query<[DeliveryRecord[]]>(
        "UPDATE engineering_delivery SET artifact_version_id = $artifact_version_id, version = $version, updated_at = time::now() WHERE organization_id = $organization_id AND delivery_id = $delivery_id AND version = $expected_version RETURN AFTER;",
        {
          artifact_version_id: input.artifactVersionId,
          version: current.version + 1,
          organization_id: context.organizationId,
          delivery_id: input.deliveryId,
          expected_version: current.version,
        },
      );
      if (!updated[0]) throw new Error("Engineering delivery version 충돌입니다");
      await this.recordEvent(transaction, context, {
        deliveryId: input.deliveryId,
        commandId: input.commandId,
        eventType: "engineering_artifact_attached",
        requestHash,
        payload: { artifactVersionId: input.artifactVersionId },
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

  private async verifyPrerequisites(context: TenantContext, input: StartEngineeringDeliveryInput): Promise<string> {
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
    if (assignment.status !== "assigned" || assignment.agentHandle !== input.agentHandle) {
      throw new Error("선택된 활성(assigned) Agent assignment가 아닙니다");
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
    assertSha256(repository.rootRealPathHash, "Repository root real path hash");
    assertSha256(revision.rootRealPathHash, "RepositoryRevision root real path hash");
    if (repository.rootRealPathHash !== revision.rootRealPathHash) {
      throw new Error("Repository와 RepositoryRevision root real path hash가 다릅니다");
    }
    return repository.rootRealPathHash;
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

  private async validateCommandEvidenceIds(
    executor: QueryExecutor,
    organizationId: string,
    deliveryId: string,
    evidenceIds: readonly string[],
    stage: EngineeringCommandEvidence["stage"],
  ): Promise<void> {
    if (new Set(evidenceIds).size !== evidenceIds.length) {
      throw new Error(`${stage} command evidence ID가 중복됐습니다`);
    }
    for (const commandEvidenceId of evidenceIds) {
      const [records] = await executor.query<[CommandEvidenceRecord[]]>(
        "SELECT command_evidence_id, delivery_id, stage FROM engineering_command_evidence WHERE organization_id = $organization_id AND command_evidence_id = $command_evidence_id LIMIT 1;",
        { organization_id: organizationId, command_evidence_id: commandEvidenceId },
      );
      const evidence = records[0];
      if (!evidence || evidence.delivery_id !== deliveryId || evidence.stage !== stage) {
        throw new Error(`${stage} command evidence가 delivery 소유·stage 계보와 다릅니다`);
      }
    }
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
      readonly result?: unknown;
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
        result_json: canonicalJson(input.result ?? { deliveryId: input.deliveryId }),
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
    if (!record.repository_root_real_path_hash) {
      throw new Error("EngineeringDelivery에 repository root real path hash가 없습니다");
    }
    return {
      deliveryId: record.delivery_id,
      organizationId: record.organization_id,
      workId: record.work_id,
      taskId: record.task_id,
      assignmentId: record.assignment_id,
      repositoryId: record.repository_id,
      repositoryRevisionId: record.repository_revision_id,
      baseRevision: record.base_revision,
      repositoryRootRealPathHash: record.repository_root_real_path_hash,
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
      ...(record.assurance_recipe_json ? { assuranceRecipe: decodeAssuranceRecipe(record.assurance_recipe_json) } : {}),
      ...(record.artifact_version_id ? { artifactVersionId: record.artifact_version_id } : {}),
      ...(record.error_json ? { error: JSON.parse(record.error_json) as EngineeringDeliveryError } : {}),
      createdByUserId: record.created_by_user_id,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
    };
  }
}
