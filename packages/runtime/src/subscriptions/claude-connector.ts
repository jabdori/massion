import { isAbsolute } from "node:path";

import {
  query as officialQuery,
  type Options,
  type PermissionResult,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { TenantContext } from "@massion/identity";

import type { StructuredOutputSpec } from "../contracts.js";
import type {
  SubscriptionAgentAdapter,
  SubscriptionAgentInput,
  SubscriptionAgentResult,
  SubscriptionAgentResumeInput,
} from "./agent-runtime.js";

export interface SubscriptionPermissionBridge {
  request(
    context: TenantContext,
    input: {
      readonly executionId: string;
      readonly workId: string;
      readonly agentHandle: string;
      readonly toolName: string;
      readonly toolInput: Readonly<Record<string, unknown>>;
      readonly title?: string;
      readonly decisionReason?: string;
    },
  ): Promise<
    | { readonly outcome: "allow" }
    | { readonly outcome: "deny"; readonly reason: string }
    | { readonly outcome: "suspend"; readonly approvalId: string }
  >;
}

export interface ClaudeQueryHandle extends AsyncIterable<SDKMessage | Record<string, unknown>> {
  interrupt?(): Promise<unknown>;
  close?(): void;
}

export type ClaudeAgentQuery = (input: { readonly prompt: string; readonly options: Options }) => ClaudeQueryHandle;

const OFFICIAL_QUERY: ClaudeAgentQuery = (input) => officialQuery(input);

interface PendingPermission {
  readonly approvalId: string;
  readonly toolName: string;
}

function resultMessage(message: SDKMessage | Record<string, unknown>): SDKResultMessage | undefined {
  return message.type === "result" ? (message as SDKResultMessage) : undefined;
}

export class ClaudeSubscriptionConnector implements SubscriptionAgentAdapter {
  private readonly active = new Map<string, ClaudeQueryHandle>();
  private readonly pending = new Map<string, PendingPermission>();

  public constructor(
    private readonly query: ClaudeAgentQuery = OFFICIAL_QUERY,
    private readonly permissions: SubscriptionPermissionBridge = {
      request: () => Promise.resolve({ outcome: "deny", reason: "Governance permission bridge가 연결되지 않았습니다" }),
    },
  ) {}

  public async execute(context: TenantContext, input: SubscriptionAgentInput): Promise<SubscriptionAgentResult> {
    return await this.run(context, input);
  }

  public async executeStructured(
    context: TenantContext,
    input: SubscriptionAgentInput,
    output: StructuredOutputSpec,
  ): Promise<SubscriptionAgentResult> {
    return await this.run(context, input, output);
  }

  public async resume(
    context: TenantContext,
    input: SubscriptionAgentInput,
    approval: SubscriptionAgentResumeInput,
  ): Promise<SubscriptionAgentResult> {
    const pending = this.pending.get(input.executionId);
    if (!pending || pending.approvalId !== approval.approvalId)
      throw new Error("Claude 실행 승인 ID가 일치하지 않습니다");
    if (!approval.approved) {
      this.pending.delete(input.executionId);
      return { outcome: "cancelled", executionId: input.executionId, sessionId: approval.sessionId };
    }
    return await this.run(context, { ...input, sessionId: approval.sessionId }, undefined, pending);
  }

  public async cancel(_context: TenantContext, executionId: string): Promise<void> {
    const active = this.active.get(executionId);
    if (!active) return;
    if (active.interrupt) await active.interrupt();
    active.close?.();
  }

  private async run(
    context: TenantContext,
    input: SubscriptionAgentInput,
    output?: StructuredOutputSpec,
    approvedPermission?: PendingPermission,
  ): Promise<SubscriptionAgentResult> {
    if (!isAbsolute(input.workspaceRoot) || !isAbsolute(input.profileRoot)) {
      throw new Error("Claude workspace와 profile root는 절대 경로여야 합니다");
    }
    const abortController = new AbortController();
    let suspended: PendingPermission | undefined;
    let approvedConsumed = false;
    const environment: Record<string, string> = {};
    for (const key of ["PATH", "LANG", "LC_ALL"]) {
      const value = input.environment[key];
      if (value !== undefined) environment[key] = value;
    }
    environment.CLAUDE_CONFIG_DIR = input.profileRoot;
    environment.CLAUDE_AGENT_SDK_CLIENT_APP = "massion/1.0.0";
    const options: Options = {
      cwd: input.workspaceRoot,
      env: environment,
      abortController,
      allowedTools: [...input.allowedTools],
      disallowedTools: [...input.disallowedTools],
      permissionMode: "default",
      settingSources: [],
      ...(input.sessionId ? { resume: input.sessionId } : {}),
      ...(output ? { outputFormat: { type: "json_schema", schema: output.jsonSchema } } : {}),
      canUseTool: async (toolName, toolInput, permissionContext): Promise<PermissionResult> => {
        if (approvedPermission && !approvedConsumed && toolName === approvedPermission.toolName) {
          approvedConsumed = true;
          this.pending.delete(input.executionId);
          return { behavior: "allow", decisionClassification: "user_temporary" };
        }
        const decision = await this.permissions.request(context, {
          executionId: input.executionId,
          workId: input.workId,
          agentHandle: input.agentHandle,
          toolName,
          toolInput,
          ...(permissionContext.title ? { title: permissionContext.title } : {}),
          ...(permissionContext.decisionReason ? { decisionReason: permissionContext.decisionReason } : {}),
        });
        if (decision.outcome === "allow") return { behavior: "allow", decisionClassification: "user_temporary" };
        if (decision.outcome === "deny") {
          return { behavior: "deny", message: decision.reason, decisionClassification: "user_reject" };
        }
        suspended = { approvalId: decision.approvalId, toolName };
        this.pending.set(input.executionId, suspended);
        return {
          behavior: "deny",
          message: "Massion Governance 승인 대기",
          interrupt: true,
          decisionClassification: "user_reject",
        };
      },
    };
    const handle = this.query({ prompt: input.prompt, options });
    this.active.set(input.executionId, handle);
    let result: SDKResultMessage | undefined;
    let sessionId = input.sessionId;
    try {
      for await (const message of handle) {
        if (typeof message.session_id === "string") sessionId = message.session_id;
        result = resultMessage(message) ?? result;
      }
    } finally {
      this.active.delete(input.executionId);
    }
    if (suspended) {
      if (!sessionId) throw new Error("Claude 승인 대기 session ID가 없습니다");
      return {
        outcome: "suspended",
        executionId: input.executionId,
        sessionId,
        approvalId: suspended.approvalId,
      };
    }
    if (!result || !sessionId) throw new Error("Claude Agent SDK terminal result가 없습니다");
    if (result.subtype !== "success") {
      return {
        outcome: abortController.signal.aborted ? "cancelled" : "failed",
        executionId: input.executionId,
        sessionId,
        ...(abortController.signal.aborted ? {} : { category: result.subtype, retryable: false }),
      } as SubscriptionAgentResult;
    }
    let value = output ? result.structured_output : result.result;
    if (output?.validate) {
      const validation = output.validate(value);
      if (!validation.success) throw validation.error;
      value = validation.value;
    }
    return {
      outcome: "completed",
      executionId: input.executionId,
      sessionId,
      value,
      usage: result.usage,
    };
  }
}
