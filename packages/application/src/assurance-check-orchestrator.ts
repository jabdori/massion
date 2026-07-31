import type {
  AssuranceCheckBinding,
  AssuranceBindingStore,
  AssuranceCheckStore,
  AssuranceRunGateway,
  RecordAssuranceCheckInput,
} from "@massion/assurance";
import { validateStrategyPlan } from "@massion/context-strategy";
import type { TenantContext } from "@massion/identity";
import type { WorkService } from "@massion/work";

import type { CoreAssuranceCheckOrchestrator } from "./core-assurance-stage.js";

interface AssuranceEvidenceReferences {
  readonly evidenceBriefIds: readonly string[];
  readonly metricObservationIds: readonly string[];
  readonly humanAttestationIds: readonly string[];
}

function ids(value: unknown, label: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error(`${label}가 유효하지 않습니다`);
  }
  const result: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "string" || item.length === 0) throw new Error(`${label}가 유효하지 않습니다`);
    result.push(item);
  }
  if (new Set(result).size !== result.length) throw new Error(`${label}에 중복이 있습니다`);
  return result.sort();
}

function evidence(request: unknown): AssuranceEvidenceReferences {
  const root = request && typeof request === "object" ? (request as Record<string, unknown>) : {};
  const configured = root.assuranceEvidence;
  const record =
    configured && typeof configured === "object" && !Array.isArray(configured)
      ? (configured as Record<string, unknown>)
      : {};
  return {
    evidenceBriefIds: ids(record.evidenceBriefIds ?? root.evidenceBriefIds, "Assurance Evidence Brief ID"),
    metricObservationIds: ids(record.metricObservationIds, "Assurance metric observation ID"),
    humanAttestationIds: ids(record.humanAttestationIds, "Assurance human attestation ID"),
  };
}

function requiresPriorCheckResult(binding: AssuranceCheckBinding | undefined): boolean {
  return binding?.kind === "evidence" && binding.evidenceKinds.includes("check-result");
}

function requiresExactCodeChange(binding: AssuranceCheckBinding): boolean {
  return (
    (binding.kind === "test" &&
      binding.executor.kind === "system_adapter" &&
      binding.executor.adapterId === "massion.software-command.v1") ||
    (binding.kind === "inspection" && binding.inspectorProfile === "massion.software-security-scan.v1")
  );
}

function artifactVersionIds(
  criterionKey: string,
  binding: AssuranceCheckBinding,
  recovery: Awaited<ReturnType<WorkService["recoverWork"]>>,
): readonly string[] {
  if (requiresExactCodeChange(binding)) {
    const codeChangeArtifacts = recovery.artifacts.filter((artifact) => artifact.kind === "code-change");
    if (codeChangeArtifacts.length !== 1 || !codeChangeArtifacts[0]) return [];
    const workArtifactVersions = new Set(recovery.work.artifact_version_ids);
    const versions = recovery.artifactVersions.filter(
      (version) =>
        version.artifact_id === codeChangeArtifacts[0]?.artifact_id &&
        workArtifactVersions.has(version.artifact_version_id),
    );
    return versions.length === 1 && versions[0] ? [versions[0].artifact_version_id] : [];
  }
  if (binding.kind !== "evidence") return recovery.work.artifact_version_ids;
  if (!binding.evidenceKinds.includes("artifact-version")) return [];
  try {
    const planVersion = recovery.plans.find(
      (plan) => plan.plan_version_id === recovery.work.active_plan_version_id && plan.valid,
    );
    if (!planVersion) return [];
    const plan = validateStrategyPlan(JSON.parse(planVersion.content_json) as unknown);
    const criterion = plan.acceptanceCriteria.find((item) => item.key === criterionKey);
    if (!criterion) return [];
    const taskKeys = new Set(
      plan.tasks
        .filter((task) => criterion.planLevel || task.criterionKeys.includes(criterionKey))
        .map((task) => task.key),
    );
    const taskIds = new Set(
      recovery.tasks
        .filter(
          (task) =>
            task.plan_version_id === planVersion.plan_version_id && task.task_key && taskKeys.has(task.task_key),
        )
        .map((task) => task.task_id),
    );
    const allowed = new Set(recovery.work.artifact_version_ids);
    return [
      ...new Set(
        recovery.messages.flatMap((message) =>
          message.task_id &&
          taskIds.has(message.task_id) &&
          message.artifact_version_id &&
          allowed.has(message.artifact_version_id)
            ? [message.artifact_version_id]
            : [],
        ),
      ),
    ].sort();
  } catch {
    return [];
  }
}

export class DatabaseCoreAssuranceCheckOrchestrator implements CoreAssuranceCheckOrchestrator {
  public constructor(
    private readonly dependencies: {
      readonly runs: Pick<AssuranceRunGateway, "listCriteria">;
      readonly bindings: Pick<AssuranceBindingStore, "get">;
      readonly checks: Pick<AssuranceCheckStore, "record">;
      readonly works: Pick<WorkService, "recoverWork">;
    },
  ) {}

  public async execute(
    context: TenantContext,
    input: Parameters<CoreAssuranceCheckOrchestrator["execute"]>[1],
  ): ReturnType<CoreAssuranceCheckOrchestrator["execute"]> {
    const [criteria, binding, recovery] = await Promise.all([
      this.dependencies.runs.listCriteria(context, input.run.assuranceRunId),
      this.dependencies.bindings.get(context, input.run.bindingVersionId),
      this.dependencies.works.recoverWork(context, input.run.workId),
    ]);
    const references = evidence(input.request);
    const bindingByCriterion = new Map(binding.bindings.map((item) => [item.criterionKey, item]));
    const scheduled = criteria
      .filter((criterion) => criterion.status !== "excluded")
      .map((criterion) => ({ criterion, binding: bindingByCriterion.get(criterion.criterionKey) }));
    if (scheduled.some((item) => !item.binding)) return { outcome: "blocked", reason: "assurance-binding-incomplete" };
    scheduled.sort((left, right) => {
      const dependencyOrder =
        Number(requiresPriorCheckResult(left.binding)) - Number(requiresPriorCheckResult(right.binding));
      return dependencyOrder || left.criterion.criterionKey.localeCompare(right.criterion.criterionKey);
    });
    for (const item of scheduled) {
      const checkBinding = item.binding;
      if (!checkBinding) return { outcome: "blocked", reason: "assurance-binding-incomplete" };
      const record: RecordAssuranceCheckInput = {
        commandId: `${input.commandId}:${checkBinding.bindingKey}`,
        workId: input.run.workId,
        assuranceRunId: input.run.assuranceRunId,
        criterionId: item.criterion.criterionId,
        bindingKey: checkBinding.bindingKey,
        artifactVersionIds: artifactVersionIds(item.criterion.criterionKey, checkBinding, recovery),
        evidenceBriefIds: references.evidenceBriefIds,
        metricObservationIds: references.metricObservationIds,
        humanAttestationIds: references.humanAttestationIds,
      };
      await this.dependencies.checks.record(context, record);
    }
    return { outcome: "ready" };
  }
}
