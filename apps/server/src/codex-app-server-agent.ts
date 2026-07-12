import { dirname, isAbsolute, relative } from "node:path";

import type { TenantContext } from "@massion/identity";
import {
  inspectBundledSubscriptionRuntime,
  type StructuredOutputSpec,
  type SubscriptionAgentAdapter,
  type SubscriptionAgentInput,
  type SubscriptionAgentResult,
  type SubscriptionAgentResumeInput,
  type SubscriptionPermissionBridge,
} from "@massion/runtime";

import {
  openCodexAppServer,
  type CodexAppServerConnection,
  type CodexAppServerInboundRequest,
  type CodexAppServerOptions,
} from "./codex-app-server.js";

type JsonRecord = Record<string, unknown>;

export type CodexAppServerOpen = (
  command: string,
  commandArguments: readonly string[],
  environment: Readonly<Record<string, string>>,
  options?: CodexAppServerOptions,
) => Promise<CodexAppServerConnection>;

export interface CodexAppServerSubscriptionConnectorOptions {
  readonly model: string;
  readonly policy: {
    readonly sandboxMode: "read-only" | "workspace-write";
    readonly approvalPolicy: "on-request";
    readonly networkAccessEnabled: boolean;
  };
  readonly runtime?: () => Promise<{ readonly command: string; readonly commandArguments: readonly string[] }>;
  readonly timeoutMs?: number;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

interface PendingApproval {
  readonly approvalId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly response: Deferred<{ readonly decision: "accept" | "decline" | "cancel" }>;
}

interface ActiveTurn {
  readonly context: TenantContext;
  readonly input: SubscriptionAgentInput;
  readonly output: StructuredOutputSpec | undefined;
  readonly completion: Deferred<SubscriptionAgentResult>;
  readonly suspension: Deferred<Extract<SubscriptionAgentResult, { readonly outcome: "suspended" }>>;
  connection?: CodexAppServerConnection;
  threadId?: string;
  turnId?: string;
  finalText?: string;
  usage?: { readonly inputTokens: number; readonly outputTokens: number };
  pending: PendingApproval | undefined;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (error) => rejectPromise?.(error),
  };
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 응답이 유효하지 않습니다`);
  }
  return value as JsonRecord;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    throw new Error(`${label}가 유효하지 않습니다`);
  }
  return value;
}

function optionalText(value: unknown, label: string, maximum = 16_384): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximum || /\0/u.test(value)) {
    throw new Error(`${label}가 유효하지 않습니다`);
  }
  return value;
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label}이 유효하지 않습니다`);
  return Number(value);
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function sameTenant(left: TenantContext, right: TenantContext): boolean {
  return left.organizationId === right.organizationId && left.userId === right.userId;
}

function sandboxPolicy(input: SubscriptionAgentInput, options: CodexAppServerSubscriptionConnectorOptions) {
  if (options.policy.sandboxMode === "read-only") {
    return { type: "readOnly" as const, networkAccess: options.policy.networkAccessEnabled };
  }
  return {
    type: "workspaceWrite" as const,
    writableRoots: [input.workspaceRoot],
    networkAccess: options.policy.networkAccessEnabled,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  };
}

function threadConfiguration(input: SubscriptionAgentInput, options: CodexAppServerSubscriptionConnectorOptions) {
  return {
    model: options.model,
    cwd: input.workspaceRoot,
    runtimeWorkspaceRoots: [input.workspaceRoot],
    approvalPolicy: options.policy.approvalPolicy,
    approvalsReviewer: "user",
    sandbox: options.policy.sandboxMode,
  };
}

export class CodexAppServerSubscriptionConnector implements SubscriptionAgentAdapter {
  private readonly runtime: NonNullable<CodexAppServerSubscriptionConnectorOptions["runtime"]>;
  private active: ActiveTurn | undefined;

  public constructor(
    private readonly permissions: SubscriptionPermissionBridge,
    private readonly options: CodexAppServerSubscriptionConnectorOptions,
    private readonly open: CodexAppServerOpen = openCodexAppServer,
  ) {
    if (!options.model.trim() || options.model.length > 256 || /[\0\r\n]/u.test(options.model)) {
      throw new Error("Codex app-server model이 유효하지 않습니다");
    }
    if (
      !new Set(["read-only", "workspace-write"]).has(options.policy.sandboxMode) ||
      typeof options.policy.networkAccessEnabled !== "boolean"
    ) {
      throw new Error("Codex app-server 실행 정책이 유효하지 않습니다");
    }
    if (
      options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 86_400_000)
    ) {
      throw new Error("Codex app-server 실행 제한 시간이 유효하지 않습니다");
    }
    this.runtime =
      options.runtime ??
      (async () => {
        const artifact = await inspectBundledSubscriptionRuntime("codex");
        return { command: artifact.command, commandArguments: artifact.commandArguments };
      });
  }

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
    const active = this.active;
    const pending = active?.pending;
    if (!active || !pending) throw new Error("재개할 Codex app-server 승인이 없습니다");
    if (!sameTenant(active.context, context) || active.input.executionId !== input.executionId) {
      throw new Error("Codex app-server 실행 계보가 일치하지 않습니다");
    }
    if (approval.sessionId !== pending.threadId || approval.approvalId !== pending.approvalId) {
      throw new Error("Codex app-server 승인 계보가 일치하지 않습니다");
    }
    active.pending = undefined;
    pending.response.resolve({ decision: approval.approved ? "accept" : "decline" });
    try {
      const result = await active.completion.promise;
      await this.close(active);
      return result;
    } catch (error) {
      await this.close(active);
      throw error;
    }
  }

  public async cancel(context: TenantContext, executionId: string): Promise<void> {
    const active = this.active;
    if (!active) return;
    if (!sameTenant(active.context, context) || active.input.executionId !== executionId) {
      throw new Error("Codex app-server 실행 계보가 일치하지 않습니다");
    }
    if (active.pending) {
      active.pending.response.resolve({ decision: "cancel" });
      active.pending = undefined;
    }
    const connection = active.connection;
    if (!connection || !active.threadId || !active.turnId) {
      await this.close(active);
      return;
    }
    try {
      await connection.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId });
      await active.completion.promise;
    } finally {
      await this.close(active);
    }
  }

  private async run(
    context: TenantContext,
    input: SubscriptionAgentInput,
    output?: StructuredOutputSpec,
  ): Promise<SubscriptionAgentResult> {
    if (this.active) throw new Error("같은 Codex app-server adapter를 동시에 실행할 수 없습니다");
    if (!isAbsolute(input.workspaceRoot) || !isAbsolute(input.profileRoot)) {
      throw new Error("Codex app-server workspace와 profile root는 절대 경로여야 합니다");
    }
    if (input.allowedTools.length > 0 || input.disallowedTools.length > 0) {
      throw new Error("Codex app-server는 Massion 요청별 도구 목록 정책을 지원하지 않습니다");
    }
    const active: ActiveTurn = {
      context,
      input,
      output,
      completion: deferred(),
      suspension: deferred(),
      pending: undefined,
    };
    this.active = active;
    try {
      const runtime = await this.runtime();
      if (!isAbsolute(runtime.command) || runtime.commandArguments.some((value) => /[\0\r\n]/u.test(value))) {
        throw new Error("Codex app-server runtime artifact가 유효하지 않습니다");
      }
      const environment: Record<string, string> = {
        CODEX_HOME: input.profileRoot,
        HOME: input.profileRoot,
        LANG: input.environment.LANG ?? "C.UTF-8",
        NO_COLOR: "1",
        PATH: input.environment.PATH ?? dirname(runtime.command),
        ...(input.environment.LC_ALL ? { LC_ALL: input.environment.LC_ALL } : {}),
      };
      active.connection = await this.open(runtime.command, runtime.commandArguments, environment, {
        timeoutMs: this.options.timeoutMs ?? 86_400_000,
        maximumOutputBytes: 64 * 1024 * 1024,
        requestHandlers: {
          "item/commandExecution/requestApproval": async (request) => await this.approval(active, request, "command"),
          "item/fileChange/requestApproval": async (request) => await this.approval(active, request, "file"),
        },
        onNotification: (notification) => {
          this.notification(active, notification.method, notification.params);
        },
        onFailure: (error) => {
          active.completion.reject(error);
          active.suspension.reject(error);
        },
      });
      const configuration = threadConfiguration(input, this.options);
      const threadResponse = record(
        input.sessionId
          ? await active.connection.request("thread/resume", { threadId: input.sessionId, ...configuration })
          : await active.connection.request("thread/start", configuration),
        input.sessionId ? "Codex thread/resume" : "Codex thread/start",
      );
      active.threadId = identifier(record(threadResponse.thread, "Codex thread").id, "Codex thread ID");
      if (input.sessionId && active.threadId !== input.sessionId) {
        throw new Error("Codex app-server session 계보가 일치하지 않습니다");
      }
      const turnResponse = record(
        await active.connection.request("turn/start", {
          threadId: active.threadId,
          input: [{ type: "text", text: input.prompt, text_elements: [] }],
          ...configuration,
          sandboxPolicy: sandboxPolicy(input, this.options),
          ...(output ? { outputSchema: output.jsonSchema } : {}),
        }),
        "Codex turn/start",
      );
      const turnId = identifier(record(turnResponse.turn, "Codex turn").id, "Codex turn ID");
      if (active.turnId && active.turnId !== turnId) throw new Error("Codex app-server turn 계보가 일치하지 않습니다");
      active.turnId = turnId;
      const first = await Promise.race([active.completion.promise, active.suspension.promise]);
      if (first.outcome === "suspended") return first;
      await this.close(active);
      return first;
    } catch (error) {
      await this.close(active);
      throw error;
    }
  }

  private async approval(
    active: ActiveTurn,
    request: CodexAppServerInboundRequest,
    kind: "command" | "file",
  ): Promise<{ readonly decision: "accept" | "decline" | "cancel" }> {
    const params = record(request.params, "Codex 승인 요청");
    const threadId = identifier(params.threadId, "Codex 승인 thread ID");
    const turnId = identifier(params.turnId, "Codex 승인 turn ID");
    const itemId = identifier(params.itemId, "Codex 승인 item ID");
    if (!active.threadId || active.threadId !== threadId || (active.turnId && active.turnId !== turnId)) {
      throw new Error("Codex app-server 승인 계보가 일치하지 않습니다");
    }
    active.turnId = turnId;
    if (active.pending) throw new Error("Codex app-server 동시 승인 요청은 허용하지 않습니다");
    const reason = optionalText(params.reason, "Codex 승인 이유");
    const toolInput: Record<string, unknown> = {};
    if (kind === "command") {
      const command = optionalText(params.command, "Codex 승인 command");
      const cwd = optionalText(params.cwd, "Codex 승인 cwd", 4_096);
      if (cwd && (!isAbsolute(cwd) || !inside(active.input.workspaceRoot, cwd))) {
        return { decision: "decline" };
      }
      if (command !== undefined) toolInput.command = command;
      if (cwd !== undefined) toolInput.cwd = cwd;
      if (reason !== undefined) toolInput.reason = reason;
    } else {
      const grantRoot = optionalText(params.grantRoot, "Codex 승인 grant root", 4_096);
      if (grantRoot && (!isAbsolute(grantRoot) || !inside(active.input.workspaceRoot, grantRoot))) {
        return { decision: "decline" };
      }
      if (reason !== undefined) toolInput.reason = reason;
      if (grantRoot !== undefined) toolInput.grantRoot = grantRoot;
    }
    const decision = await this.permissions.request(active.context, {
      executionId: active.input.executionId,
      workId: active.input.workId,
      agentHandle: active.input.agentHandle,
      toolName: kind === "command" ? "CodexCommandExecution" : "CodexFileChange",
      toolInput,
      toolUseId: itemId,
      permissionRequestId: identifier(String(request.id), "Codex server request ID"),
    });
    if (decision.outcome === "allow") return { decision: "accept" };
    if (decision.outcome === "deny") return { decision: "decline" };
    const response = deferred<{ readonly decision: "accept" | "decline" | "cancel" }>();
    active.pending = {
      approvalId: identifier(decision.approvalId, "Governance 승인 ID"),
      threadId,
      turnId,
      itemId,
      response,
    };
    active.suspension.resolve({
      outcome: "suspended",
      executionId: active.input.executionId,
      sessionId: threadId,
      approvalId: decision.approvalId,
    });
    return await response.promise;
  }

  private notification(active: ActiveTurn, method: string, value: unknown): void {
    if (method === "item/completed") {
      const params = record(value, "Codex item/completed");
      this.notificationLineage(active, params.threadId, params.turnId);
      const item = record(params.item, "Codex completed item");
      if (item.type === "agentMessage") {
        active.finalText = optionalText(item.text, "Codex 최종 응답", 16 * 1024 * 1024) ?? "";
      }
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const params = record(value, "Codex token usage");
      this.notificationLineage(active, params.threadId, params.turnId);
      const last = record(record(params.tokenUsage, "Codex token usage").last, "Codex turn token usage");
      active.usage = {
        inputTokens: safeInteger(last.inputTokens, "Codex 입력 token"),
        outputTokens: safeInteger(last.outputTokens, "Codex 출력 token"),
      };
      return;
    }
    if (method !== "turn/completed") return;
    const params = record(value, "Codex turn/completed");
    const turn = record(params.turn, "Codex completed turn");
    this.notificationLineage(active, params.threadId, turn.id);
    const threadId = active.threadId;
    if (!threadId) throw new Error("Codex app-server thread ID가 없습니다");
    if (turn.status === "interrupted") {
      active.completion.resolve({ outcome: "cancelled", executionId: active.input.executionId, sessionId: threadId });
      return;
    }
    if (turn.status === "failed") {
      active.completion.resolve({
        outcome: "failed",
        executionId: active.input.executionId,
        sessionId: threadId,
        category: "codex-turn-failed",
        retryable: false,
        emittedTokens: active.finalText ? 1 : 0,
        sideEffectsStarted: true,
      });
      return;
    }
    if (turn.status !== "completed") {
      active.completion.reject(new Error("Codex app-server terminal turn 상태가 유효하지 않습니다"));
      return;
    }
    let result: unknown = active.finalText ?? "";
    if (active.output) {
      try {
        result = JSON.parse(active.finalText ?? "") as unknown;
      } catch (error) {
        active.completion.reject(new Error("Codex app-server 구조화 출력 JSON이 유효하지 않습니다", { cause: error }));
        return;
      }
      const validation = active.output.validate?.(result);
      if (validation && !validation.success) {
        active.completion.reject(validation.error);
        return;
      }
      if (validation?.success) result = validation.value;
    }
    active.completion.resolve({
      outcome: "completed",
      executionId: active.input.executionId,
      sessionId: threadId,
      value: result,
      ...(active.usage ? { usage: active.usage } : {}),
    });
  }

  private notificationLineage(active: ActiveTurn, threadId: unknown, turnId: unknown): void {
    const normalizedThread = identifier(threadId, "Codex notification thread ID");
    const normalizedTurn = identifier(turnId, "Codex notification turn ID");
    if (
      !active.threadId ||
      active.threadId !== normalizedThread ||
      (active.turnId && active.turnId !== normalizedTurn)
    ) {
      throw new Error("Codex app-server notification 계보가 일치하지 않습니다");
    }
    active.turnId = normalizedTurn;
  }

  private async close(active: ActiveTurn): Promise<void> {
    if (this.active === active) this.active = undefined;
    await active.connection?.close();
  }
}
