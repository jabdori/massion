import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";

import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type ClientConnection,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type StopReason,
} from "@agentclientprotocol/sdk";

import type { TenantContext } from "@massion/identity";

import type {
  SubscriptionAgentAdapter,
  SubscriptionAgentInput,
  SubscriptionAgentResult,
  SubscriptionAgentResumeInput,
} from "./agent-runtime.js";

export interface AcpPromptResult {
  readonly text: string;
  readonly stopReason: StopReason;
  readonly usage?: unknown;
}

export interface AcpSession {
  readonly sessionId: string;
  prompt(prompt: string): Promise<AcpPromptResult>;
  cancel(): Promise<void>;
}

export interface AcpClient {
  openSession(input: { readonly workspaceRoot: string; readonly sessionId?: string }): Promise<AcpSession>;
  close(): Promise<void> | void;
}

export type AcpPermissionRequest = (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;

export interface AcpClientFactory {
  create(input: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly shell: false;
    readonly requestPermission: AcpPermissionRequest;
    readonly authenticationMethod?: string;
  }): Promise<AcpClient>;
}

export interface AcpPermissionBridge {
  request(
    context: TenantContext,
    input: {
      readonly executionId: string;
      readonly workId: string;
      readonly agentHandle: string;
      readonly request: RequestPermissionRequest;
    },
  ): Promise<RequestPermissionResponse>;
}

const DENY_PERMISSIONS: AcpPermissionBridge = {
  request: () => Promise.resolve({ outcome: { outcome: "cancelled" } }),
};

function childHasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let finished = false;
    const finish = (exited: boolean): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      resolve(exited);
    };
    const onExit = (): void => {
      finish(true);
    };
    const onError = (): void => {
      finish(true);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    timer.unref();
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

class NodeAcpSession implements AcpSession {
  public constructor(
    public readonly sessionId: string,
    private readonly client: NodeAcpClient,
  ) {}

  public async prompt(prompt: string): Promise<AcpPromptResult> {
    return await this.client.prompt(this.sessionId, prompt);
  }

  public async cancel(): Promise<void> {
    await this.client.cancel(this.sessionId);
  }
}

class NodeAcpClient implements AcpClient {
  private readonly connection: ClientConnection;
  private readonly textBySession = new Map<string, string[]>();
  private closePromise: Promise<void> | undefined;

  public constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    requestPermission: AcpPermissionRequest,
  ) {
    const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    this.connection = client({ name: "massion" })
      .onRequest(methods.client.session.requestPermission, async ({ params }) => await requestPermission(params))
      .onNotification(methods.client.session.update, ({ params }) => {
        this.recordUpdate(params);
      })
      .connect(ndJsonStream(output, input));
    child.stderr.resume();
  }

  public async initialize(authenticationMethod?: string): Promise<void> {
    const response = await this.connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "massion", version: "1.0.0" },
    });
    if (response.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`지원하지 않는 ACP protocol version입니다: ${String(response.protocolVersion)}`);
    }
    if (authenticationMethod) {
      if (!response.authMethods?.some((method) => method.id === authenticationMethod)) {
        throw new Error(`ACP Agent가 인증 방식을 지원하지 않습니다: ${authenticationMethod}`);
      }
      await this.connection.agent.request(methods.agent.authenticate, {
        methodId: authenticationMethod,
        _meta: { headless: true },
      });
    }
  }

  public async openSession(input: {
    readonly workspaceRoot: string;
    readonly sessionId?: string;
  }): Promise<AcpSession> {
    if (input.sessionId) {
      await this.connection.agent.request(methods.agent.session.load, {
        cwd: input.workspaceRoot,
        mcpServers: [],
        sessionId: input.sessionId,
      });
      return new NodeAcpSession(input.sessionId, this);
    }
    const response = await this.connection.agent.request(methods.agent.session.new, {
      cwd: input.workspaceRoot,
      mcpServers: [],
    });
    return new NodeAcpSession(response.sessionId, this);
  }

  public async prompt(sessionId: string, prompt: string): Promise<AcpPromptResult> {
    this.textBySession.set(sessionId, []);
    try {
      const response = await this.connection.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: prompt }],
      });
      const text = this.textBySession.get(sessionId)?.join("") ?? "";
      const usage = response._meta?.["quota"];
      return {
        text,
        stopReason: response.stopReason,
        ...(usage === undefined ? {} : { usage }),
      };
    } finally {
      this.textBySession.delete(sessionId);
    }
  }

  public async cancel(sessionId: string): Promise<void> {
    await this.connection.agent.notify(methods.agent.session.cancel, { sessionId });
  }

  public close(): Promise<void> {
    this.closePromise ??= this.shutdown();
    return this.closePromise;
  }

  private recordUpdate(notification: SessionNotification): void {
    const update = notification.update;
    if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") return;
    const chunks = this.textBySession.get(notification.sessionId);
    chunks?.push(update.content.text);
  }

  private async shutdown(): Promise<void> {
    this.connection.close();
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    if (childHasExited(this.child)) return;
    this.child.kill("SIGTERM");
    if (await waitForChildExit(this.child, 2_000)) return;
    this.child.kill("SIGKILL");
    await waitForChildExit(this.child, 2_000);
  }
}

export class NodeAcpClientFactory implements AcpClientFactory {
  public async create(input: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly shell: false;
    readonly requestPermission: AcpPermissionRequest;
    readonly authenticationMethod?: string;
  }): Promise<AcpClient> {
    const child = spawn(input.executable, [...input.args], {
      cwd: input.cwd,
      env: { ...input.env },
      shell: input.shell,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new NodeAcpClient(child, input.requestPermission);
    try {
      await client.initialize(input.authenticationMethod);
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }
}

interface ActiveAcpExecution {
  readonly client: AcpClient;
  readonly session: AcpSession;
  cancelled: boolean;
  closePromise?: Promise<void>;
}

interface AcpProcessConnectorOptions {
  readonly providerName: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly profileEnvironmentVariable: string;
  readonly toolPolicy: "copilot-flags" | "grok-flags" | "unsupported";
  readonly authenticationMethod?: string;
}

const NODE_ACP_FACTORY = new NodeAcpClientFactory();

function toolPattern(value: string): string {
  if (!value || value.length > 512 || value.startsWith("--") || /[\0\r\n]/u.test(value)) {
    throw new Error("ACP 도구 filter 값이 유효하지 않습니다");
  }
  return value;
}

export class AcpProcessConnector implements SubscriptionAgentAdapter {
  public static readonly protocolVersion = PROTOCOL_VERSION;
  private readonly active = new Map<string, ActiveAcpExecution>();

  public constructor(
    private readonly options: AcpProcessConnectorOptions,
    private readonly factory: AcpClientFactory = NODE_ACP_FACTORY,
    private readonly permissions: AcpPermissionBridge = DENY_PERMISSIONS,
  ) {}

  public async execute(context: TenantContext, input: SubscriptionAgentInput): Promise<SubscriptionAgentResult> {
    if (!isAbsolute(input.workspaceRoot) || !isAbsolute(input.profileRoot)) {
      throw new Error(`${this.options.providerName} workspace와 profile root는 절대 경로여야 합니다`);
    }
    if (!isAbsolute(this.options.executable)) {
      throw new Error(`${this.options.providerName} ACP 실행 파일은 절대 경로여야 합니다`);
    }
    if (
      this.options.toolPolicy === "unsupported" &&
      (input.allowedTools.length > 0 || input.disallowedTools.length > 0)
    ) {
      throw new Error(`${this.options.providerName} ACP는 Massion 요청별 도구 filter를 지원하지 않습니다`);
    }
    const env = Object.fromEntries(
      ["PATH", "LANG", "LC_ALL"].flatMap((key) => {
        const value = input.environment[key];
        return value === undefined ? [] : [[key, value]];
      }),
    );
    env[this.options.profileEnvironmentVariable] = input.profileRoot;
    const allowedTools = input.allowedTools.map(toolPattern).join(",");
    const disallowedTools = input.disallowedTools.map(toolPattern).join(",");
    const toolArgs =
      this.options.toolPolicy === "copilot-flags"
        ? [
            ...(allowedTools ? ["--available-tools", allowedTools] : []),
            ...(disallowedTools ? ["--excluded-tools", disallowedTools] : []),
          ]
        : this.options.toolPolicy === "grok-flags"
          ? [
              ...(allowedTools ? ["--tools", allowedTools] : []),
              ...(disallowedTools ? ["--disallowed-tools", disallowedTools] : []),
            ]
          : [];
    const client = await this.factory.create({
      executable: this.options.executable,
      args: [...this.options.args, ...toolArgs],
      cwd: input.workspaceRoot,
      env,
      shell: false,
      requestPermission: async (request) => {
        const response = await this.permissions.request(context, {
          executionId: input.executionId,
          workId: input.workId,
          agentHandle: input.agentHandle,
          request,
        });
        const outcome = response.outcome;
        if (outcome.outcome !== "selected") return response;
        return request.options.some((option) => option.optionId === outcome.optionId)
          ? response
          : { outcome: { outcome: "cancelled" } };
      },
      ...(this.options.authenticationMethod ? { authenticationMethod: this.options.authenticationMethod } : {}),
    });
    let session: AcpSession;
    try {
      session = await client.openSession({
        workspaceRoot: input.workspaceRoot,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      });
    } catch (error) {
      await client.close();
      throw error;
    }
    const active: ActiveAcpExecution = { client, session, cancelled: false };
    this.active.set(input.executionId, active);
    try {
      const response = await session.prompt(input.prompt);
      if (active.cancelled || response.stopReason === "cancelled") {
        return { outcome: "cancelled", executionId: input.executionId, sessionId: session.sessionId };
      }
      if (response.stopReason !== "end_turn") {
        return {
          outcome: "failed",
          executionId: input.executionId,
          sessionId: session.sessionId,
          category: `acp-${response.stopReason}`,
          retryable: false,
        };
      }
      return {
        outcome: "completed",
        executionId: input.executionId,
        sessionId: session.sessionId,
        value: response.text,
        ...(response.usage === undefined ? {} : { usage: response.usage }),
      };
    } catch (error) {
      if (active.cancelled) {
        return { outcome: "cancelled", executionId: input.executionId, sessionId: session.sessionId };
      }
      throw error;
    } finally {
      if (this.active.get(input.executionId) === active) this.active.delete(input.executionId);
      await this.close(active);
    }
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
    const active = this.active.get(executionId);
    if (!active) return;
    active.cancelled = true;
    try {
      await active.session.cancel();
    } finally {
      await this.close(active);
      if (this.active.get(executionId) === active) this.active.delete(executionId);
    }
  }

  private close(active: ActiveAcpExecution): Promise<void> {
    active.closePromise ??= Promise.resolve(active.client.close());
    return active.closePromise;
  }
}

export class CopilotAcpConnector extends AcpProcessConnector {
  public constructor(
    options: { readonly executable: string },
    factory: AcpClientFactory = NODE_ACP_FACTORY,
    permissions: AcpPermissionBridge = DENY_PERMISSIONS,
  ) {
    super(
      {
        providerName: "GitHub Copilot",
        executable: options.executable,
        args: ["--acp", "--stdio"],
        profileEnvironmentVariable: "COPILOT_HOME",
        toolPolicy: "copilot-flags",
      },
      factory,
      permissions,
    );
  }
}

export class GeminiCliAcpConnector extends AcpProcessConnector {
  public constructor(
    options: { readonly executable: string },
    factory: AcpClientFactory = NODE_ACP_FACTORY,
    permissions: AcpPermissionBridge = DENY_PERMISSIONS,
  ) {
    super(
      {
        providerName: "Google Gemini CLI",
        executable: options.executable,
        args: ["--acp"],
        profileEnvironmentVariable: "GEMINI_CLI_HOME",
        toolPolicy: "unsupported",
      },
      factory,
      permissions,
    );
  }
}

export class GrokBuildAcpConnector extends AcpProcessConnector {
  public constructor(
    options: { readonly executable: string },
    factory: AcpClientFactory = NODE_ACP_FACTORY,
    permissions: AcpPermissionBridge = DENY_PERMISSIONS,
  ) {
    super(
      {
        providerName: "xAI Grok Build",
        executable: options.executable,
        args: ["--no-auto-update", "agent", "stdio"],
        profileEnvironmentVariable: "HOME",
        toolPolicy: "grok-flags",
        authenticationMethod: "cached_token",
      },
      factory,
      permissions,
    );
  }
}
