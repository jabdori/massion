import type { TenantContext } from "@massion/identity";

import type { GrowthAdoptionService, AdoptGrowthSuggestionInput } from "./adoption.js";
import type { GrowthBootstrap } from "./bootstrap.js";
import type { GrowthConfigurationStore } from "./configuration.js";
import type { ConfigureGrowthInput } from "./contracts.js";
import type { GrowthEffectSample, GrowthEffectStore } from "./effect.js";
import type { GrowthEvaluationStore } from "./evaluation.js";
import type { PromptMemoryStore } from "./prompt-memory.js";
import type { ReflectionService } from "./reflection.js";
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
  public async getActiveEvaluationStrategy(context: TenantContext) {
    return await this.dependencies.evaluations.getActiveStrategy(context);
  }
  public async reflect(
    context: TenantContext,
    input: { readonly commandId: string; readonly trigger: GrowthTrigger; readonly snapshot: ReflectionSnapshot },
  ) {
    return await this.dependencies.reflections.run(context, input);
  }
  public async evaluate(
    context: TenantContext,
    input: { readonly commandId: string; readonly suggestionId: string; readonly receiptIds: readonly string[] },
  ) {
    return await this.dependencies.evaluations.evaluate(context, input);
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
  public async revert(context: TenantContext, input: RevertGrowthAdoptionInput) {
    return await this.dependencies.reverts.revert(context, input);
  }
  public async recover(context: TenantContext) {
    return await this.dependencies.recovery.scan(context);
  }
}
