import type { TenantContext } from "@massion/identity";
import type { WorkService } from "@massion/work";

import type { StrategyGeneration, StrategyGenerator } from "./strategy-generator.js";

function rootCommandId(generationCommandId: string): string {
  const suffix = ":generate";
  if (!generationCommandId.endsWith(suffix)) {
    throw new Error(`복구할 Strategy command 형식이 잘못됐습니다: ${generationCommandId}`);
  }
  return generationCommandId.slice(0, -suffix.length);
}

export class StrategyRecovery {
  private constructor(
    private readonly generator: Pick<
      StrategyGenerator,
      "listGenerated" | "markApplied" | "markConflicted"
    >,
    private readonly works: Pick<WorkService, "getWork" | "getActivePlan" | "applyStrategyProjection">,
  ) {}

  public static create(
    generator: Pick<StrategyGenerator, "listGenerated" | "markApplied" | "markConflicted">,
    works: Pick<WorkService, "getWork" | "getActivePlan" | "applyStrategyProjection">,
  ): StrategyRecovery {
    return new StrategyRecovery(generator, works);
  }

  public async recover(context: TenantContext): Promise<StrategyGeneration[]> {
    const generations = await this.generator.listGenerated(context);
    const recovered: StrategyGeneration[] = [];
    for (const generation of generations) recovered.push(await this.recoverOne(context, generation));
    return recovered;
  }

  private async recoverOne(context: TenantContext, generation: StrategyGeneration): Promise<StrategyGeneration> {
    if (!generation.plan || !generation.checksum) {
      throw new Error(`generated Strategy에 plan 또는 checksum이 없습니다: ${generation.strategyGenerationId}`);
    }
    const root = rootCommandId(generation.commandId);
    const work = await this.works.getWork(context, generation.workId);
    const activePlan = await this.works.getActivePlan(context, generation.workId);
    if (activePlan?.strategy_generation_id === generation.strategyGenerationId) {
      return await this.generator.markApplied(
        context,
        generation.strategyGenerationId,
        `${root}:applied`,
      );
    }
    if (work.revision !== generation.expectedWorkRevision) {
      return await this.generator.markConflicted(
        context,
        generation.strategyGenerationId,
        `${root}:conflicted`,
      );
    }

    try {
      await this.works.applyStrategyProjection(context, {
        commandId: `${root}:project`,
        workId: generation.workId,
        expectedRevision: generation.expectedWorkRevision,
        contextVersionId: generation.contextVersionId,
        strategyGenerationId: generation.strategyGenerationId,
        strategyChecksum: generation.checksum,
        plan: generation.plan,
      });
      return await this.generator.markApplied(
        context,
        generation.strategyGenerationId,
        `${root}:applied`,
      );
    } catch (error) {
      const currentPlan = await this.works.getActivePlan(context, generation.workId);
      if (currentPlan?.strategy_generation_id === generation.strategyGenerationId) {
        return await this.generator.markApplied(
          context,
          generation.strategyGenerationId,
          `${root}:applied`,
        );
      }
      const currentWork = await this.works.getWork(context, generation.workId);
      if (currentWork.revision !== generation.expectedWorkRevision) {
        return await this.generator.markConflicted(
          context,
          generation.strategyGenerationId,
          `${root}:conflicted`,
        );
      }
      throw error;
    }
  }
}
