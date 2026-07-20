import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { BrowserSessionStore } from "./session.js";
import { createQueryResourceIdentity, type WebConsoleState, type WebConsoleStore } from "./store.js";

const EMPTY_QUERY_PAYLOAD = Object.freeze({});
const EMPTY_QUERY_ERRORS: Readonly<Record<string, string>> = Object.freeze({});
const NOOP_SUBSCRIBE: (listener: () => void) => () => void = () => () => undefined;

interface QueryDataOptions {
  readonly enabled?: boolean;
}

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
  options: QueryDataOptions = {},
): T | undefined {
  const enabled = options.enabled ?? true;
  const identity = createQueryResourceIdentity(operation, payload);
  const value = useSyncExternalStore(
    enabled ? store.subscribe : NOOP_SUBSCRIBE,
    () => (enabled ? store.getQueryData(operation, payload) : undefined),
    () => undefined,
  );
  useEffect(() => {
    if (!enabled) return;
    return store.retainQueryResource(operation, payload);
  }, [enabled, identity, store]);
  useEffect(() => {
    if (enabled && value === undefined) void store.refresh(operation, payload).catch(() => undefined);
  }, [enabled, identity, store, value]);
  return useMemo(() => (value === undefined ? undefined : decoder ? decoder(value) : (value as T)), [decoder, value]);
}

export function connectionFromStatus(value: string): WebConsoleState["connection"] {
  return (value.split(":")[1] as WebConsoleState["connection"] | undefined) ?? "offline";
}
