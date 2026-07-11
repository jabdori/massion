import { isAbsolute } from "node:path";

import {
  Codex,
  type CodexOptions,
  type Input,
  type RunResult,
  type ThreadOptions,
  type TurnOptions,
} from "@openai/codex-sdk";

import type { TenantContext } from "@massion/identity";

import type { StructuredOutputSpec } from "../contracts.js";
import type {
  SubscriptionAgentAdapter,
  SubscriptionAgentInput,
  SubscriptionAgentResult,
  SubscriptionAgentResumeInput,
} from "./agent-runtime.js";

export interface CodexSdkThread {
  readonly id: string | null;
  run(input: Input, options?: TurnOptions): Promise<RunResult>;
}

export interface CodexSdkClient {
  startThread(options?: ThreadOptions): CodexSdkThread;
  resumeThread(id: string, options?: ThreadOptions): CodexSdkThread;
}

export interface CodexSdkFactory {
  create(options: CodexOptions): CodexSdkClient;
}

const OFFICIAL_CODEX_FACTORY: CodexSdkFactory = {
  create: (options) => new Codex(options),
};

function requirePath(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`${label}는 절대 경로여야 합니다`);
  return value;
}

export class CodexSubscriptionConnector implements SubscriptionAgentAdapter {
  private readonly active = new Map<string, AbortController>();

  public constructor(
    private readonly factory: CodexSdkFactory = OFFICIAL_CODEX_FACTORY,
    private readonly options: { readonly allowedEnvironment: readonly string[] } = {
      allowedEnvironment: ["PATH", "CODEX_HOME", "LANG", "LC_ALL"],
    },
  ) {}

  public async execute(_context: TenantContext, input: SubscriptionAgentInput): Promise<SubscriptionAgentResult> {
    return await this.run(input);
  }

  public async executeStructured(
    _context: TenantContext,
    input: SubscriptionAgentInput,
    output: StructuredOutputSpec,
  ): Promise<SubscriptionAgentResult> {
    return await this.run(input, output);
  }

  public async resume(
    context: TenantContext,
    input: SubscriptionAgentInput,
    approval: SubscriptionAgentResumeInput,
  ): Promise<SubscriptionAgentResult> {
    if (!approval.approved) {
      return { outcome: "cancelled", executionId: input.executionId, sessionId: approval.sessionId };
    }
    return await this.execute(context, { ...input, sessionId: approval.sessionId });
  }

  public async cancel(_context: TenantContext, executionId: string): Promise<void> {
    this.active.get(executionId)?.abort("cancelled");
  }

  private async run(input: SubscriptionAgentInput, output?: StructuredOutputSpec): Promise<SubscriptionAgentResult> {
    const workspaceRoot = requirePath(input.workspaceRoot, "Codex workspace root");
    const profileRoot = requirePath(input.profileRoot, "Codex profile root");
    const env = Object.fromEntries(
      this.options.allowedEnvironment.flatMap((key) => {
        const value = key === "CODEX_HOME" ? profileRoot : input.environment[key];
        return value === undefined ? [] : [[key, value]];
      }),
    );
    const client = this.factory.create({ env });
    const threadOptions: ThreadOptions = { workingDirectory: workspaceRoot };
    const thread = input.sessionId
      ? client.resumeThread(input.sessionId, threadOptions)
      : client.startThread(threadOptions);
    const abortController = new AbortController();
    this.active.set(input.executionId, abortController);
    try {
      const turn = await thread.run(input.prompt, {
        ...(output ? { outputSchema: output.jsonSchema } : {}),
        signal: abortController.signal,
      });
      const sessionId = thread.id;
      if (!sessionId) throw new Error("Codex thread ID가 생성되지 않았습니다");
      let value: unknown = turn.finalResponse;
      if (output) {
        try {
          value = JSON.parse(turn.finalResponse) as unknown;
        } catch (error) {
          throw new Error("Codex 구조화 출력 JSON이 유효하지 않습니다", { cause: error });
        }
        const validation = output.validate?.(value);
        if (validation && !validation.success) throw validation.error;
        if (validation?.success) value = validation.value;
      }
      return {
        outcome: "completed",
        executionId: input.executionId,
        sessionId,
        value,
        ...(turn.usage ? { usage: turn.usage } : {}),
      };
    } catch (error) {
      if (abortController.signal.aborted) {
        return {
          outcome: "cancelled",
          executionId: input.executionId,
          ...(thread.id ? { sessionId: thread.id } : {}),
        };
      }
      throw error;
    } finally {
      this.active.delete(input.executionId);
    }
  }
}
