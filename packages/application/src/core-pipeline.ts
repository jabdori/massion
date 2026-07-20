import {
  hashContextContent,
  type ContextSource,
  type PlanStrategyInput,
  type PlanStrategyResult,
  type StrategyService,
} from "@massion/context-strategy";
import type { TenantContext } from "@massion/identity";
import { CORE_OFFICE_HANDLES, type OrganizationGraphService } from "@massion/organization";
import type { AgentRunner, RuntimeExecutionStore } from "@massion/runtime";
import { canTransitionWork, type WorkService } from "@massion/work";

import type {
  CoreWorkStage,
  CoreWorkStageExecutor,
  CoreWorkStageInput,
  CoreWorkStageResult,
} from "./core-work-coordinator.js";

type StagePort = {
  execute(context: TenantContext, input: CoreWorkStageInput): Promise<CoreWorkStageResult>;
  cancel?(context: TenantContext, input: Omit<CoreWorkStageInput, "resumeInput">): Promise<void>;
};

export interface CoreWorkPipelineDependencies {
  readonly graph: Pick<OrganizationGraphService, "getCurrentSnapshot">;
  readonly works: Pick<
    WorkService,
    "createWork" | "getWork" | "transition" | "openRoom" | "postMessage" | "listRooms" | "listMessages"
  >;
  readonly representative: Pick<AgentRunner, "execute" | "cancel">;
  readonly runtimeExecutions: Pick<RuntimeExecutionStore, "findExecutionIdByCommand">;
  readonly strategy: Pick<StrategyService, "plan">;
  readonly evidence: StagePort;
  readonly delivery: StagePort;
  readonly assurance: StagePort;
  readonly records: StagePort;
}

const CORE_OFFICE_ROOM_TITLE = "Core Office";

function handoffContent(output: unknown): string {
  if (typeof output === "string" && output.trim()) return output.trim().slice(0, 16_000);
  try {
    const encoded = JSON.stringify(output);
    if (encoded && encoded !== "{}" && encoded !== "null") return encoded.slice(0, 16_000);
  } catch {
    // 구조화할 수 없는 실행 출력은 handoff 본문으로 저장하지 않습니다.
  }
  return "사용자 요청을 Context & Strategy에 전달합니다.";
}

interface CoreRequest {
  readonly text: string;
  readonly surface: string;
  readonly projectId?: string;
  readonly tokenBudget: number;
  readonly scopeIn: readonly string[];
  readonly scopeOut: readonly string[];
  readonly constraints: readonly string[];
  readonly assumptions: readonly string[];
  readonly unknowns: readonly string[];
  readonly decisions: readonly string[];
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function request(value: unknown): CoreRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Core Work request는 object여야 합니다");
  const input = value as Record<string, unknown>;
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text || text.length > 64 * 1024) throw new Error("Core Work request text가 유효하지 않습니다");
  const tokenBudget = input.tokenBudget === undefined ? 32_000 : Number(input.tokenBudget);
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1_000 || tokenBudget > 1_000_000)
    throw new Error("Core Work token budget이 유효하지 않습니다");
  return {
    text,
    surface: typeof input.surface === "string" ? input.surface : "application",
    ...(typeof input.projectId === "string" ? { projectId: input.projectId } : {}),
    tokenBudget,
    scopeIn: strings(input.scopeIn),
    scopeOut: strings(input.scopeOut),
    constraints: strings(input.constraints),
    assumptions: strings(input.assumptions),
    unknowns: strings(input.unknowns),
    decisions: strings(input.decisions),
  };
}

export function createCoreWorkPipelineExecutors(
  dependencies: CoreWorkPipelineDependencies,
): Readonly<Record<CoreWorkStage, CoreWorkStageExecutor>> {
  const cancelCreatedWork = async (context: TenantContext, runId: string, workId: string): Promise<void> => {
    const work = await dependencies.works.getWork(context, workId);
    if (!canTransitionWork(work.status, "cancelled")) return;
    await dependencies.works.transition(context, {
      commandId: `${runId}:work-cancel`,
      workId,
      expectedRevision: work.revision,
      target: "cancelled",
    });
  };
  const throwIfCancelled = (input: CoreWorkStageInput): void => {
    if (input.signal?.aborted) throw new Error("Application run cancelled");
  };
  const cancelAndThrowIfCancelled = async (
    context: TenantContext,
    input: CoreWorkStageInput,
    workId: string,
  ): Promise<void> => {
    if (!input.signal?.aborted) return;
    await cancelCreatedWork(context, input.runId, workId);
    throw new Error("Application run cancelled");
  };
  const coreOfficeRoom = async (
    context: TenantContext,
    input: CoreWorkStageInput,
    workId: string,
    tokenBudget: number,
  ) => {
    const existing = (await dependencies.works.listRooms(context, workId)).find(
      (room) => room.title === CORE_OFFICE_ROOM_TITLE && room.coordinator_handle === "representative",
    );
    if (existing) return existing;
    const work = await dependencies.works.getWork(context, workId);
    const opened = await dependencies.works.openRoom(context, {
      commandId: `${input.runId}:core-office-room`,
      workId,
      expectedRevision: work.revision,
      title: CORE_OFFICE_ROOM_TITLE,
      coordinatorHandle: "representative",
      participants: [
        { kind: "user", subjectId: context.userId, role: "participant" },
        ...CORE_OFFICE_HANDLES.map((handle) => ({
          kind: "agent" as const,
          subjectId: handle,
          role: handle === "representative" ? ("coordinator" as const) : ("participant" as const),
        })),
      ],
      limits: {
        maxParallel: CORE_OFFICE_HANDLES.length,
        maxTokens: tokenBudget,
        maxCostMicros: 1_000_000,
        maxRounds: 100,
      },
    });
    return opened.room;
  };
  const intake: CoreWorkStageExecutor = {
    async execute(context, input) {
      const value = request(input.request);
      let workId = input.workId;
      if (workId === undefined) {
        const snapshot = await dependencies.graph.getCurrentSnapshot(context);
        throwIfCancelled(input);
        const created = await dependencies.works.createWork(context, {
          commandId: `${input.commandId}:work`,
          text: value.text,
          surface: value.surface,
          organizationVersionId: snapshot.version.version_id,
          ...(value.projectId === undefined ? {} : { projectId: value.projectId }),
        });
        workId = created.work.work_id;
        if (input.signal?.aborted) await cancelAndThrowIfCancelled(context, input, workId);
      }
      if (input.signal?.aborted) await cancelAndThrowIfCancelled(context, input, workId);
      const room = await coreOfficeRoom(context, input, workId, value.tokenBudget);
      await cancelAndThrowIfCancelled(context, input, workId);
      const requestMessage = await dependencies.works.postMessage(context, {
        commandId: `${input.runId}:core-office-request`,
        workId,
        roomId: room.room_id,
        messageType: "question",
        authorKind: "user",
        authorId: context.userId,
        content: value.text,
        tokenCount: 0,
        costMicros: 0,
      });
      await cancelAndThrowIfCancelled(context, input, workId);
      const runtime = await dependencies.representative.execute(context, {
        commandId: `${input.commandId}:representative`,
        workId,
        agentHandle: "representative",
        modelRoute: "orchestration-balanced",
        correlationId: input.correlationId,
        estimatedTokens: value.tokenBudget,
        estimatedCostMicros: 0,
        input: { operation: "coordinate_work", request: value },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (runtime.status === "blocked_model_unavailable")
        return { outcome: "blocked", reason: "model-unavailable", workId };
      if (runtime.status !== "succeeded")
        return { outcome: "blocked", reason: `representative-${runtime.status}`, workId };
      if (input.signal?.aborted) return { outcome: "blocked", reason: "representative-cancelled", workId };
      await dependencies.works.postMessage(context, {
        commandId: `${input.commandId}:representative-handoff`,
        workId,
        roomId: room.room_id,
        messageType: "handoff",
        authorKind: "agent",
        authorId: "representative",
        content: handoffContent(runtime.output),
        replyToMessageId: requestMessage.message.message_id,
        causedByMessageId: requestMessage.message.message_id,
        executionId: runtime.executionId,
        tokenCount: 0,
        costMicros: 0,
      });
      await cancelAndThrowIfCancelled(context, input, workId);
      return {
        outcome: "advanced",
        workId,
        data: { representativeExecutionId: runtime.executionId, roomId: room.room_id },
      };
    },
    async cancel(context, input) {
      const executionCommand = `${input.commandId.replace(/:cancel$/u, "")}:representative`;
      const executionId = await dependencies.runtimeExecutions.findExecutionIdByCommand(context, executionCommand);
      if (executionId) await dependencies.representative.cancel(context, executionId, "Application run cancelled");
    },
  };
  const strategy: CoreWorkStageExecutor = {
    async execute(context, input) {
      if (!input.workId) throw new Error("context-strategy stage에 Work ID가 없습니다");
      const value = request(input.request);
      const work = await dependencies.works.getWork(context, input.workId);
      throwIfCancelled(input);
      const sourceContent = { text: value.text };
      const room = (await dependencies.works.listRooms(context, input.workId)).find(
        (candidate) => candidate.title === CORE_OFFICE_ROOM_TITLE && candidate.coordinator_handle === "representative",
      );
      throwIfCancelled(input);
      const messages = room ? await dependencies.works.listMessages(context, input.workId, room.room_id) : [];
      throwIfCancelled(input);
      const sources: ContextSource[] = [
        {
          kind: "request",
          sourceId: input.runId,
          revision: "1",
          contentHash: hashContextContent(sourceContent),
          observedAt: new Date().toISOString(),
          classification: "internal",
          priority: 100,
          estimatedTokens: Math.max(1, Math.ceil(value.text.length / 4)),
          mandatory: true,
          content: sourceContent,
        },
      ];
      if (room && messages.length > 0) {
        const collaborationContent = {
          roomId: room.room_id,
          messages: messages.map((message) => ({
            sequence: message.sequence,
            messageType: message.message_type,
            authorKind: message.author_kind,
            authorId: message.author_id,
            content: message.content,
          })),
        };
        const serialized = JSON.stringify(collaborationContent);
        sources.push({
          kind: "collaboration",
          sourceId: room.room_id,
          revision: String(messages.at(-1)?.sequence ?? 0),
          contentHash: hashContextContent(collaborationContent),
          observedAt: new Date().toISOString(),
          classification: "internal",
          priority: 90,
          estimatedTokens: Math.max(1, Math.ceil(serialized.length / 4)),
          mandatory: false,
          content: collaborationContent,
        });
      }
      const planInput: PlanStrategyInput = {
        commandId: input.commandId,
        workId: input.workId,
        expectedWorkRevision: work.revision,
        tokenBudget: value.tokenBudget,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        context: {
          objective: value.text,
          scopeIn: value.scopeIn,
          scopeOut: value.scopeOut,
          constraints: value.constraints,
          assumptions: value.assumptions,
          unknowns: value.unknowns,
          decisions: value.decisions,
          sources,
        },
      };
      const planned: PlanStrategyResult = await dependencies.strategy.plan(context, planInput);
      if (planned.generation.status === "blocked_model_unavailable")
        return { outcome: "blocked", reason: "model-unavailable" };
      if (planned.generation.status !== "applied" || !planned.projection)
        return { outcome: "blocked", reason: `strategy-${planned.generation.status}` };
      return {
        outcome: "advanced",
        data: {
          contextVersionId: planned.contextVersion.contextVersionId,
          strategyGenerationId: planned.generation.strategyGenerationId,
        },
      };
    },
    async cancel(context, input) {
      const strategyCommandId = input.commandId.replace(/:cancel$/u, "");
      const executionId = await dependencies.runtimeExecutions.findExecutionIdByCommand(
        context,
        `${strategyCommandId}:generate:runtime`,
      );
      if (executionId) await dependencies.representative.cancel(context, executionId, "Application run cancelled");
    },
  };
  const cancelWork = (stage: StagePort): CoreWorkStageExecutor => ({
    execute: async (context, input) => await stage.execute(context, input),
    async cancel(context, input) {
      let cleanupError: Error | undefined;
      try {
        await stage.cancel?.(context, input);
      } catch (error) {
        cleanupError = error instanceof Error ? error : new Error(String(error), { cause: error });
      }
      if (input.workId) await cancelCreatedWork(context, input.runId, input.workId);
      if (cleanupError) throw cleanupError;
    },
  });
  return {
    intake: cancelWork(intake),
    "context-strategy": cancelWork(strategy),
    evidence: cancelWork(dependencies.evidence),
    delivery: cancelWork(dependencies.delivery),
    assurance: cancelWork(dependencies.assurance),
    records: cancelWork(dependencies.records),
  };
}
