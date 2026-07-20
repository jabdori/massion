import type {
  AssuranceCheckBinding,
  AssuranceBindingStore,
  AssuranceCheckStore,
  AssuranceRunGateway,
  RecordAssuranceCheckInput,
} from "@massion/assurance";
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
        artifactVersionIds: recovery.work.artifact_version_ids,
        evidenceBriefIds: references.evidenceBriefIds,
        metricObservationIds: references.metricObservationIds,
        humanAttestationIds: references.humanAttestationIds,
      };
      await this.dependencies.checks.record(context, record);
    }
    return { outcome: "ready" };
  }
}
