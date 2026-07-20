import { createHash } from "node:crypto";

import {
  compileAssuranceCriteria,
  selectAssuranceProfile,
  type AssuranceCheckBinding,
} from "@massion/assurance";
import { validateStrategyPlan } from "@massion/context-strategy";
import { redactSecrets } from "@massion/evidence";
import type { WorkRecoveryBundle } from "@massion/work";

import type {
  AutomaticAssuranceBindingRecipe,
  SoftwareAssuranceRecipeResolver,
} from "./core-assurance-stage.js";

const CODE_CHANGE_MEDIA_TYPE = "application/vnd.massion.code-change-manifest+json";
const AUTOMATIC_EVIDENCE_MAXIMUM_AGE_MS = 300_000;
const SOFTWARE_COMMAND_ADAPTER_ID = "massion.software-command.v1";
const SOFTWARE_SECURITY_INSPECTOR_PROFILE = "massion.software-security-scan.v1";

interface AssuranceCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

interface AssuranceRecipe {
  readonly schemaVersion: "massion.software-assurance-recipe.v1";
  readonly focusedCommand: AssuranceCommand;
  readonly validationCommands: readonly AssuranceCommand[];
}

interface CodeChangeManifest {
  readonly schemaVersion: "massion.code-change-manifest.v1";
  readonly assuranceRecipe?: unknown;
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assuranceCommand(value: unknown): AssuranceCommand | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.executable !== "string" ||
    !candidate.executable.trim() ||
    candidate.executable.length > 200 ||
    !Array.isArray(candidate.args) ||
    candidate.args.length > 50 ||
    candidate.args.some(
      (argument) => typeof argument !== "string" || !argument.trim() || argument.length > 500 || argument.includes("\0"),
    ) ||
    typeof candidate.cwd !== "string" ||
    !candidate.cwd.trim() ||
    candidate.cwd.length > 500 ||
    candidate.cwd.startsWith("/") ||
    candidate.cwd.split(/[\\/]/u).includes("..") ||
    typeof candidate.timeoutMs !== "number" ||
    !Number.isSafeInteger(candidate.timeoutMs) ||
    candidate.timeoutMs < 1_000 ||
    candidate.timeoutMs > 3_600_000 ||
    typeof candidate.maxOutputBytes !== "number" ||
    !Number.isSafeInteger(candidate.maxOutputBytes) ||
    candidate.maxOutputBytes < 1 ||
    candidate.maxOutputBytes > 10_000_000
  ) {
    return undefined;
  }
  const result = {
    executable: candidate.executable,
    args: [...candidate.args],
    cwd: candidate.cwd,
    timeoutMs: candidate.timeoutMs,
    maxOutputBytes: candidate.maxOutputBytes,
  };
  return redactSecrets(JSON.stringify(result)).redactions.length === 0 ? result : undefined;
}

function assuranceRecipe(value: unknown): AssuranceRecipe | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== "massion.software-assurance-recipe.v1" || !Array.isArray(candidate.validationCommands)) {
    return undefined;
  }
  const focusedCommand = assuranceCommand(candidate.focusedCommand);
  const validationCommands = candidate.validationCommands.map(assuranceCommand);
  if (!focusedCommand || validationCommands.some((command) => !command)) return undefined;
  return {
    schemaVersion: "massion.software-assurance-recipe.v1",
    focusedCommand,
    validationCommands: validationCommands as AssuranceCommand[],
  };
}

function codeChangeSource(
  recovery: Pick<WorkRecoveryBundle, "artifacts" | "artifactVersions">,
): { readonly artifactVersionId: string; readonly recipe: AssuranceRecipe } | undefined {
  const artifacts = recovery.artifacts.filter((artifact) => artifact.kind === "code-change");
  if (artifacts.length !== 1 || !artifacts[0]) return undefined;
  const versions = recovery.artifactVersions.filter(
    (version) => version.artifact_id === artifacts[0]?.artifact_id && version.media_type === CODE_CHANGE_MEDIA_TYPE,
  );
  if (versions.length !== 1 || !versions[0] || versions[0].content_json.length > 1_000_000) return undefined;
  const version = versions[0];
  if (version.checksum !== checksum(version.content_json)) return undefined;
  let manifest: CodeChangeManifest;
  try {
    manifest = JSON.parse(version.content_json) as CodeChangeManifest;
  } catch {
    return undefined;
  }
  if (manifest.schemaVersion !== "massion.code-change-manifest.v1") return undefined;
  const recipe = assuranceRecipe(manifest.assuranceRecipe);
  return recipe ? { artifactVersionId: version.artifact_version_id, recipe } : undefined;
}

function evidenceBinding(
  bindingKey: string,
  criterionKey: string,
  evidenceKinds: readonly string[],
): Extract<AssuranceCheckBinding, { readonly kind: "evidence" }> {
  return {
    bindingKey,
    criterionKey,
    kind: "evidence",
    executor: { kind: "system_adapter", adapterId: "massion.evidence.v1" },
    evidenceKinds,
    requiredEvidenceKinds: evidenceKinds,
    maximumAgeMs: AUTOMATIC_EVIDENCE_MAXIMUM_AGE_MS,
  };
}

function commandBinding(
  bindingKey: string,
  criterionKey: string,
  command: AssuranceCommand,
): Extract<AssuranceCheckBinding, { readonly kind: "test" }> {
  return {
    bindingKey,
    criterionKey,
    kind: "test",
    executor: { kind: "system_adapter", adapterId: SOFTWARE_COMMAND_ADAPTER_ID },
    requiredEvidenceKinds: ["command-output", "code-change"],
    executable: command.executable,
    args: command.args,
    cwd: command.cwd,
    expectedExitCode: 0,
    timeoutMs: command.timeoutMs,
    maxOutputBytes: command.maxOutputBytes,
  };
}

/**
 * code-change manifest의 안전한 명령을 실제 Assurance binding으로 변환합니다.
 * manifest에 없는 값과 patch 본문·환경 변수는 사용하지 않습니다.
 */
export class CodeChangeAssuranceRecipeResolver implements SoftwareAssuranceRecipeResolver {
  public async resolve(
    _context: Parameters<SoftwareAssuranceRecipeResolver["resolve"]>[0],
    input: Parameters<SoftwareAssuranceRecipeResolver["resolve"]>[1],
  ): Promise<AutomaticAssuranceBindingRecipe | undefined> {
    void _context;
    const source = codeChangeSource(input.recovery);
    if (!source) return undefined;
    try {
      const plan = validateStrategyPlan(JSON.parse(input.planContentJson) as unknown);
      if (
        !plan.acceptanceCriteria.every(
          (criterion) =>
            criterion.method === "evidence" &&
            criterion.evidenceKinds.length === 1 &&
            criterion.evidenceKinds[0] === "artifact-version",
        )
      ) {
        return undefined;
      }
      const profile = selectAssuranceProfile(["code-change"]);
      const acceptanceCoverage = profile.criteria.find((criterion) => criterion.key === "profile:acceptance:coverage");
      if (
        profile.profileId !== "massion.assurance.software-change.v1" ||
        !acceptanceCoverage ||
        acceptanceCoverage.method !== "evidence" ||
        !acceptanceCoverage.requiredEvidenceKinds.includes("check-result")
      ) {
        return undefined;
      }
      const validationCommand = source.recipe.validationCommands[0] ?? source.recipe.focusedCommand;
      const bindings: AssuranceCheckBinding[] = [
        ...plan.acceptanceCriteria.map((criterion, index) =>
          evidenceBinding(`auto-evidence-${String(index + 1)}`, criterion.key, ["artifact-version"]),
        ),
        evidenceBinding("auto-acceptance-coverage", acceptanceCoverage.key, ["check-result"]),
        commandBinding("software-correctness", "profile:software:correctness", source.recipe.focusedCommand),
        {
          bindingKey: "software-security",
          criterionKey: "profile:software:security",
          kind: "inspection",
          executor: { kind: "system_adapter", adapterId: SOFTWARE_SECURITY_INSPECTOR_PROFILE },
          requiredEvidenceKinds: ["code-change"],
          inspectorProfile: SOFTWARE_SECURITY_INSPECTOR_PROFILE,
          evidenceAllowlist: [source.artifactVersionId],
          maximumAgeMs: AUTOMATIC_EVIDENCE_MAXIMUM_AGE_MS,
          maximumFindings: 100,
        },
        commandBinding("software-reliability", "profile:software:reliability", source.recipe.focusedCommand),
        commandBinding("software-operability", "profile:software:operability", validationCommand),
        commandBinding("software-supply-chain", "profile:software:supply-chain", validationCommand),
      ];
      const criteria = compileAssuranceCriteria({
        planContentJson: input.planContentJson,
        tasks: input.recovery.tasks.map((task) => ({
          taskId: task.task_id,
          status: task.status,
          acceptanceCriteriaJson: task.acceptance_criteria_json,
        })),
        profile,
        bindings: bindings.map((binding) => ({
          criterionKey: binding.criterionKey,
          method: binding.kind,
          requiredEvidenceKinds: binding.requiredEvidenceKinds,
        })),
      });
      return {
        requiredCriteria: criteria.map((criterion) => ({
          criterionKey: criterion.criterionKey,
          method: criterion.method,
        })),
        bindings,
      };
    } catch {
      return undefined;
    }
  }
}
