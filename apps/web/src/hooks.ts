import { useEffect, useSyncExternalStore } from "react";

import type { BrowserSessionStore } from "./session.js";
import type { WebConsoleState, WebConsoleStore } from "./store.js";

export function useSession(store: BrowserSessionStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useConsoleStatus(store: WebConsoleStore) {
  return useSyncExternalStore(store.subscribe, () => {
    const state = store.getSnapshot();
    return `${state.status}:${state.connection}:${String(state.cursor)}:${state.error ?? ""}`;
  });
}

export function useQueryErrors(store: WebConsoleStore): Readonly<Record<string, string>> {
  return useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().queryErrors,
    (): Readonly<Record<string, string>> => ({}),
  );
}

export function useQueryData<T>(
  store: WebConsoleStore,
  operation: string,
  payload: unknown = {},
  decoder?: (value: unknown) => T,
): T | undefined {
  const data = useSyncExternalStore(
    store.subscribe,
    () => {
      const value = store.getSnapshot().queries[operation];
      return value === undefined ? undefined : decoder ? decoder(value) : (value as T);
    },
    () => undefined,
  );
  useEffect(() => {
    if (data === undefined) void store.refresh(operation, payload).catch(() => undefined);
  }, [data, operation, payload, store]);
  return data;
}

export function connectionFromStatus(value: string): WebConsoleState["connection"] {
  return (value.split(":")[1] as WebConsoleState["connection"] | undefined) ?? "offline";
}
