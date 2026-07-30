import { invoke, isTauri, type InvokeArgs } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type NativeStream = "events" | "executions";

export interface CodexLoginInput {
  readonly alias: string;
  readonly newAccount: boolean;
}

export interface NativeTransport {
  bootstrap(input?: Readonly<Record<string, unknown>>): Promise<unknown>;
  query(operation: string, payload: unknown): Promise<unknown>;
  command(input: unknown): Promise<unknown>;
  loginCodex(input: CodexLoginInput): Promise<unknown>;
  startStream(
    stream: NativeStream,
    params: Readonly<Record<string, unknown>>,
    onPayload: (payload: unknown) => void,
  ): Promise<() => Promise<void>>;
}

interface TauriBindings {
  invoke(command: string, args?: unknown): Promise<unknown>;
  listen(event: string, handler: (event: { payload: unknown }) => void): Promise<() => void>;
}

const defaultBindings: TauriBindings = {
  invoke: async (command, args) => await invoke(command, args as InvokeArgs | undefined),
  listen: async (event, handler) => await listen(event, handler),
};

export function isTauriRuntime(): boolean {
  return isTauri();
}

export function createTauriNativeTransport(bindings: TauriBindings = defaultBindings): NativeTransport {
  const call = async (command: string, input: unknown): Promise<unknown> => {
    try {
      return await bindings.invoke(command, input);
    } catch (error) {
      throw publicError(error);
    }
  };

  return {
    bootstrap: async (input = {}) => await call("bootstrap", { input }),
    query: async (operation, payload) => await call("query", { input: { operation, payload } }),
    command: async (input) => await call("command", { input }),
    loginCodex: async (input) => await call("codex_login", { input }),
    async startStream(stream, params, onPayload) {
      const unlisten = await bindings.listen("massion://bridge-event", (event) => {
        const envelope = record(event.payload);
        if (envelope?.stream === stream) onPayload(envelope.payload);
      });
      try {
        await call("stream_start", { input: { stream, params } });
      } catch (error) {
        unlisten();
        throw error;
      }
      let stopped = false;
      return async () => {
        if (stopped) return;
        stopped = true;
        unlisten();
        await call("stream_stop", { input: { stream, params: {} } });
      };
    },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function publicError(error: unknown): Error {
  const value = record(error);
  const message =
    typeof value?.message === "string"
      ? value.message
      : error instanceof Error
        ? error.message
        : "요청을 처리하지 못했습니다";
  return new Error(message);
}
