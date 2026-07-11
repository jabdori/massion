import type {
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
  if (!Array.isArray(value) || value.length > 100 || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error(`${label}가 유효하지 않습니다`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label}에 중복이 있습니다`);
  return [...value].sort();
}

function evidence(request: unknown): AssuranceEvidenceReferences {
  const root = request && typeof request === "object" ? (request as Record<string, unknown>) : {};
  const configured = root.assuranceEvidence;
  const record = configured && typeof configured === "object" && !Array.isArray(configured)
    ? (configured as Record<string, unknown>)
    : {};
  return {
    evidenceBriefIds: ids(record.evidenceBriefIds ?? root.evidenceBriefIds, "Assurance Evidence Brief ID"),
    metricObservationIds: ids(record.metricObservationIds, "Assurance metric observation ID"),
    humanAttestationIds: ids(record.humanAttestationIds, "Assurance human attestation ID"),
  };
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
    for (const criterion of criteria) {
      if (criterion.status === "excluded") continue;
      const checkBinding = bindingByCriterion.get(criterion.criterionKey);
      if (!checkBinding) return { outcome: "blocked", reason: "assurance-binding-incomplete" };
      const record: RecordAssuranceCheckInput = {
        commandId: `${input.commandId}:${checkBinding.bindingKey}`,
        workId: input.run.workId,
        assuranceRunId: input.run.assuranceRunId,
        criterionId: criterion.criterionId,
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
