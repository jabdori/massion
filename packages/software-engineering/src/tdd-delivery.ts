import { createHash } from "node:crypto";

import { redactSecrets } from "@massion/evidence";
import type { TenantContext } from "@massion/identity";

import type { EngineeringDelivery } from "./contracts.js";
import type { EngineeringAssuranceRecipe } from "./contracts.js";
import type { ConfinedCommandInput, ConfinedCommandResult, EngineeringCommandStage } from "./command-runner.js";
import { EngineeringDeliveryStore } from "./delivery-store.js";
import { GitWorkspaceManager, type GitCommitResult, type GitDeliveryWorkspace } from "./git-workspace.js";
import { validateUnifiedPatch } from "./patch.js";
import {
  EngineeringPathLeaseOwnershipError,
  type EngineeringPathLeaseStore,
  normalizeEngineeringPaths,
} from "./path-lease.js";

export interface EngineeringCommandRunner {
  run(input: ConfinedCommandInput): Promise<ConfinedCommandResult>;
}

export interface EngineeringCommandRunnerFactory {
  create(workspaceRoot: string): Promise<EngineeringCommandRunner>;
}

type CommandSpecification = Omit<ConfinedCommandInput, "stage">;

export interface TddDeliveryInput {
  readonly deliveryId: string;
  readonly repositoryRoot: string;
  readonly testPatch: string;
  readonly implementationPatch: string;
  readonly allowedPaths: readonly string[];
  readonly testPaths: readonly string[];
  readonly focusedCommand: CommandSpecification;
  readonly redFailureMarker: string;
  readonly validationCommands: readonly CommandSpecification[];
  readonly commitMessage: string;
  readonly allowImplementationTestChanges?: boolean;
  readonly signal?: AbortSignal;
  readonly pathLease?: {
    readonly leaseId: string;
    readonly ownerCommandId: string;
    readonly version: number;
    readonly ttlMs: number;
  };
}

export interface TddDeliveryResult {
  readonly delivery: EngineeringDelivery;
  readonly commit: GitCommitResult;
}

class DeliveryExecutionError extends Error {
  public constructor(
    public readonly category: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DeliveryExecutionError";
  }
}

function causeId(error: unknown): string {
  const value = error instanceof Error ? `${error.name}:${error.message}` : "Unknown delivery error";
  return createHash("sha256").update(value).digest("hex");
}

function belongsTo(paths: readonly string[], candidate: string): boolean {
  return paths.some((path) => path === "." || candidate === path || candidate.startsWith(`${path}/`));
}

export class TddDeliveryEngine {
  public constructor(
    private readonly deliveries: EngineeringDeliveryStore,
    private readonly workspaces: GitWorkspaceManager,
    private readonly runners: EngineeringCommandRunnerFactory,
    private readonly leases?: Pick<EngineeringPathLeaseStore, "renew">,
  ) {}

  public async execute(context: TenantContext, input: TddDeliveryInput): Promise<TddDeliveryResult> {
    let delivery = await this.deliveries.get(context, input.deliveryId);
    if (delivery.status !== "preparing") {
      throw new Error(`preparing Delivery만 TDD 실행할 수 있습니다: ${delivery.status}`);
    }
    await this.workspaces.verifyRepositoryRoot(input.repositoryRoot, delivery.repositoryRootRealPathHash);
    let leaseVersion = input.pathLease?.version;
    const renewOwnership = async (): Promise<void> => {
      if (input.signal?.aborted) {
        throw new EngineeringPathLeaseOwnershipError("TDD owner 실행이 중지됐습니다");
      }
      if (!input.pathLease) return;
      if (!this.leases || leaseVersion === undefined) {
        throw new EngineeringPathLeaseOwnershipError("TDD path lease 검증기가 구성되지 않았습니다");
      }
      leaseVersion = (
        await this.leases.renew(context, {
          leaseId: input.pathLease.leaseId,
          deliveryId: delivery.deliveryId,
          repositoryId: delivery.repositoryId,
          expectedVersion: leaseVersion,
          ttlMs: input.pathLease.ttlMs,
        })
      ).lease.version;
    };
    const ownership = () =>
      input.pathLease
        ? { leaseId: input.pathLease.leaseId, ownerCommandId: input.pathLease.ownerCommandId }
        : undefined;
    const runCommand = async (
      runner: EngineeringCommandRunner,
      command: CommandSpecification,
      stage: EngineeringCommandStage,
    ): Promise<ConfinedCommandResult> => {
      const controller = new AbortController();
      const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
      let stopped = false;
      let timer: NodeJS.Timeout | undefined;
      let heartbeat: Promise<void> | undefined;
      let heartbeatError: unknown;
      const schedule = (): void => {
        if (!input.pathLease) return;
        timer = setTimeout(
          () => {
            heartbeat = renewOwnership()
              .catch((error: unknown) => {
                heartbeatError = error;
                controller.abort(error);
              })
              .finally(() => {
                if (!stopped && heartbeatError === undefined) schedule();
              });
          },
          Math.max(1, Math.floor(input.pathLease.ttlMs / 2)),
        );
        timer.unref();
      };
      schedule();
      try {
        try {
          const result = await runner.run({ ...command, stage, signal });
          if (heartbeat) await heartbeat;
          if (heartbeatError !== undefined) throw heartbeatError;
          return result;
        } catch (error) {
          if (heartbeat) await heartbeat;
          if (error instanceof Error && error.name === "EngineeringCommandCleanupError") throw error;
          throw heartbeatError ?? error;
        }
      } finally {
        stopped = true;
        if (timer) clearTimeout(timer);
        if (heartbeat) await heartbeat;
      }
    };
    let workspace: GitDeliveryWorkspace | undefined;
    let committed: GitCommitResult | undefined;
    try {
      this.validateMarker(input.redFailureMarker);
      this.assertNoCredential(input.testPatch, "Test patch");
      this.assertNoCredential(input.implementationPatch, "Implementation patch");
      const testPatch = validateUnifiedPatch(input.testPatch, { allowedPaths: input.allowedPaths });
      const implementationPatch = validateUnifiedPatch(input.implementationPatch, {
        allowedPaths: input.allowedPaths,
      });
      const testPaths = normalizeEngineeringPaths(input.testPaths);
      if (!testPatch.paths.every((path) => belongsTo(testPaths, path))) {
        throw new DeliveryExecutionError("test_patch_scope", "Test patch는 지정된 test path만 변경해야 합니다");
      }
      if (
        !input.allowImplementationTestChanges &&
        implementationPatch.paths.some((path) => belongsTo(testPaths, path))
      ) {
        throw new DeliveryExecutionError(
          "implementation_test_rewrite",
          "Implementation patch는 test file을 다시 수정할 수 없습니다",
        );
      }

      await renewOwnership();
      workspace = await this.workspaces.prepare({
        repositoryRoot: input.repositoryRoot,
        baseRevision: delivery.baseRevision,
        deliveryId: delivery.deliveryId,
      });
      await renewOwnership();
      const runner = await this.runners.create(workspace.workspacePath);
      await renewOwnership();
      const appliedTest = await this.workspaces.applyPatch(workspace, testPatch);
      await renewOwnership();
      delivery = (
        await this.deliveries.transition(context, {
          commandId: `${delivery.startCommandId}:test-applied`,
          deliveryId: delivery.deliveryId,
          expectedVersion: delivery.version,
          target: "test_applied",
          workspaceId: delivery.deliveryId,
          testPatchHash: appliedTest.changeSetHash,
          ...(ownership() === undefined ? {} : { ownership: ownership() }),
        })
      ).delivery;

      await renewOwnership();
      const red = await runCommand(runner, input.focusedCommand, "red");
      await renewOwnership();
      const redEvidenceId = (
        await this.deliveries.recordCommandEvidence(context, {
          deliveryId: delivery.deliveryId,
          evidenceKey: "red",
          evidence: red.evidence,
          ...(ownership() === undefined ? {} : { ownership: ownership() }),
        })
      ).commandEvidenceId;
      await renewOwnership();
      await this.workspaces.verifyNoUnstagedChanges(workspace);
      if (red.evidence.credentialRedacted) {
        throw new DeliveryExecutionError("credential_output", "RED command output에서 credential이 감지됐습니다");
      }
      if (red.evidence.timedOut || red.evidence.outputLimited || red.evidence.exitCode === undefined) {
        throw new DeliveryExecutionError(
          "red_command_failed",
          "RED command가 정상적인 test failure가 아닌 timeout·signal·output limit으로 종료됐습니다",
        );
      }
      if (red.evidence.exitCode === 0) {
        throw new DeliveryExecutionError("false_red", "Test patch가 기존 구현에서 실패하지 않아 false red입니다");
      }
      if (!red.output.includes(input.redFailureMarker)) {
        throw new DeliveryExecutionError("red_marker_mismatch", "RED output에 지정 failure marker가 없습니다");
      }
      await renewOwnership();
      delivery = (
        await this.deliveries.transition(context, {
          commandId: `${delivery.startCommandId}:red-verified`,
          deliveryId: delivery.deliveryId,
          expectedVersion: delivery.version,
          target: "red_verified",
          redEvidenceId,
          ...(ownership() === undefined ? {} : { ownership: ownership() }),
        })
      ).delivery;

      await renewOwnership();
      const appliedImplementation = await this.workspaces.applyPatch(workspace, implementationPatch);
      await renewOwnership();
      delivery = (
        await this.deliveries.transition(context, {
          commandId: `${delivery.startCommandId}:implementation-applied`,
          deliveryId: delivery.deliveryId,
          expectedVersion: delivery.version,
          target: "implementation_applied",
          implementationPatchHash: appliedImplementation.changeSetHash,
          ...(ownership() === undefined ? {} : { ownership: ownership() }),
        })
      ).delivery;

      await renewOwnership();
      const green = await runCommand(runner, input.focusedCommand, "green");
      await renewOwnership();
      const greenEvidenceId = (
        await this.deliveries.recordCommandEvidence(context, {
          deliveryId: delivery.deliveryId,
          evidenceKey: "green",
          evidence: green.evidence,
          ...(ownership() === undefined ? {} : { ownership: ownership() }),
        })
      ).commandEvidenceId;
      await renewOwnership();
      await this.workspaces.verifyNoUnstagedChanges(workspace);
      this.assertCommandSuccess(green, "green_failed", "Focused test GREEN이 실패했습니다");
      await renewOwnership();
      delivery = (
        await this.deliveries.transition(context, {
          commandId: `${delivery.startCommandId}:green-verified`,
          deliveryId: delivery.deliveryId,
          expectedVersion: delivery.version,
          target: "green_verified",
          greenEvidenceId,
          ...(ownership() === undefined ? {} : { ownership: ownership() }),
        })
      ).delivery;

      const validationEvidenceIds: string[] = [];
      for (const [index, command] of input.validationCommands.entries()) {
        await renewOwnership();
        const validation = await runCommand(runner, command, "validation");
        await renewOwnership();
        validationEvidenceIds.push(
          (
            await this.deliveries.recordCommandEvidence(context, {
              deliveryId: delivery.deliveryId,
              evidenceKey: `validation-${String(index).padStart(3, "0")}`,
              evidence: validation.evidence,
              ...(ownership() === undefined ? {} : { ownership: ownership() }),
            })
          ).commandEvidenceId,
        );
        await renewOwnership();
        await this.workspaces.verifyNoUnstagedChanges(workspace);
        this.assertCommandSuccess(
          validation,
          "validation_failed",
          `Validation command ${String(index + 1)}이 실패했습니다`,
        );
      }

      const assuranceRecipe = this.assuranceRecipe(input);

      await renewOwnership();
      committed = await this.workspaces.commit(workspace, {
        message: input.commitMessage,
        expectedPaths: [...new Set([...testPatch.paths, ...implementationPatch.paths])],
      });
      await renewOwnership();
      await this.deliveries.recordFileChanges(context, delivery.deliveryId, committed.fileChanges, ownership());
      await renewOwnership();
      delivery = (
        await this.deliveries.transition(context, {
          commandId: `${delivery.startCommandId}:committed`,
          deliveryId: delivery.deliveryId,
          expectedVersion: delivery.version,
          target: "committed",
          branchRef: committed.branchRef,
          commitSha: committed.commitSha,
          changeSetHash: committed.changeSetHash,
          validationEvidenceIds,
          assuranceRecipe,
          ...(ownership() === undefined ? {} : { ownership: ownership() }),
        })
      ).delivery;
      await renewOwnership();
      await this.workspaces.remove(workspace);
      return { delivery, commit: committed };
    } catch (error) {
      if (error instanceof Error && error.name === "EngineeringCommandCleanupError") throw error;
      if (input.signal?.aborted) {
        throw new EngineeringPathLeaseOwnershipError("stale TDD owner는 workspace를 정리할 수 없습니다");
      }
      if (error instanceof EngineeringPathLeaseOwnershipError) throw error;
      if (committed) {
        throw new DeliveryExecutionError(
          "commit_reconciliation_required",
          "Git commit 이후 delivery 저장에 실패해 recovery가 필요합니다",
          { cause: error },
        );
      }
      await renewOwnership();
      if (workspace) {
        await this.workspaces.remove(workspace);
        await renewOwnership();
      }
      const current = await this.deliveries.get(context, input.deliveryId);
      if (!["committed", "failed", "cancelled"].includes(current.status)) {
        const category = error instanceof DeliveryExecutionError ? error.category : "delivery_execution_failed";
        await renewOwnership();
        await this.deliveries.transition(context, {
          commandId: `${current.startCommandId}:execution-failed`,
          deliveryId: current.deliveryId,
          expectedVersion: current.version,
          target: "failed",
          error: { category, causeId: causeId(error) },
          ...(ownership() === undefined ? {} : { ownership: ownership() }),
        });
      }
      throw error;
    }
  }

  private validateMarker(marker: string): void {
    if (!marker.trim() || marker.length > 256 || marker.includes("\0") || marker.includes("\n")) {
      throw new DeliveryExecutionError("invalid_red_marker", "RED failure marker 형식이 잘못됐습니다");
    }
    this.assertNoCredential(marker, "RED failure marker");
  }

  private assuranceRecipe(input: TddDeliveryInput): EngineeringAssuranceRecipe {
    const command = (value: CommandSpecification): EngineeringAssuranceRecipe["focusedCommand"] => {
      if (Object.keys(value.environment).length > 0) {
        throw new DeliveryExecutionError(
          "assurance_recipe_environment",
          "독립 재검증 명령에는 환경 변수를 사용할 수 없습니다",
        );
      }
      const result = {
        executable: value.executable,
        args: [...value.args],
        cwd: value.cwd,
        timeoutMs: value.timeoutMs,
        maxOutputBytes: value.maxOutputBytes,
      };
      this.assertNoCredential(JSON.stringify(result), "Assurance command");
      return result;
    };
    return {
      schemaVersion: "massion.software-assurance-recipe.v1",
      focusedCommand: command(input.focusedCommand),
      validationCommands: input.validationCommands.map(command),
    };
  }

  private assertNoCredential(value: string, label: string): void {
    if (redactSecrets(value).redactions.length > 0) {
      throw new DeliveryExecutionError("credential_patch", `${label}에서 credential이 감지됐습니다`);
    }
  }

  private assertCommandSuccess(result: ConfinedCommandResult, category: string, message: string): void {
    if (result.evidence.credentialRedacted) {
      throw new DeliveryExecutionError("credential_output", "Command output에서 credential이 감지됐습니다");
    }
    if (result.evidence.exitCode !== 0 || result.evidence.timedOut || result.evidence.outputLimited) {
      throw new DeliveryExecutionError(category, message);
    }
  }
}
