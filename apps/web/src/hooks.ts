import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { BrowserSessionStore } from "./session.js";
import { createQueryResourceIdentity, type WebConsoleState, type WebConsoleStore } from "./store.js";

const EMPTY_QUERY_PAYLOAD = Object.freeze({});
const EMPTY_QUERY_ERRORS: Readonly<Record<string, string>> = Object.freeze({});

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
  return useSyncExternalStore(store.subscribe, store.getActiveQueryErrors, () => EMPTY_QUERY_ERRORS);
}

export function useQueryError(
  store: WebConsoleStore,
  operation: string,
  payload: unknown = EMPTY_QUERY_PAYLOAD,
): string | undefined {
  return useSyncExternalStore(
    store.subscribe,
    () => store.getQueryError(operation, payload),
    () => undefined,
  );
}

export function useQueryData<T>(
  store: WebConsoleStore,
  operation: string,
  payload: unknown = EMPTY_QUERY_PAYLOAD,
  decoder?: (value: unknown) => T,
): T | undefined {
  const identity = createQueryResourceIdentity(operation, payload);
  const value = useSyncExternalStore(
    store.subscribe,
    () => store.getQueryData(operation, payload),
    () => undefined,
  );
  useEffect(() => store.retainQueryResource(operation, payload), [identity, store]);
  useEffect(() => {
    if (value === undefined) void store.refresh(operation, payload).catch(() => undefined);
  }, [identity, store, value]);
  return useMemo(() => (value === undefined ? undefined : decoder ? decoder(value) : (value as T)), [decoder, value]);
}

export function connectionFromStatus(value: string): WebConsoleState["connection"] {
  return (value.split(":")[1] as WebConsoleState["connection"] | undefined) ?? "offline";
}
