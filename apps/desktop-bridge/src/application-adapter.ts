import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  ApplicationHttpClient,
  ApplicationRemoteError,
  validateApplicationCommand,
  validateApplicationEvent,
} from "@massion/application";
import {
  defaultLocalEndpoint,
  ensurePersonalLoopbackAccess,
  resolveTokenReference,
} from "@massion/local-control/access";
import { LocalDaemonManager, resolveLocalPaths } from "@massion/local-control/daemon";
import { replaceCliFileToken } from "@massion/local-control/profiles";

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
  const tokenReference = `file:${resolveLocalPaths(runtimeEnvironment).accessToken}`;
  return createApplicationAdapter({
    startDaemon: async () => await daemon.start(),
    stopDaemon: async () => await daemon.stop(),
    openLocalSession: async () => {
      try {
        const token = await resolveTokenReference(tokenReference);
        const access = await ensurePersonalLoopbackAccess({
          endpoint,
          tokenReference,
          token,
          verify: async (candidate) => {
            await new ApplicationHttpClient({ baseUrl: endpoint, token: candidate }).status();
          },
          refresh: async (candidate) =>
            (
              await ApplicationHttpClient.refreshLocalAccess(endpoint, candidate, {
                commandId: randomUUID(),
              })
            ).token,
          replace: replaceCliFileToken,
        });
        discardDaemonBootstrapCapability(daemon);
        return access;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
          discardDaemonBootstrapCapability(daemon);
          throw error;
        }
      }
      const capability = daemon.takeBootstrapCapability();
      if (!capability) throw new Error("local AgentOS access를 열 수 없습니다");
      const token = await bootstrapLocalSession(
        endpoint,
        capability,
        async (input) => await ApplicationHttpClient.bootstrap(endpoint, input),
      );
      await replaceCliFileToken(tokenReference, token);
      return token;
    },
    createClient: (endpoint, token) => new ApplicationHttpClient({ baseUrl: endpoint, token }),
    defaultEndpoint: endpoint,
  });
}

function discardDaemonBootstrapCapability(daemon: LocalDaemonManager): void {
  const discard = (daemon as LocalDaemonManager & { discardBootstrapCapability?: () => void })
    .discardBootstrapCapability;
  if (typeof discard === "function") {
    discard.call(daemon);
    return;
  }
  // source-freeze 중 오래된 local-control dist와 실행할 때도 보유 Buffer를 즉시 비웁니다.
  void daemon.takeBootstrapCapability();
}

class ApplicationBridgeAdapter implements BridgeAdapter {
  private client: ApplicationHttpPort | undefined;
  private reconnecting: Promise<ApplicationHttpPort> | undefined;
  private closed = false;
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
    this.assertOpen();
    if (this.reconnecting) {
      await this.reconnecting;
      this.assertOpen();
      return { status: "connected" };
    }
    await this.dependencies.startDaemon();
    this.assertOpen();
    if (this.client) {
      try {
        await this.client.status();
      } catch (error) {
        if (!authenticationFailure(error)) throw error;
        this.client = undefined;
      }
      if (this.client) {
        this.assertOpen();
        return { status: "connected" };
      }
    }
    this.client = await this.openClient();
    return { status: "connected" };
  }

  public async query(params: Readonly<Record<string, unknown>>): Promise<unknown> {
    exact(params, ["operation", "payload"], "query params");
    if (!("payload" in params)) throw new Error("query payload가 필요합니다");
    const operation = operationName(params.operation, "query operation");
    return await this.withAuthenticationRetry(async (client) => await client.query(operation, params.payload));
  }

  public async command(params: Readonly<Record<string, unknown>>): Promise<unknown> {
    const command = validateApplicationCommand(params);
    return await this.withAuthenticationRetry(async (client) => await client.command(command));
  }

  public async *events(params: Readonly<Record<string, unknown>>, signal: AbortSignal): AsyncIterable<unknown> {
    exact(params, ["after"], "events params");
    let cursor = params.after === undefined ? 0 : cursorValue(params.after);
    let failures = 0;
    while (!signal.aborted) {
      try {
        for await (const raw of this.connectedClient().streamEvents(cursor, signal)) {
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
        if (authenticationFailure(error)) await this.connect({});
        else if (!transient(error))
          throw new Error("Application event stream에 다시 연결할 수 없습니다", { cause: error });
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
    this.closed = true;
    await this.reconnecting?.catch(() => undefined);
    this.client = undefined;
    await this.dependencies.stopDaemon();
  }

  private connectedClient(): ApplicationHttpPort {
    if (!this.client) throw new Error("Application에 연결되지 않았습니다");
    return this.client;
  }

  private async withAuthenticationRetry<T>(operation: (client: ApplicationHttpPort) => Promise<T>): Promise<T> {
    const client = await this.operationClient();
    try {
      const result = await operation(client);
      this.assertOpen();
      return result;
    } catch (error) {
      if (!authenticationFailure(error)) throw error;
      const refreshed = await this.reconnect(client);
      this.assertOpen();
      const result = await operation(refreshed);
      this.assertOpen();
      return result;
    }
  }

  private async reconnect(staleClient: ApplicationHttpPort): Promise<ApplicationHttpPort> {
    this.assertOpen();
    if (this.reconnecting) return await this.reconnecting;
    if (this.client !== staleClient) return await this.operationClient();
    this.client = undefined;
    this.reconnecting = this.openClient();
    const reconnecting = this.reconnecting;
    try {
      const client = await reconnecting;
      this.client = client;
      return client;
    } catch (error) {
      if (!this.closed) this.client = staleClient;
      throw error;
    } finally {
      if (this.reconnecting === reconnecting) this.reconnecting = undefined;
    }
  }

  private async operationClient(): Promise<ApplicationHttpPort> {
    this.assertOpen();
    if (this.reconnecting) return await this.reconnecting;
    if (this.client) return this.client;
    return this.connectedClient();
  }

  private async openClient(): Promise<ApplicationHttpPort> {
    const token = await this.dependencies.openLocalSession();
    this.assertOpen();
    const client = this.dependencies.createClient(this.dependencies.defaultEndpoint, token);
    await client.status();
    await client.me();
    this.assertOpen();
    return client;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Application bridge가 종료되었습니다");
  }
}

function exact(value: Readonly<Record<string, unknown>>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label}에 알 수 없는 필드가 있습니다: ${unknown}`);
}

async function bootstrapLocalSession(
  endpoint: string,
  capability: string,
  bootstrap: (input: { readonly commandId: string; readonly capability: string }) => Promise<unknown>,
): Promise<string> {
  const response = await bootstrap({
    commandId: randomUUID(),
    capability,
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

function authenticationFailure(error: unknown): boolean {
  return (
    error instanceof ApplicationRemoteError &&
    error.status === 401 &&
    !!error.body &&
    typeof error.body === "object" &&
    (error.body as { category?: unknown }).category === "authentication"
  );
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
