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
      "get" | "listRecoverable" | "recoverPending" | "markApplied" | "markConflicted"
    >,
    private readonly works: Pick<WorkService, "getWork" | "getActivePlan" | "applyStrategyProjection">,
  ) {}

  public static create(
    generator: Pick<StrategyGenerator, "get" | "listRecoverable" | "recoverPending" | "markApplied" | "markConflicted">,
    works: Pick<WorkService, "getWork" | "getActivePlan" | "applyStrategyProjection">,
  ): StrategyRecovery {
    return new StrategyRecovery(generator, works);
  }

  public async recover(context: TenantContext, signal?: AbortSignal): Promise<StrategyGeneration[]> {
    signal?.throwIfAborted();
    const generations = await this.generator.listRecoverable(context);
    signal?.throwIfAborted();
    const recovered: StrategyGeneration[] = [];
    for (const candidate of generations) {
      const generation = await this.recoverGeneration(context, candidate.strategyGenerationId, false, signal);
      if (generation) recovered.push(generation);
    }
    return recovered;
  }

  public async recoverGeneration(
    context: TenantContext,
    strategyGenerationId: string,
    waitForLease = false,
    signal?: AbortSignal,
  ): Promise<StrategyGeneration | undefined> {
    signal?.throwIfAborted();
    const candidate = await this.generator.get(context, strategyGenerationId);
    signal?.throwIfAborted();
    const generation =
      candidate.status === "pending"
        ? await this.generator.recoverPending(context, strategyGenerationId, waitForLease, signal)
        : candidate;
    signal?.throwIfAborted();
    if (!generation || generation.status === "pending") return undefined;
    return generation.status === "generated" ? await this.recoverOne(context, generation, signal) : generation;
  }

  private async recoverOne(
    context: TenantContext,
    generation: StrategyGeneration,
    signal?: AbortSignal,
  ): Promise<StrategyGeneration> {
    signal?.throwIfAborted();
    if (!generation.plan || !generation.checksum) {
      throw new Error(`generated Strategy에 plan 또는 checksum이 없습니다: ${generation.strategyGenerationId}`);
    }
    const root = rootCommandId(generation.commandId);
    const work = await this.works.getWork(context, generation.workId);
    signal?.throwIfAborted();
    const activePlan = await this.works.getActivePlan(context, generation.workId);
    signal?.throwIfAborted();
    if (activePlan?.strategy_generation_id === generation.strategyGenerationId) {
      return await this.generator.markApplied(context, generation.strategyGenerationId, `${root}:applied`, signal);
    }
    if (work.revision !== generation.expectedWorkRevision) {
      return await this.generator.markConflicted(
        context,
        generation.strategyGenerationId,
        `${root}:conflicted`,
        signal,
      );
    }

    try {
      signal?.throwIfAborted();
      await this.works.applyStrategyProjection(context, {
        commandId: `${root}:project`,
        workId: generation.workId,
        expectedRevision: generation.expectedWorkRevision,
        contextVersionId: generation.contextVersionId,
        strategyGenerationId: generation.strategyGenerationId,
        strategyChecksum: generation.checksum,
        plan: generation.plan,
      });
      signal?.throwIfAborted();
      return await this.generator.markApplied(context, generation.strategyGenerationId, `${root}:applied`, signal);
    } catch (error) {
      signal?.throwIfAborted();
      const currentPlan = await this.works.getActivePlan(context, generation.workId);
      signal?.throwIfAborted();
      if (currentPlan?.strategy_generation_id === generation.strategyGenerationId) {
        return await this.generator.markApplied(context, generation.strategyGenerationId, `${root}:applied`, signal);
      }
      const currentWork = await this.works.getWork(context, generation.workId);
      signal?.throwIfAborted();
      if (currentWork.revision !== generation.expectedWorkRevision) {
        return await this.generator.markConflicted(
          context,
          generation.strategyGenerationId,
          `${root}:conflicted`,
          signal,
        );
      }
      throw error;
    }
  }
}
