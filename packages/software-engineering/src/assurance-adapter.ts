import { createHash } from "node:crypto";

import type { OrganizationService, TenantContext } from "@massion/identity";
import type { MassionDatabase, QueryExecutor } from "@massion/storage";
import { redactSecrets } from "@massion/evidence";

import type {
  TrustedAssuranceCheckExecutionInput,
  TrustedAssuranceCheckExecutionResult,
  TrustedAssuranceCheckExecutor,
} from "@massion/assurance";

import { ConfinedCommandRunner, type EngineeringCommandEvidence } from "./command-runner.js";
import {
  GitProvenanceMismatchError,
  GitWorkspaceManager,
  type GitCommitResult,
  type GitFileChange,
  type GitVerificationWorkspace,
} from "./git-workspace.js";

export interface SoftwareAssuranceSource {
  readonly delivery: {
    readonly deliveryId: string;
    readonly organizationId: string;
    readonly workId: string;
    readonly repositoryId: string;
    readonly repositoryRevisionId: string;
    readonly baseRevision: string;
    readonly repositoryRootRealPathHash: string;
    readonly status: string;
    readonly branchRef?: string;
    readonly commitSha?: string;
    readonly changeSetHash?: string;
    readonly artifactVersionId?: string;
    readonly greenEvidenceId?: string;
    readonly validationEvidenceIds: readonly string[];
  };
  readonly artifact: {
    readonly artifactVersionId: string;
    readonly organizationId: string;
    readonly workId: string;
    readonly mediaType: string;
    readonly contentJson: string;
    readonly checksum: string;
  };
  readonly repository: {
    readonly repositoryId: string;
    readonly organizationId: string;
    readonly rootRef: string;
    readonly rootRealPathHash: string;
    readonly status: string;
  };
  readonly revision: {
    readonly repositoryRevisionId: string;
    readonly organizationId: string;
    readonly repositoryId: string;
    readonly providerRevision: string;
    readonly rootRealPathHash: string;
    readonly dirty: boolean;
  };
  readonly commandEvidence: readonly {
    readonly commandEvidenceId: string;
    readonly stage: "green" | "validation";
    readonly executable: string;
    readonly argumentsHash: string;
    readonly environmentHash?: string;
    readonly cwd: string;
    readonly timedOut: boolean;
    readonly credentialRedacted: boolean;
  }[];
}

export interface SoftwareAssuranceSourceReader {
  read(
    context: TenantContext,
    input: { readonly workId: string; readonly artifactVersionId: string },
  ): Promise<SoftwareAssuranceSource>;
}

interface DeliverySourceRecord {
  readonly delivery_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly repository_id: string;
  readonly repository_revision_id: string;
  readonly base_revision: string;
  readonly repository_root_real_path_hash: string;
  readonly status: string;
  readonly branch_ref?: string;
  readonly commit_sha?: string;
  readonly change_set_hash?: string;
  readonly artifact_version_id?: string;
  readonly green_evidence_id?: string;
  readonly validation_evidence_ids: readonly string[];
}

interface ArtifactSourceRecord {
  readonly artifact_version_id: string;
  readonly organization_id: string;
  readonly work_id: string;
  readonly media_type: string;
  readonly content_json: string;
  readonly checksum: string;
}

interface RepositorySourceRecord {
  readonly repository_id: string;
  readonly organization_id: string;
  readonly root_ref: string;
  readonly root_real_path_hash: string;
  readonly status: string;
}

interface RevisionSourceRecord {
  readonly repository_revision_id: string;
  readonly organization_id: string;
  readonly repository_id: string;
  readonly provider_revision: string;
  readonly root_real_path_hash: string;
  readonly dirty: boolean;
}

interface CommandEvidenceSourceRecord {
  readonly command_evidence_id: string;
  readonly stage: "red" | "green" | "validation";
  readonly executable: string;
  readonly arguments_hash: string;
  readonly environment_hash?: string;
  readonly cwd: string;
  readonly timed_out: boolean;
  readonly credential_redacted?: boolean;
}

export class DatabaseSoftwareAssuranceSourceReader implements SoftwareAssuranceSourceReader {
  public constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public async read(
    context: TenantContext,
    input: { readonly workId: string; readonly artifactVersionId: string },
  ): Promise<SoftwareAssuranceSource> {
    await this.organizations.verifyTenantContext(context);
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      return await this.readWith(transaction, context.organizationId, input);
    });
  }

  private async readWith(
    executor: QueryExecutor,
    organizationId: string,
    input: { readonly workId: string; readonly artifactVersionId: string },
  ): Promise<SoftwareAssuranceSource> {
    const [works] = await executor.query<[{ work_id: string }[]]>(
      "SELECT work_id FROM work WHERE organization_id = $organization_id AND work_id = $work_id AND $artifact_version_id IN artifact_version_ids LIMIT 1;",
      {
        organization_id: organizationId,
        work_id: input.workId,
        artifact_version_id: input.artifactVersionId,
      },
    );
    const [deliveries] = await executor.query<[DeliverySourceRecord[]]>(
      "SELECT delivery_id, organization_id, work_id, repository_id, repository_revision_id, base_revision, repository_root_real_path_hash, status, branch_ref, commit_sha, change_set_hash, artifact_version_id, green_evidence_id, validation_evidence_ids FROM engineering_delivery WHERE organization_id = $organization_id AND work_id = $work_id AND artifact_version_id = $artifact_version_id;",
      {
        organization_id: organizationId,
        work_id: input.workId,
        artifact_version_id: input.artifactVersionId,
      },
    );
    const [artifacts] = await executor.query<[ArtifactSourceRecord[]]>(
      "SELECT artifact_version_id, organization_id, work_id, media_type, content_json, checksum FROM artifact_version WHERE organization_id = $organization_id AND work_id = $work_id AND artifact_version_id = $artifact_version_id LIMIT 1;",
      {
        organization_id: organizationId,
        work_id: input.workId,
        artifact_version_id: input.artifactVersionId,
      },
    );
    const delivery = deliveries[0];
    const artifact = artifacts[0];
    if (!works[0] || deliveries.length !== 1 || !delivery || !artifact) {
      throw new Error("Software assurance source를 찾을 수 없습니다");
    }
    const [repositories] = await executor.query<[RepositorySourceRecord[]]>(
      "SELECT repository_id, organization_id, root_ref, root_real_path_hash, status FROM evidence_repository WHERE organization_id = $organization_id AND repository_id = $repository_id LIMIT 1;",
      { organization_id: organizationId, repository_id: delivery.repository_id },
    );
    const [revisions] = await executor.query<[RevisionSourceRecord[]]>(
      "SELECT repository_revision_id, organization_id, repository_id, provider_revision, root_real_path_hash, dirty FROM repository_revision WHERE organization_id = $organization_id AND repository_id = $repository_id AND repository_revision_id = $repository_revision_id LIMIT 1;",
      {
        organization_id: organizationId,
        repository_id: delivery.repository_id,
        repository_revision_id: delivery.repository_revision_id,
      },
    );
    const repository = repositories[0];
    const revision = revisions[0];
    if (!repository || !revision) throw new Error("Software assurance source repository를 찾을 수 없습니다");
    const evidenceIds = [
      ...(delivery.green_evidence_id ? [delivery.green_evidence_id] : []),
      ...delivery.validation_evidence_ids,
    ];
    const [commandEvidence] = await executor.query<[CommandEvidenceSourceRecord[]]>(
      "SELECT command_evidence_id, stage, executable, arguments_hash, environment_hash, cwd, timed_out, credential_redacted FROM engineering_command_evidence WHERE organization_id = $organization_id AND delivery_id = $delivery_id AND command_evidence_id IN $evidence_ids;",
      {
        organization_id: organizationId,
        delivery_id: delivery.delivery_id,
        evidence_ids: evidenceIds,
      },
    );
    if (
      new Set(evidenceIds).size !== evidenceIds.length ||
      commandEvidence.length !== evidenceIds.length ||
      commandEvidence.some((evidence) => !["green", "validation"].includes(evidence.stage))
    ) {
      throw new Error("Software assurance source command evidence를 찾을 수 없습니다");
    }
    return {
      delivery: {
        deliveryId: delivery.delivery_id,
        organizationId: delivery.organization_id,
        workId: delivery.work_id,
        repositoryId: delivery.repository_id,
        repositoryRevisionId: delivery.repository_revision_id,
        baseRevision: delivery.base_revision,
        repositoryRootRealPathHash: delivery.repository_root_real_path_hash,
        status: delivery.status,
        ...(delivery.branch_ref ? { branchRef: delivery.branch_ref } : {}),
        ...(delivery.commit_sha ? { commitSha: delivery.commit_sha } : {}),
        ...(delivery.change_set_hash ? { changeSetHash: delivery.change_set_hash } : {}),
        ...(delivery.artifact_version_id ? { artifactVersionId: delivery.artifact_version_id } : {}),
        ...(delivery.green_evidence_id ? { greenEvidenceId: delivery.green_evidence_id } : {}),
        validationEvidenceIds: delivery.validation_evidence_ids,
      },
      artifact: {
        artifactVersionId: artifact.artifact_version_id,
        organizationId: artifact.organization_id,
        workId: artifact.work_id,
        mediaType: artifact.media_type,
        contentJson: artifact.content_json,
        checksum: artifact.checksum,
      },
      repository: {
        repositoryId: repository.repository_id,
        organizationId: repository.organization_id,
        rootRef: repository.root_ref,
        rootRealPathHash: repository.root_real_path_hash,
        status: repository.status,
      },
      revision: {
        repositoryRevisionId: revision.repository_revision_id,
        organizationId: revision.organization_id,
        repositoryId: revision.repository_id,
        providerRevision: revision.provider_revision,
        rootRealPathHash: revision.root_real_path_hash,
        dirty: revision.dirty,
      },
      commandEvidence: commandEvidence.map((evidence) => ({
        commandEvidenceId: evidence.command_evidence_id,
        stage: evidence.stage === "green" ? "green" : "validation",
        executable: evidence.executable,
        argumentsHash: evidence.arguments_hash,
        ...(evidence.environment_hash ? { environmentHash: evidence.environment_hash } : {}),
        cwd: evidence.cwd,
        timedOut: evidence.timed_out,
        credentialRedacted: evidence.credential_redacted ?? false,
      })),
    };
  }
}

type SoftwareCommandBinding = TrustedAssuranceCheckExecutionInput["binding"] & {
  readonly environmentName?: string;
  readonly timeoutOutcome?: "blocked" | "failed";
  readonly outputLimitOutcome?: "blocked" | "failed";
  readonly verifyDeterministicOutput?: boolean;
};

export interface SoftwareAssuranceExecutionInput extends Omit<
  TrustedAssuranceCheckExecutionInput,
  "binding" | "evidenceBriefIds" | "metricObservationIds" | "humanAttestationIds"
> {
  readonly binding: SoftwareCommandBinding;
  readonly evidenceBriefIds?: readonly string[];
  readonly metricObservationIds?: readonly string[];
  readonly humanAttestationIds?: readonly string[];
}

export type SoftwareAssuranceExecutionResult = TrustedAssuranceCheckExecutionResult;

export interface SoftwareCodeChangeManifest {
  readonly schemaVersion: "massion.code-change-manifest.v1";
  readonly deliveryId: string;
  readonly repositoryId: string;
  readonly repositoryRevisionId: string;
  readonly baseRevision: string;
  readonly branchRef: string;
  readonly commitSha: string;
  readonly changeSetHash: string;
  readonly evidence: {
    readonly red: string;
    readonly green: string;
    readonly validations: readonly string[];
  };
  readonly files: readonly {
    readonly relativePath: string;
    readonly kind: GitFileChange["kind"];
    readonly beforeHash?: string;
    readonly afterHash?: string;
    readonly testFile: boolean;
  }[];
}

class MissingCommandEnvironmentEvidenceError extends Error {}

interface AdapterOptions {
  readonly workspaceRoot: string;
  readonly executables: Readonly<Record<string, string>>;
  readonly environmentProfiles: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly pathDirectories?: readonly string[];
  readonly maxTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxExcerptBytes: number;
}

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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseSoftwareCodeChangeManifest(value: string): SoftwareCodeChangeManifest {
  const decoded = JSON.parse(value) as Partial<SoftwareCodeChangeManifest>;
  if (
    decoded.schemaVersion !== "massion.code-change-manifest.v1" ||
    typeof decoded.deliveryId !== "string" ||
    typeof decoded.repositoryId !== "string" ||
    typeof decoded.repositoryRevisionId !== "string" ||
    typeof decoded.baseRevision !== "string" ||
    typeof decoded.branchRef !== "string" ||
    typeof decoded.commitSha !== "string" ||
    typeof decoded.changeSetHash !== "string" ||
    !decoded.evidence ||
    typeof decoded.evidence.red !== "string" ||
    typeof decoded.evidence.green !== "string" ||
    !Array.isArray(decoded.evidence.validations) ||
    !Array.isArray(decoded.files)
  ) {
    throw new Error("Code-change manifest 형식이 올바르지 않습니다");
  }
  return decoded as SoftwareCodeChangeManifest;
}

export function normalizedSoftwareFileChanges(changes: readonly GitFileChange[]): SoftwareCodeChangeManifest["files"] {
  return changes.map((change) => ({
    relativePath: change.relativePath,
    kind: change.kind,
    ...(change.beforeHash ? { beforeHash: change.beforeHash } : {}),
    ...(change.afterHash ? { afterHash: change.afterHash } : {}),
    testFile: change.testFile,
  }));
}

export function verifySoftwareAssuranceSource(
  context: TenantContext,
  input: { readonly workId: string; readonly artifactVersionId: string },
  source: SoftwareAssuranceSource,
): SoftwareCodeChangeManifest {
  const { delivery, artifact, repository, revision } = source;
  if (
    delivery.organizationId !== context.organizationId ||
    artifact.organizationId !== context.organizationId ||
    repository.organizationId !== context.organizationId ||
    revision.organizationId !== context.organizationId ||
    delivery.workId !== input.workId ||
    artifact.workId !== input.workId ||
    artifact.artifactVersionId !== input.artifactVersionId
  ) {
    throw new Error("Software assurance source의 tenant·Work 소유권이 일치하지 않습니다");
  }
  if (
    delivery.status !== "committed" ||
    delivery.artifactVersionId !== artifact.artifactVersionId ||
    delivery.repositoryId !== repository.repositoryId ||
    delivery.repositoryRevisionId !== revision.repositoryRevisionId ||
    revision.repositoryId !== repository.repositoryId ||
    repository.status !== "active" ||
    revision.dirty
  ) {
    throw new Error("Software assurance delivery·repository 정본 상태가 유효하지 않습니다");
  }
  if (
    artifact.mediaType !== "application/vnd.massion.code-change-manifest+json" ||
    artifact.checksum !== sha256(artifact.contentJson)
  ) {
    throw new Error("Code-change ArtifactVersion checksum 또는 media type이 유효하지 않습니다");
  }
  if (
    delivery.repositoryRootRealPathHash !== repository.rootRealPathHash ||
    revision.rootRealPathHash !== repository.rootRealPathHash ||
    revision.providerRevision !== delivery.baseRevision
  ) {
    throw new Error("Repository realpath·revision provenance가 delivery와 일치하지 않습니다");
  }
  const manifest = parseSoftwareCodeChangeManifest(artifact.contentJson);
  if (
    manifest.deliveryId !== delivery.deliveryId ||
    manifest.repositoryId !== delivery.repositoryId ||
    manifest.repositoryRevisionId !== delivery.repositoryRevisionId ||
    manifest.baseRevision !== delivery.baseRevision ||
    manifest.branchRef !== delivery.branchRef ||
    manifest.commitSha !== delivery.commitSha ||
    manifest.changeSetHash !== delivery.changeSetHash ||
    manifest.evidence.green !== delivery.greenEvidenceId ||
    canonicalJson(manifest.evidence.validations) !== canonicalJson(delivery.validationEvidenceIds)
  ) {
    throw new Error("Code-change manifest가 committed delivery와 일치하지 않습니다");
  }
  return manifest;
}

function reproducibleEvidence(evidence: EngineeringCommandEvidence): Omit<EngineeringCommandEvidence, "durationMs"> {
  const { durationMs: _durationMs, ...reproducible } = evidence;
  void _durationMs;
  return reproducible;
}

function outputHash(input: {
  readonly source: SoftwareAssuranceSource;
  readonly binding: SoftwareAssuranceExecutionInput["binding"];
  readonly version: EngineeringCommandEvidence;
  readonly command: EngineeringCommandEvidence;
  readonly replay?: EngineeringCommandEvidence;
  readonly environmentHash: string;
  readonly status: SoftwareAssuranceExecutionResult["status"];
}): string {
  return sha256(
    canonicalJson({
      deliveryId: input.source.delivery.deliveryId,
      artifactVersionId: input.source.artifact.artifactVersionId,
      commitSha: input.source.delivery.commitSha,
      changeSetHash: input.source.delivery.changeSetHash,
      bindingKey: input.binding.bindingKey,
      environmentHash: input.environmentHash,
      version: reproducibleEvidence(input.version),
      command: reproducibleEvidence(input.command),
      ...(input.replay ? { replay: reproducibleEvidence(input.replay) } : {}),
      status: input.status,
    }),
  );
}

function classifiedResult(
  status: "failed" | "blocked",
  input: SoftwareAssuranceExecutionInput,
  category: string,
): SoftwareAssuranceExecutionResult {
  return {
    status,
    outputHash: sha256(
      canonicalJson({
        status,
        category,
        workId: input.workId,
        assuranceRunId: input.assuranceRunId,
        criterionId: input.criterionId,
        bindingKey: input.binding.bindingKey,
        artifactVersionIds: [...input.artifactVersionIds].sort(),
      }),
    ),
    summary: status === "failed" ? "Software provenance 검증에 실패했습니다" : "Software check 실행이 차단됐습니다",
    toolName: input.binding.executable,
    toolVersion: "unavailable",
    durationMs: 0,
    artifactVersionIds: [...input.artifactVersionIds],
  };
}

export class SoftwareAssuranceAdapter implements TrustedAssuranceCheckExecutor {
  public readonly adapterId = "massion.software-command.v1";

  private constructor(
    private readonly reader: SoftwareAssuranceSourceReader,
    private readonly manager: GitWorkspaceManager,
    private readonly options: AdapterOptions,
  ) {}

  public static async create(
    reader: SoftwareAssuranceSourceReader,
    options: AdapterOptions,
  ): Promise<SoftwareAssuranceAdapter> {
    const manager = await GitWorkspaceManager.create({ workspaceRoot: options.workspaceRoot });
    if (!options.environmentProfiles.default) throw new Error("Default assurance environment profile이 필요합니다");
    for (const [name, profile] of Object.entries(options.environmentProfiles)) {
      if (!/^[a-z][a-z0-9._-]*$/u.test(name)) throw new Error("Assurance environment profile 이름이 올바르지 않습니다");
      if (redactSecrets(JSON.stringify(profile)).redactions.length > 0) {
        throw new Error("Assurance environment profile에는 credential을 저장할 수 없습니다");
      }
    }
    return new SoftwareAssuranceAdapter(reader, manager, options);
  }

  public async execute(
    context: TenantContext,
    input: SoftwareAssuranceExecutionInput,
  ): Promise<SoftwareAssuranceExecutionResult> {
    if (input.binding.executor.kind !== "system_adapter" || input.binding.executor.adapterId !== this.adapterId) {
      throw new Error("Software assurance binding executor가 adapter와 일치하지 않습니다");
    }
    if (input.artifactVersionIds.length !== 1) {
      throw new Error("Software assurance command에는 code-change ArtifactVersion 하나가 필요합니다");
    }
    let source: SoftwareAssuranceSource;
    try {
      source = await this.reader.read(context, {
        workId: input.workId,
        artifactVersionId: input.artifactVersionIds[0] ?? "",
      });
    } catch {
      return classifiedResult("blocked", input, "source_unavailable");
    }
    let manifest: SoftwareCodeChangeManifest;
    const environment = this.options.environmentProfiles[input.binding.environmentName ?? "default"];
    if (!environment) return classifiedResult("blocked", input, "environment_unavailable");
    const environmentHash = sha256(canonicalJson(environment));
    try {
      manifest = verifySoftwareAssuranceSource(
        context,
        { workId: input.workId, artifactVersionId: input.artifactVersionIds[0] ?? "" },
        source,
      );
      const argumentRedaction = redactSecrets(JSON.stringify(input.binding.args));
      const recipe = source.commandEvidence.find(
        (evidence) =>
          evidence.executable === input.binding.executable &&
          evidence.argumentsHash === sha256(JSON.stringify(input.binding.args)) &&
          evidence.cwd === input.binding.cwd &&
          !evidence.timedOut &&
          !evidence.credentialRedacted,
      );
      if (
        !recipe ||
        argumentRedaction.redactions.length > 0 ||
        !input.binding.requiredEvidenceKinds.includes("command-output") ||
        !input.binding.requiredEvidenceKinds.includes("code-change")
      ) {
        throw new Error("Assurance binding recipe가 delivery command evidence와 일치하지 않습니다");
      }
      if (recipe.environmentHash === undefined) {
        throw new MissingCommandEnvironmentEvidenceError("Legacy command evidence에 environment hash가 없습니다");
      }
      if (!/^[a-f0-9]{64}$/u.test(recipe.environmentHash) || recipe.environmentHash !== environmentHash) {
        throw new Error("Assurance environment profile이 delivery command evidence와 일치하지 않습니다");
      }
    } catch (error) {
      return classifiedResult(
        error instanceof MissingCommandEnvironmentEvidenceError ? "blocked" : "failed",
        input,
        error instanceof MissingCommandEnvironmentEvidenceError
          ? "recipe_environment_unavailable"
          : "provenance_invalid",
      );
    }
    let branch: GitCommitResult | undefined;
    try {
      await this.manager.verifyRepositoryRoot(source.repository.rootRef, source.repository.rootRealPathHash);
      branch = await this.manager.inspectDeliveryBranch({
        repositoryRoot: source.repository.rootRef,
        baseRevision: source.delivery.baseRevision,
        deliveryId: source.delivery.deliveryId,
      });
    } catch (error) {
      return classifiedResult(
        error instanceof GitProvenanceMismatchError ? "failed" : "blocked",
        input,
        error instanceof GitProvenanceMismatchError ? "provenance_invalid" : "provenance_unavailable",
      );
    }
    if (
      !branch ||
      branch.branchRef !== manifest.branchRef ||
      branch.commitSha !== manifest.commitSha ||
      branch.changeSetHash !== manifest.changeSetHash ||
      canonicalJson(normalizedSoftwareFileChanges(branch.fileChanges)) !== canonicalJson(manifest.files)
    ) {
      return classifiedResult("failed", input, "provenance_invalid");
    }
    let workspace: GitVerificationWorkspace;
    try {
      workspace = await this.manager.prepareDetachedVerification({
        repositoryRoot: source.repository.rootRef,
        targetRevision: manifest.commitSha,
        verificationId: input.verificationId,
      });
    } catch {
      return classifiedResult("blocked", input, "workspace_unavailable");
    }
    let workspaceRemoved = false;
    let replayWorkspace: GitVerificationWorkspace | undefined;
    try {
      try {
        const runner = await this.commandRunner(workspace.workspacePath, environment);
        const version = await runner.run({
          stage: "validation",
          executable: input.binding.executable,
          args: ["--version"],
          cwd: ".",
          timeoutMs: Math.min(5_000, this.options.maxTimeoutMs),
          maxOutputBytes: Math.min(16_384, this.options.maxOutputBytes),
          environment,
        });
        if (
          version.evidence.timedOut ||
          version.evidence.outputLimited ||
          version.evidence.credentialRedacted ||
          version.evidence.exitCode !== 0 ||
          !version.output.trim()
        ) {
          throw new Error("Assurance command tool version을 확인할 수 없습니다");
        }
        const command = await runner.run({
          stage: "validation",
          executable: input.binding.executable,
          args: input.binding.args,
          cwd: input.binding.cwd,
          timeoutMs: input.binding.timeoutMs,
          maxOutputBytes: input.binding.maxOutputBytes,
          environment,
        });
        const commandWorkspaceClean = await this.manager.verifyDetachedVerificationClean(workspace);
        let replay: Awaited<ReturnType<ConfinedCommandRunner["run"]>> | undefined;
        let replayWorkspaceClean = true;
        if (input.binding.verifyDeterministicOutput) {
          await this.manager.removeDetachedVerification(workspace);
          workspaceRemoved = true;
          replayWorkspace = await this.manager.prepareDetachedVerification({
            repositoryRoot: source.repository.rootRef,
            targetRevision: manifest.commitSha,
            verificationId: `${input.verificationId}-replay`,
          });
          const replayRunner = await this.commandRunner(replayWorkspace.workspacePath, environment);
          replay = await replayRunner.run({
            stage: "validation",
            executable: input.binding.executable,
            args: input.binding.args,
            cwd: input.binding.cwd,
            timeoutMs: input.binding.timeoutMs,
            maxOutputBytes: input.binding.maxOutputBytes,
            environment,
          });
          replayWorkspaceClean = await this.manager.verifyDetachedVerificationClean(replayWorkspace);
        }
        const commandEvidence = replay ? [command.evidence, replay.evidence] : [command.evidence];
        const boundedFailure =
          (commandEvidence.some((evidence) => evidence.timedOut) && input.binding.timeoutOutcome === "failed") ||
          (commandEvidence.some((evidence) => evidence.outputLimited) && input.binding.outputLimitOutcome === "failed");
        const bounded = commandEvidence.some((evidence) => evidence.timedOut || evidence.outputLimited);
        const explicitFailure = commandEvidence.some(
          (evidence) =>
            evidence.credentialRedacted ||
            (!evidence.timedOut && !evidence.outputLimited && evidence.exitCode !== input.binding.expectedExitCode),
        );
        const nondeterministic = Boolean(
          replay &&
          canonicalJson(reproducibleEvidence(command.evidence)) !==
            canonicalJson(reproducibleEvidence(replay.evidence)),
        );
        const workspaceMutated = !commandWorkspaceClean || !replayWorkspaceClean;
        const status =
          explicitFailure || boundedFailure
            ? "failed"
            : bounded || nondeterministic || workspaceMutated
              ? "blocked"
              : "passed";
        const toolVersion = version.output.trim().split(/\r?\n/u)[0]?.slice(0, 200) ?? "unknown";
        return {
          status,
          outputHash: outputHash({
            source,
            binding: input.binding,
            version: version.evidence,
            command: command.evidence,
            ...(replay ? { replay: replay.evidence } : {}),
            environmentHash,
            status,
          }),
          summary: nondeterministic
            ? `${input.binding.executable} nondeterministic output blocked`
            : workspaceMutated
              ? `${input.binding.executable} verification workspace mutation blocked`
              : `${input.binding.executable} exit ${String(command.evidence.exitCode ?? "signal")} env ${environmentHash}`,
          toolName: input.binding.executable,
          toolVersion,
          durationMs: command.evidence.durationMs + (replay?.evidence.durationMs ?? 0),
          artifactVersionIds: [source.artifact.artifactVersionId],
        };
      } catch {
        return classifiedResult("blocked", input, "command_unavailable");
      }
    } finally {
      if (replayWorkspace) await this.manager.removeDetachedVerification(replayWorkspace);
      if (!workspaceRemoved) await this.manager.removeDetachedVerification(workspace);
    }
  }

  private async commandRunner(
    workspaceRoot: string,
    environment: Readonly<Record<string, string>>,
  ): Promise<ConfinedCommandRunner> {
    return await ConfinedCommandRunner.create({
      workspaceRoot,
      executables: this.options.executables,
      environmentAllowlist: Object.keys(environment),
      ...(this.options.pathDirectories ? { pathDirectories: this.options.pathDirectories } : {}),
      maxTimeoutMs: this.options.maxTimeoutMs,
      maxOutputBytes: this.options.maxOutputBytes,
      maxExcerptBytes: this.options.maxExcerptBytes,
    });
  }

}
