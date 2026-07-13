import { spawn } from "node:child_process";

export type CodexAppServerRequestId = string | number;

export interface CodexAppServerInboundRequest {
  readonly id: CodexAppServerRequestId;
  readonly method: string;
  readonly params: unknown;
}

export interface CodexAppServerSession {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
}

export interface CodexAppServerConnection extends CodexAppServerSession {
  readonly closed: boolean;
  close(): Promise<void>;
}

export type CodexAppServerRequestHandler = (
  request: CodexAppServerInboundRequest,
  session: CodexAppServerSession,
) => Promise<unknown>;

export interface CodexAppServerOptions {
  readonly requestHandlers?: Readonly<Record<string, CodexAppServerRequestHandler>>;
  readonly onNotification?: (notification: {
    readonly method: string;
    readonly params: unknown;
  }) => void | Promise<void>;
  readonly onFailure?: (error: Error) => void | Promise<void>;
  readonly timeoutMs?: number;
  readonly maximumOutputBytes?: number;
}

interface JsonRpcMessage {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAXIMUM_OUTPUT_BYTES = 64 * 1024;

function rpcId(value: unknown): value is CodexAppServerRequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

function rpcMethod(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9._/-]{0,255}$/u.test(value);
}

async function stopProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin?.end();
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => {
      child.once("close", () => {
        resolve();
      });
    }),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 250);
      timer.unref();
    }),
  ]);
  child.kill("SIGKILL");
}

export async function openCodexAppServer(
  command: string,
  commandArguments: readonly string[],
  environment: Readonly<Record<string, string>>,
  options: CodexAppServerOptions = {},
): Promise<CodexAppServerConnection> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maximumOutputBytes = options.maximumOutputBytes ?? DEFAULT_MAXIMUM_OUTPUT_BYTES;
  if (!command.trim()) throw new Error("Codex app-server command가 유효하지 않습니다");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) {
    throw new Error("Codex app-server timeout이 유효하지 않습니다");
  }
  if (
    !Number.isSafeInteger(maximumOutputBytes) ||
    maximumOutputBytes < 1_024 ||
    maximumOutputBytes > 64 * 1024 * 1024
  ) {
    throw new Error("Codex app-server 출력 상한이 유효하지 않습니다");
  }

  const child = spawn(command, [...commandArguments, "app-server", "--stdio"], {
    shell: false,
    windowsHide: true,
    env: { ...environment },
    stdio: ["pipe", "pipe", "ignore"],
  });
  child.stdout.setEncoding("utf8");
  const pending = new Map<CodexAppServerRequestId, PendingRequest>();
  let nextRequestId = 1;
  let buffer = "";
  let receivedBytes = 0;
  let terminalError: Error | undefined;
  let closing = false;
  let closed = false;

  const fail = (message = "Codex app-server RPC를 완료하지 못했습니다"): void => {
    if (closing || terminalError) return;
    terminalError ??= new Error(message);
    for (const waiter of pending.values()) waiter.reject(terminalError);
    pending.clear();
    void Promise.resolve()
      .then(async () => await options.onFailure?.(terminalError as Error))
      .catch(() => undefined);
  };
  const write = async (message: unknown): Promise<void> => {
    if (terminalError) throw terminalError;
    const serialized = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(serialized, (error) => {
        if (error) reject(new Error("Codex app-server RPC를 전송하지 못했습니다"));
        else resolve();
      });
    });
  };

  const session: CodexAppServerSession = {
    request: async (method, params) => {
      if (!rpcMethod(method)) throw new Error("Codex app-server RPC method가 유효하지 않습니다");
      if (terminalError) throw terminalError;
      const id = nextRequestId;
      nextRequestId += 1;
      if (!Number.isSafeInteger(nextRequestId)) throw new Error("Codex app-server request ID 상한을 초과했습니다");
      const response = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      try {
        await write({ method, id, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        pending.delete(id);
        throw error;
      }
      return await response;
    },
    notify: async (method, params) => {
      if (!rpcMethod(method)) throw new Error("Codex app-server RPC method가 유효하지 않습니다");
      await write({ method, ...(params === undefined ? {} : { params }) });
    },
  };
  const handleInboundRequest = async (request: CodexAppServerInboundRequest): Promise<void> => {
    const handler = options.requestHandlers?.[request.method];
    if (!handler) {
      await write({
        id: request.id,
        error: { code: -32601, message: "Codex app-server request handler가 없습니다" },
      });
      return;
    }
    try {
      const result = await handler(request, session);
      await write({ id: request.id, result });
    } catch {
      await write({
        id: request.id,
        error: { code: -32_000, message: "Codex app-server request를 승인하지 않았습니다" },
      });
    }
  };

  const parseLine = (line: string): void => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line) as unknown;
    } catch {
      fail("Codex app-server RPC 응답이 유효하지 않습니다");
      return;
    }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      fail("Codex app-server RPC 응답이 유효하지 않습니다");
      return;
    }
    const message = decoded as JsonRpcMessage;
    if (message.method !== undefined) {
      if (!rpcMethod(message.method)) {
        fail("Codex app-server RPC method가 유효하지 않습니다");
        return;
      }
      if (message.id !== undefined) {
        if (!rpcId(message.id)) {
          fail("Codex app-server RPC request ID가 유효하지 않습니다");
          return;
        }
        void handleInboundRequest({ id: message.id, method: message.method, params: message.params }).catch(() => {
          fail("Codex app-server RPC request 처리에 실패했습니다");
        });
        return;
      }
      void Promise.resolve()
        .then(async () => await options.onNotification?.({ method: message.method as string, params: message.params }))
        .catch(() => {
          fail("Codex app-server RPC notification 처리에 실패했습니다");
        });
      return;
    }
    if (!rpcId(message.id)) {
      fail("Codex app-server RPC response ID가 유효하지 않습니다");
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error !== undefined) waiter.reject(new Error("Codex app-server RPC가 거부됐습니다"));
    else waiter.resolve(message.result);
  };

  child.stdout.on("data", (chunk: string) => {
    receivedBytes += Buffer.byteLength(chunk, "utf8");
    if (receivedBytes > maximumOutputBytes) {
      fail("Codex app-server RPC 출력 상한을 초과했습니다");
      child.kill("SIGKILL");
      return;
    }
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) parseLine(line);
    }
  });
  child.stdin.once("error", () => {
    if (!closing) fail("Codex app-server RPC 입력 stream이 닫혔습니다");
  });
  child.once("error", () => {
    fail("Codex app-server process를 시작하지 못했습니다");
  });
  child.once("close", () => {
    if (!closing) fail();
    closed = true;
    clearTimeout(timeout);
  });

  const timeout = setTimeout(() => {
    fail("Codex app-server RPC 시간이 초과되었습니다");
    child.kill("SIGKILL");
  }, timeoutMs);
  timeout.unref();
  try {
    await session.request("initialize", {
      clientInfo: { name: "massion_server", title: "Massion Server", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    await session.notify("initialized");
  } catch (error) {
    closing = true;
    clearTimeout(timeout);
    await stopProcess(child);
    closed = true;
    throw error;
  }
  return {
    ...session,
    get closed() {
      return closed;
    },
    close: async () => {
      if (closing || closed) return;
      closing = true;
      clearTimeout(timeout);
      const closeError = new Error("Codex app-server 연결이 종료됐습니다");
      for (const waiter of pending.values()) waiter.reject(closeError);
      pending.clear();
      await stopProcess(child);
      closed = true;
    },
  };
}

export async function withCodexAppServer<T>(
  command: string,
  commandArguments: readonly string[],
  environment: Readonly<Record<string, string>>,
  operation: (session: CodexAppServerSession) => Promise<T>,
  options: CodexAppServerOptions = {},
): Promise<T> {
  const connection = await openCodexAppServer(command, commandArguments, environment, options);
  try {
    return await operation(connection);
  } finally {
    await connection.close();
  }
}
