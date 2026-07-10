import { createHash } from "node:crypto";

import { redactSecrets } from "@massion/evidence";
import type { TenantContext } from "@massion/identity";

import type { EngineeringDelivery } from "./contracts.js";
import type { ConfinedCommandInput, ConfinedCommandResult } from "./command-runner.js";
import { EngineeringDeliveryStore } from "./delivery-store.js";
import { GitWorkspaceManager, type GitCommitResult, type GitDeliveryWorkspace } from "./git-workspace.js";
import { validateUnifiedPatch } from "./patch.js";
import { normalizeEngineeringPaths } from "./path-lease.js";

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
  ) {}

  public async execute(context: TenantContext, input: TddDeliveryInput): Promise<TddDeliveryResult> {
    let delivery = await this.deliveries.get(context, input.deliveryId);
    if (delivery.status !== "preparing") {
      throw new Error(`preparing Delivery만 TDD 실행할 수 있습니다: ${delivery.status}`);
    }
    await this.workspaces.verifyRepositoryRoot(input.repositoryRoot, delivery.repositoryRootRealPathHash);
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

      workspace = await this.workspaces.prepare({
        repositoryRoot: input.repositoryRoot,
        baseRevision: delivery.baseRevision,
        deliveryId: delivery.deliveryId,
      });
      const runner = await this.runners.create(workspace.workspacePath);
      const appliedTest = await this.workspaces.applyPatch(workspace, testPatch);
      delivery = (
        await this.deliveries.transition(context, {
          commandId: `${delivery.startCommandId}:test-applied`,
          deliveryId: delivery.deliveryId,
          expectedVersion: delivery.version,
          target: "test_applied",
          workspaceId: delivery.deliveryId,
          testPatchHash: appliedTest.changeSetHash,
        })
      ).delivery;

      const red = await runner.run({ ...input.focusedCommand, stage: "red" });
      const redEvidenceId = (
        await this.deliveries.recordCommandEvidence(context, {
          deliveryId: delivery.deliveryId,
          evidenceKey: "red",
          evidence: red.evidence,
        })
      ).commandEvidenceId;
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
      delivery = (
        await this.deliveries.transition(context, {
          commandId: `${delivery.startCommandId}:red-verified`,
          deliveryId: delivery.deliveryId,
          expectedVersion: delivery.version,
          target: "red_verified",
          redEvidenceId,
        })
      ).delivery;

      const appliedImplementation = await this.workspaces.applyPatch(workspace, implementationPatch);
      delivery = (
        await this.deliveries.transition(context, {
          commandId: `${delivery.startCommandId}:implementation-applied`,
          deliveryId: delivery.deliveryId,
          expectedVersion: delivery.version,
          target: "implementation_applied",
          implementationPatchHash: appliedImplementation.changeSetHash,
        })
      ).delivery;

      const green = await runner.run({ ...input.focusedCommand, stage: "green" });
      const greenEvidenceId = (
        await this.deliveries.recordCommandEvidence(context, {
          deliveryId: delivery.deliveryId,
          evidenceKey: "green",
          evidence: green.evidence,
        })
      ).commandEvidenceId;
      await this.workspaces.verifyNoUnstagedChanges(workspace);
      this.assertCommandSuccess(green, "green_failed", "Focused test GREEN이 실패했습니다");
      delivery = (
        await this.deliveries.transition(context, {
          commandId: `${delivery.startCommandId}:green-verified`,
          deliveryId: delivery.deliveryId,
          expectedVersion: delivery.version,
          target: "green_verified",
          greenEvidenceId,
        })
      ).delivery;

      const validationEvidenceIds: string[] = [];
      for (const [index, command] of input.validationCommands.entries()) {
        const validation = await runner.run({ ...command, stage: "validation" });
        validationEvidenceIds.push(
          (
            await this.deliveries.recordCommandEvidence(context, {
              deliveryId: delivery.deliveryId,
              evidenceKey: `validation-${String(index).padStart(3, "0")}`,
              evidence: validation.evidence,
            })
          ).commandEvidenceId,
        );
        await this.workspaces.verifyNoUnstagedChanges(workspace);
        this.assertCommandSuccess(
          validation,
          "validation_failed",
          `Validation command ${String(index + 1)}이 실패했습니다`,
        );
      }

      committed = await this.workspaces.commit(workspace, {
        message: input.commitMessage,
        expectedPaths: [...new Set([...testPatch.paths, ...implementationPatch.paths])],
      });
      await this.deliveries.recordFileChanges(context, delivery.deliveryId, committed.fileChanges);
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
        })
      ).delivery;
      await this.workspaces.remove(workspace);
      return { delivery, commit: committed };
    } catch (error) {
      if (committed) {
        throw new DeliveryExecutionError(
          "commit_reconciliation_required",
          "Git commit 이후 delivery 저장에 실패해 recovery가 필요합니다",
          { cause: error },
        );
      }
      if (workspace) await this.workspaces.remove(workspace).catch(() => undefined);
      const current = await this.deliveries.get(context, input.deliveryId);
      if (!["committed", "failed", "cancelled"].includes(current.status)) {
        const category = error instanceof DeliveryExecutionError ? error.category : "delivery_execution_failed";
        await this.deliveries.transition(context, {
          commandId: `${current.startCommandId}:execution-failed`,
          deliveryId: current.deliveryId,
          expectedVersion: current.version,
          target: "failed",
          error: { category, causeId: causeId(error) },
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
