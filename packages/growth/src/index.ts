export { GrowthBootstrap, decideGrowthBootstrap } from "./bootstrap.js";
export { GrowthGateway, type GrowthGatewayDependencies } from "./gateway.js";

export type { AdoptGrowthSuggestionInput, GrowthAdoptionResult, GrowthAdoptionStatus } from "./adoption.js";
export type { ConfigureGrowthInput, GrowthConfigurationSubject, GrowthConfigurationVersion } from "./contracts.js";
export type { GrowthEffectComparison, GrowthEffectContract, GrowthEffectSample } from "./effect.js";
export type { GrowthEvaluationOutcome, GrowthEvaluationRun, GrowthEvaluationStrategyVersion } from "./evaluation.js";
export type {
  EffectivePromptVersion,
  MemoryEntry,
  MemoryVersion,
  PromptAgentSection,
  PromptDefinitionVersion,
} from "./prompt-memory.js";
export type {
  GrowthSuggestionRecord,
  ListGrowthSuggestionsInput,
  ReflectionRunRecord,
  SuggestionCandidate,
  SuggestionTargetKind,
} from "./reflection.js";
export type { GrowthRecoveryAction, GrowthRecoveryRecord } from "./recovery.js";
export type { GrowthRevertOperation, RevertGrowthAdoptionInput } from "./revert.js";
export type { ReflectionSnapshot, ReflectionSnapshotBundle } from "./snapshot.js";
export type { GrowthTrigger } from "./trigger.js";
