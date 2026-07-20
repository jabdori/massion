import type { TenantContext } from "@massion/identity";
import type { ApplyStrategyProjectionResult, WorkService } from "@massion/work";

import type { ContextStore } from "./context-store.js";
import type { ContextVersion, CreateContextInput } from "./contracts.js";
import type { StrategyGeneration, StrategyGenerator } from "./strategy-generator.js";

export interface PlanStrategyInput {
  readonly commandId: string;
  readonly workId: string;
  readonly expectedWorkRevision: number;
  readonly tokenBudget: number;
  readonly signal?: AbortSignal;
  readonly context: Omit<CreateContextInput, "commandId" | "workId" | "tokenBudget">;
}

export interface PlanStrategyResult {
  readonly contextVersion: ContextVersion;
  readonly generation: StrategyGeneration;
  readonly projection?: ApplyStrategyProjectionResult;
}

export interface StrategyServiceHooks {
  readonly beforeProjection?: () => Promise<void>;
}

export class StrategyService {
  private constructor(
    private readonly contexts: Pick<ContextStore, "create">,
    private readonly generator: Pick<StrategyGenerator, "generate" | "markApplied" | "markConflicted">,
    private readonly works: Pick<WorkService, "getWork" | "getActivePlan" | "applyStrategyProjection">,
    private readonly hooks?: StrategyServiceHooks,
  ) {}

  public static create(
    contexts: Pick<ContextStore, "create">,
    generator: Pick<StrategyGenerator, "generate" | "markApplied" | "markConflicted">,
    works: Pick<WorkService, "getWork" | "getActivePlan" | "applyStrategyProjection">,
    hooks?: StrategyServiceHooks,
  ): StrategyService {
    return new StrategyService(contexts, generator, works, hooks);
  }

  public async plan(context: TenantContext, input: PlanStrategyInput): Promise<PlanStrategyResult> {
    const contextVersion = await this.contexts.create(context, {
      ...input.context,
      commandId: `${input.commandId}:context`,
      workId: input.workId,
      tokenBudget: input.tokenBudget,
    });
    const generated = await this.generator.generate(context, {
      commandId: `${input.commandId}:generate`,
      workId: input.workId,
      expectedWorkRevision: input.expectedWorkRevision,
      contextVersionId: contextVersion.contextVersionId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (!["generated", "applied"].includes(generated.status) || !generated.plan || !generated.checksum) {
      return { contextVersion, generation: generated };
    }

    await this.hooks?.beforeProjection?.();
    const currentWork = await this.works.getWork(context, input.workId);
    if (generated.status === "generated" && currentWork.revision !== input.expectedWorkRevision) {
      const conflicted = await this.generator.markConflicted(
        context,
        generated.strategyGenerationId,
        `${input.commandId}:conflicted`,
      );
      return { contextVersion, generation: conflicted };
    }
    let projection: ApplyStrategyProjectionResult;
    try {
      projection = await this.works.applyStrategyProjection(context, {
        commandId: `${input.commandId}:project`,
        workId: input.workId,
        expectedRevision: input.expectedWorkRevision,
        contextVersionId: contextVersion.contextVersionId,
        strategyGenerationId: generated.strategyGenerationId,
        strategyChecksum: generated.checksum,
        plan: generated.plan,
      });
    } catch (error) {
      if (generated.status !== "generated") throw error;
      const activePlan = await this.works.getActivePlan(context, input.workId);
      if (activePlan?.strategy_generation_id === generated.strategyGenerationId) {
        const applied = await this.generator.markApplied(
          context,
          generated.strategyGenerationId,
          `${input.commandId}:applied`,
        );
        return { contextVersion, generation: applied };
      }
      const racedWork = await this.works.getWork(context, input.workId);
      if (racedWork.revision !== input.expectedWorkRevision) {
        const conflicted = await this.generator.markConflicted(
          context,
          generated.strategyGenerationId,
          `${input.commandId}:conflicted`,
        );
        return { contextVersion, generation: conflicted };
      }
      throw error;
    }
    const applied =
      generated.status === "applied"
        ? generated
        : await this.generator.markApplied(context, generated.strategyGenerationId, `${input.commandId}:applied`);
    return { contextVersion, generation: applied, projection };
  }
}
