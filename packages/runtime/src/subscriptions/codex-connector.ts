import { isAbsolute } from "node:path";

import {
  Codex,
  type CodexOptions,
  type Input,
  type ApprovalMode,
  type RunResult,
  type SandboxMode,
  type ThreadOptions,
  type TurnOptions,
} from "@openai/codex-sdk";

import type { TenantContext } from "@massion/identity";

import type { StructuredOutputSpec } from "../contracts.js";
import { managedCodexCredentialState } from "./codex-profile.js";
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

export interface CodexSubscriptionConnectorOptions {
  readonly allowedEnvironment: readonly string[];
  /** Massion이 생성·수명 관리하는 격리 profile에만 파일 credential store를 강제합니다. */
  readonly managedProfile?: boolean;
  readonly executable?: string;
  readonly threadPolicy?: {
    readonly sandboxMode: Exclude<SandboxMode, "danger-full-access">;
    readonly approvalPolicy: Extract<ApprovalMode, "never" | "on-request">;
    readonly networkAccessEnabled: boolean;
    readonly model?: string;
  };
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
    private readonly options: CodexSubscriptionConnectorOptions = {
      allowedEnvironment: ["PATH", "CODEX_HOME", "LANG", "LC_ALL"],
    },
  ) {
    if (options.executable !== undefined && !isAbsolute(options.executable)) {
      throw new Error("Codex SDK 실행 파일은 절대 경로여야 합니다");
    }
    const policy = options.threadPolicy;
    if (
      policy &&
      (!new Set(["read-only", "workspace-write"]).has(policy.sandboxMode) ||
        !new Set(["never", "on-request"]).has(policy.approvalPolicy) ||
        typeof policy.networkAccessEnabled !== "boolean" ||
        (policy.model !== undefined && !policy.model.trim()))
    ) {
      throw new Error("Codex SDK 실행 정책이 유효하지 않습니다");
    }
  }

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

  public cancel(_context: TenantContext, executionId: string): Promise<void> {
    this.active.get(executionId)?.abort("cancelled");
    return Promise.resolve();
  }

  private async run(input: SubscriptionAgentInput, output?: StructuredOutputSpec): Promise<SubscriptionAgentResult> {
    const workspaceRoot = requirePath(input.workspaceRoot, "Codex workspace root");
    const profileRoot = requirePath(input.profileRoot, "Codex profile root");
    if (this.options.managedProfile && (await managedCodexCredentialState(profileRoot)) !== "present") {
      throw new Error("관리 Codex profile에 재인증이 필요합니다");
    }
    const selectedEnvironment = Object.fromEntries(
      this.options.allowedEnvironment.flatMap((key) => {
        const value = key === "CODEX_HOME" ? profileRoot : input.environment[key];
        return value === undefined ? [] : [[key, value]];
      }),
    );
    const env = this.options.managedProfile
      ? { ...selectedEnvironment, CODEX_HOME: profileRoot, HOME: profileRoot }
      : selectedEnvironment;
    const client = this.factory.create({
      ...(this.options.executable ? { codexPathOverride: this.options.executable } : {}),
      env,
      ...(this.options.managedProfile ? { config: { cli_auth_credentials_store: "file" } } : {}),
    });
    const threadOptions: ThreadOptions = {
      workingDirectory: workspaceRoot,
      ...(this.options.threadPolicy
        ? {
            sandboxMode: this.options.threadPolicy.sandboxMode,
            approvalPolicy: this.options.threadPolicy.approvalPolicy,
            networkAccessEnabled: this.options.threadPolicy.networkAccessEnabled,
            ...(this.options.threadPolicy.model ? { model: this.options.threadPolicy.model } : {}),
          }
        : {}),
    };
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
