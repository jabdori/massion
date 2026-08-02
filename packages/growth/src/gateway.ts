import type { TenantContext } from "@massion/identity";

import type { GrowthAdoptionService, GrowthAdoptionRecord, AdoptGrowthSuggestionInput } from "./adoption.js";
import type { GrowthBootstrap } from "./bootstrap.js";
import type { GrowthConfigurationStore } from "./configuration.js";
import type { ConfigureGrowthInput } from "./contracts.js";
import type { GrowthEffectSample, GrowthEffectStore } from "./effect.js";
import type { GrowthEvaluationDetails, GrowthEvaluationStore, GrowthSignalReceiptInput } from "./evaluation.js";
import type { ForgetExplicitMemoryInput, PromptMemoryStore, PutExplicitMemoryInput } from "./prompt-memory.js";
import type {
  GrowthSuggestionDecision,
  GrowthSuggestionRecord,
  ListGrowthSuggestionsInput,
  ReflectionService,
} from "./reflection.js";
import type { GrowthRecoveryService } from "./recovery.js";
import type { GrowthRevertService, RevertGrowthAdoptionInput } from "./revert.js";
import type { ReflectionSnapshot } from "./snapshot.js";
import type { GrowthTrigger } from "./trigger.js";

export interface GrowthGatewayDependencies {
  readonly bootstrap: GrowthBootstrap;
  readonly configurations: GrowthConfigurationStore;
  readonly prompts: PromptMemoryStore;
  readonly reflections: ReflectionService;
  readonly evaluations: GrowthEvaluationStore;
  readonly adoptions: GrowthAdoptionService;
  readonly effects: GrowthEffectStore;
  readonly reverts: GrowthRevertService;
  readonly recovery: GrowthRecoveryService;
}

export interface GrowthSuggestionDetails {
  readonly suggestion: GrowthSuggestionRecord;
  readonly patch?: Readonly<Record<string, unknown>>;
  readonly evaluation?: GrowthEvaluationDetails;
  readonly adoption?: GrowthAdoptionDetails;
}

export interface GrowthAdoptionDetails {
  readonly adoptionId: string;
  readonly status: GrowthAdoptionRecord["status"];
  readonly commandId: string;
  readonly approvalId?: string;
  readonly evaluationRunId: string;
  readonly evaluationInputHash: string;
  readonly beforeVersionId: string;
  readonly beforeChecksum: string;
  readonly afterVersionId?: string;
  readonly afterChecksum?: string;
}

function adoptionDetails(record: GrowthAdoptionRecord): GrowthAdoptionDetails {
  return {
    adoptionId: record.adoption_id,
    status: record.status,
    commandId: record.command_id,
    ...(record.approval_id === undefined ? {} : { approvalId: record.approval_id }),
    evaluationRunId: record.evaluation_run_id,
    evaluationInputHash: record.evaluation_input_hash,
    beforeVersionId: record.before_version_id,
    beforeChecksum: record.before_checksum,
    ...(record.after_version_id === undefined ? {} : { afterVersionId: record.after_version_id }),
    ...(record.after_checksum === undefined ? {} : { afterChecksum: record.after_checksum }),
  };
}

/** Growth의 허용된 제품 경로만 노출하는 façade입니다. */
export class GrowthGateway {
  public constructor(private readonly dependencies: GrowthGatewayDependencies) {}
  public async start(context: TenantContext) {
    return await this.dependencies.bootstrap.start(context);
  }
  public async configure(context: TenantContext, input: ConfigureGrowthInput) {
    return await this.dependencies.configurations.configure(context, input);
  }
  public async resolveConfiguration(context: TenantContext, requesterUserId?: string) {
    return await this.dependencies.configurations.resolve(context, requesterUserId);
  }
  public async getActivePromptDefinition(context: TenantContext) {
    return await this.dependencies.prompts.getActivePromptDefinition(context);
  }
  public async getActiveMemories(context: TenantContext, requesterUserId?: string) {
    return await this.dependencies.prompts.getActiveMemories(context, requesterUserId);
  }
  public async getActiveExplicitMemory(context: TenantContext) {
    return await this.dependencies.prompts.getActiveExplicitMemory(context);
  }
  public async putExplicitMemory(context: TenantContext, input: PutExplicitMemoryInput) {
    return await this.dependencies.prompts.putExplicitMemory(context, input);
  }
  public async forgetExplicitMemory(context: TenantContext, input: ForgetExplicitMemoryInput) {
    return await this.dependencies.prompts.forgetExplicitMemory(context, input);
  }
  public async getActiveEvaluationStrategy(context: TenantContext) {
    return await this.dependencies.evaluations.getActiveStrategy(context);
  }
  public async reflect(
    context: TenantContext,
    input: { readonly commandId: string; readonly trigger: GrowthTrigger; readonly snapshot: ReflectionSnapshot },
  ) {
    return await this.dependencies.reflections.run(context, input);
  }
  public async listSuggestions(context: TenantContext, input: ListGrowthSuggestionsInput = {}) {
    return await this.dependencies.reflections.listSuggestions(context, input);
  }
  public async reject(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly suggestionId: string;
      readonly expectedRevision: number;
      readonly reason: string;
    },
  ): Promise<GrowthSuggestionDecision> {
    return await this.dependencies.reflections.reject(context, input);
  }
  public async quarantine(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly suggestionId: string;
      readonly expectedRevision: number;
      readonly reason: string;
    },
  ) {
    return await this.dependencies.reflections.quarantine(context, input);
  }
  public async listSuggestionDetails(
    context: TenantContext,
    input: ListGrowthSuggestionsInput = {},
  ): Promise<readonly GrowthSuggestionDetails[]> {
    const suggestions = await this.dependencies.reflections.listSuggestions(context, input);
    return await Promise.all(
      suggestions.map(async (suggestion) => {
        const evaluation = await this.dependencies.evaluations.getForSuggestion(context, suggestion.suggestion_id);
        const adoption = await this.dependencies.adoptions.findBySuggestion(context, suggestion.suggestion_id);
        return {
          suggestion,
          patch: JSON.parse(suggestion.patch_json) as Readonly<Record<string, unknown>>,
          ...(evaluation === undefined ? {} : { evaluation }),
          ...(adoption === undefined ? {} : { adoption: adoptionDetails(adoption) }),
        };
      }),
    );
  }
  public async getSuggestionDetails(context: TenantContext, suggestionId: string): Promise<GrowthSuggestionDetails> {
    const details = await this.listSuggestionDetails(context, { suggestionId, limit: 1 });
    const detail = details[0];
    if (!detail) throw new Error("Growth Suggestion을 찾을 수 없습니다");
    return detail;
  }
  public async getSuggestionDetailsByApproval(
    context: TenantContext,
    approvalId: string,
  ): Promise<GrowthSuggestionDetails | undefined> {
    const adoption = await this.dependencies.adoptions.findByApproval(context, approvalId);
    if (!adoption) return undefined;
    const detail = await this.getSuggestionDetails(context, adoption.suggestion_id);
    if (detail.adoption?.adoptionId !== adoption.adoption_id || detail.adoption.approvalId !== approvalId) {
      throw new Error("Growth Suggestion과 Approval 연결이 일치하지 않습니다");
    }
    return detail;
  }
  public async evaluate(
    context: TenantContext,
    input: { readonly commandId: string; readonly suggestionId: string; readonly receiptIds: readonly string[] },
  ) {
    return await this.dependencies.evaluations.evaluate(context, input);
  }
  public async recordSignal(context: TenantContext, input: GrowthSignalReceiptInput) {
    return await this.dependencies.evaluations.recordSignal(context, input);
  }
  public async inspectTarget(
    context: TenantContext,
    input: {
      readonly targetKind: "prompt" | "memory" | "policy" | "organization";
      readonly suggestionId: string;
      readonly patch: Readonly<Record<string, unknown>>;
    },
  ) {
    return await this.dependencies.adoptions.inspectTarget(context, input);
  }
  public async adopt(context: TenantContext, input: AdoptGrowthSuggestionInput) {
    return await this.dependencies.adoptions.adopt(context, input);
  }
  public async captureEffectBaseline(
    context: TenantContext,
    input: { readonly commandId: string; readonly adoptionId: string; readonly sample: GrowthEffectSample },
  ) {
    await this.dependencies.effects.captureBaseline(context, input);
  }
  public async observeEffect(
    context: TenantContext,
    input: { readonly commandId: string; readonly adoptionId: string; readonly sample: GrowthEffectSample },
  ) {
    return await this.dependencies.effects.observe(context, input);
  }
  public async listEffectEvaluations(
    context: TenantContext,
    input: { readonly adoptionId?: string; readonly limit?: number } = {},
  ) {
    return await this.dependencies.effects.listEvaluations(context, input);
  }
  public async revert(context: TenantContext, input: RevertGrowthAdoptionInput) {
    return await this.dependencies.reverts.revert(context, input);
  }
  public async recover(context: TenantContext) {
    return await this.dependencies.recovery.scan(context);
  }
}
