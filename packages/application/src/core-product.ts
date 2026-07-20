import type { AssuranceBindingStore, AssuranceRunGateway } from "@massion/assurance";
import type { StrategyService } from "@massion/context-strategy";
import type { EvidenceBriefStore } from "@massion/evidence";
import type { OrganizationGraphService } from "@massion/organization";
import type { RecordsService } from "@massion/records";
import type { AgentRunner, RuntimeExecutionStore } from "@massion/runtime";
import type { WorkService } from "@massion/work";

import { CoreAssuranceStage, type CoreAssuranceCheckOrchestrator } from "./core-assurance-stage.js";
import { CoreDeliveryStage, type CoreSoftwareTaskPort } from "./core-delivery-stage.js";
import { CoreEvidenceStage } from "./core-evidence-stage.js";
import { createCoreWorkPipelineExecutors } from "./core-pipeline.js";
import { CoreRecordsStage, type CoreRecordsDocumentPlanner } from "./core-records-stage.js";
import { DeterministicRecordsDocumentPlanner } from "./records-document-planner.js";
import type { CoreWorkStage, CoreWorkStageExecutor } from "./core-work-coordinator.js";

export interface CoreProductDependencies {
  readonly graph: OrganizationGraphService;
  readonly works: WorkService;
  readonly runner: AgentRunner;
  readonly runtimeExecutions: RuntimeExecutionStore;
  readonly strategy: StrategyService;
  readonly briefs: EvidenceBriefStore;
  readonly assurance: AssuranceRunGateway;
  readonly assuranceBindings: AssuranceBindingStore;
  readonly assuranceChecks: CoreAssuranceCheckOrchestrator;
  readonly records: RecordsService;
  readonly recordDocuments?: CoreRecordsDocumentPlanner;
  readonly software: CoreSoftwareTaskPort;
}

export function createCoreProductExecutors(
  dependencies: CoreProductDependencies,
): Readonly<Record<CoreWorkStage, CoreWorkStageExecutor>> {
  const evidence = new CoreEvidenceStage({ works: dependencies.works, briefs: dependencies.briefs });
  const delivery = new CoreDeliveryStage({
    works: dependencies.works,
    runner: dependencies.runner,
    runtimeExecutions: dependencies.runtimeExecutions,
    software: dependencies.software,
  });
  const assurance = new CoreAssuranceStage({
    works: dependencies.works,
    bindings: dependencies.assuranceBindings,
    runner: dependencies.runner,
    runtimeExecutions: dependencies.runtimeExecutions,
    assurance: dependencies.assurance,
    checks: dependencies.assuranceChecks,
  });
  const records = new CoreRecordsStage({
    works: dependencies.works,
    records: dependencies.records,
    documents: dependencies.recordDocuments ?? new DeterministicRecordsDocumentPlanner(),
  });
  return createCoreWorkPipelineExecutors({
    graph: dependencies.graph,
    works: dependencies.works,
    representative: dependencies.runner,
    runtimeExecutions: dependencies.runtimeExecutions,
    strategy: dependencies.strategy,
    evidence,
    delivery,
    assurance,
    records,
  });
}
