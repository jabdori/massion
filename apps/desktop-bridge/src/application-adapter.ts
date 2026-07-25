import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  ApplicationHttpClient,
  ApplicationRemoteError,
  validateApplicationCommand,
  validateApplicationEvent,
} from "@massion/application";
import { defaultLocalEndpoint } from "@massion/local-control/access";
import { LocalDaemonManager } from "@massion/local-control/daemon";

import type { BridgeAdapter } from "./bridge.js";

export interface ApplicationHttpPort {
  status(): Promise<unknown>;
  me(): Promise<unknown>;
  query(operation: string, payload: unknown): Promise<unknown>;
  command(input: unknown): Promise<unknown>;
  streamEvents(after?: number, signal?: AbortSignal): AsyncIterable<unknown>;
  streamExecutionDeltas(executionId?: string, signal?: AbortSignal): AsyncIterable<unknown>;
}

export interface ApplicationAdapterDependencies {
  readonly startDaemon: () => Promise<unknown>;
  readonly stopDaemon: () => Promise<unknown>;
  readonly openLocalSession: () => Promise<string>;
  readonly createClient: (endpoint: string, token: string) => ApplicationHttpPort;
  readonly defaultEndpoint: string;
  readonly reconnectAttempts?: number;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export function createApplicationAdapter(dependencies: ApplicationAdapterDependencies): BridgeAdapter {
  return new ApplicationBridgeAdapter(dependencies);
}

export function createProductionApplicationAdapter(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): BridgeAdapter {
  const serverScript = environment.MASSION_SERVER_BIN;
  if (!serverScript || !isAbsolute(serverScript)) throw new Error("MASSION_SERVER_BIN 절대 경로가 필요합니다");
  const runtimeEnvironment = { ...environment };
  const daemon = new LocalDaemonManager({
    nodeExecutable: process.execPath,
    serverScript,
    runtimeVersion: process.version,
    environment: runtimeEnvironment,
  });
  const endpoint = defaultLocalEndpoint(runtimeEnvironment);
  return createApplicationAdapter({
    startDaemon: async () => await daemon.start(),
    stopDaemon: async () => await daemon.stop(),
    openLocalSession: async () =>
      bootstrapLocalSession(endpoint, async (input) => await ApplicationHttpClient.bootstrap(endpoint, input)),
    createClient: (endpoint, token) => new ApplicationHttpClient({ baseUrl: endpoint, token }),
    defaultEndpoint: endpoint,
  });
}

class ApplicationBridgeAdapter implements BridgeAdapter {
  private client: ApplicationHttpPort | undefined;
  private readonly reconnectAttempts: number;
  private readonly wait: NonNullable<ApplicationAdapterDependencies["wait"]>;

  public constructor(private readonly dependencies: ApplicationAdapterDependencies) {
    this.reconnectAttempts = dependencies.reconnectAttempts ?? 3;
    if (!Number.isSafeInteger(this.reconnectAttempts) || this.reconnectAttempts < 1 || this.reconnectAttempts > 10) {
      throw new Error("Application event reconnect 상한이 유효하지 않습니다");
    }
    this.wait = dependencies.wait ?? waitForReconnect;
  }

  public async connect(params: Readonly<Record<string, unknown>>): Promise<unknown> {
    exact(params, [], "connect params");
    await this.dependencies.startDaemon();
    if (this.client) return { status: "connected" };
    const client = this.dependencies.createClient(
      this.dependencies.defaultEndpoint,
      await this.dependencies.openLocalSession(),
    );
    await client.status();
    await client.me();
    this.client = client;
    return { status: "connected" };
  }

  public async query(params: Readonly<Record<string, unknown>>): Promise<unknown> {
    exact(params, ["operation", "payload"], "query params");
    if (!("payload" in params)) throw new Error("query payload가 필요합니다");
    const operation = operationName(params.operation, "query operation");
    return await this.connectedClient().query(operation, params.payload);
  }

  public async command(params: Readonly<Record<string, unknown>>): Promise<unknown> {
    return await this.connectedClient().command(validateApplicationCommand(params));
  }

  public async *events(params: Readonly<Record<string, unknown>>, signal: AbortSignal): AsyncIterable<unknown> {
    exact(params, ["after"], "events params");
    let cursor = params.after === undefined ? 0 : cursorValue(params.after);
    const client = this.connectedClient();
    let failures = 0;
    while (!signal.aborted) {
      try {
        for await (const raw of client.streamEvents(cursor, signal)) {
          // ponytail: AbortSignal.aborted는 타입 추론상 항상 false지만 abort() 호출 후 true로 바뀐다
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (signal.aborted) return;
          const event = validateApplicationEvent(raw);
          if (event.sequence <= cursor) continue;
          cursor = event.sequence;
          failures = 0;
          yield event;
        }
      } catch (error) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (signal.aborted) return;
        if (!transient(error)) throw new Error("Application event stream에 다시 연결할 수 없습니다", { cause: error });
      }
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) return;
      failures += 1;
      if (failures >= this.reconnectAttempts) {
        throw new Error("Application event stream 재연결 상한을 초과했습니다");
      }
      await this.wait(Math.min(1_000, 100 * 2 ** (failures - 1)), signal);
    }
  }

  public async *executions(params: Readonly<Record<string, unknown>>, signal: AbortSignal): AsyncIterable<unknown> {
    exact(params, ["executionId"], "executions params");
    const executionId = params.executionId === undefined ? undefined : identifier(params.executionId, "executionId");
    yield* this.connectedClient().streamExecutionDeltas(executionId, signal);
  }

  public async shutdown(): Promise<void> {
    this.client = undefined;
    await this.dependencies.stopDaemon();
  }

  private connectedClient(): ApplicationHttpPort {
    if (!this.client) throw new Error("Application에 연결되지 않았습니다");
    return this.client;
  }
}

function exact(value: Readonly<Record<string, unknown>>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label}에 알 수 없는 필드가 있습니다: ${unknown}`);
}

async function bootstrapLocalSession(
  endpoint: string,
  bootstrap: (input: { readonly commandId: string }) => Promise<unknown>,
): Promise<string> {
  const response = await bootstrap({
    commandId: randomUUID(),
  });
  const access = response && typeof response === "object" ? (response as { access?: unknown }).access : undefined;
  const token = access && typeof access === "object" ? (access as { token?: unknown }).token : undefined;
  if (typeof token !== "string" || !token.trim())
    throw new Error(`local AgentOS access를 열지 못했습니다: ${endpoint}`);
  return token;
}

function operationName(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 128 || !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u.test(value)) {
    throw new Error(`${label}이 유효하지 않습니다`);
  }
  return value;
}

function cursorValue(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("event cursor가 유효하지 않습니다");
  return value as number;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new Error(`${label}가 유효하지 않습니다`);
  }
  return value;
}

function transient(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof ApplicationRemoteError)
    return error.status === 408 || error.status === 429 || error.status >= 500;
  return false;
}

async function waitForReconnect(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
