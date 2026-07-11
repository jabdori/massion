import { randomUUID } from "node:crypto";

export interface HeadlessApplicationClient {
  command(input: unknown): Promise<unknown>;
  streamEvents(after?: number, signal?: AbortSignal): AsyncIterable<unknown>;
}

export interface HeadlessRunOptions {
  readonly detach: boolean;
  readonly commandId?: string;
  readonly correlationId?: string;
  readonly reconnectAttempts?: number;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: unknown) => void | Promise<void>;
}

function command(operation: string, commandId: string, correlationId: string, payload: unknown) {
  return { schemaVersion: "massion.application.v1", commandId, correlationId, operation, payload };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function runHeadless(
  client: HeadlessApplicationClient,
  request: unknown,
  options: HeadlessRunOptions,
): Promise<unknown> {
  const commandId = options.commandId ?? randomUUID();
  const correlationId = options.correlationId ?? randomUUID();
  const started = record(await client.command(command("run.start", commandId, correlationId, { request })));
  const data = record(started.data);
  const runId = typeof data.runId === "string" ? data.runId : undefined;
  if (!runId) throw new Error("run.start 응답에 runId가 없습니다");
  if (options.detach) return { schemaVersion: "massion.cli.run.v1", type: "accepted", runId, correlationId };
  let cancelled = false;
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    void client.command(command("run.cancel", randomUUID(), correlationId, { runId })).catch(() => undefined);
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let cursor = 0;
  let failures = 0;
  const maximum = options.reconnectAttempts ?? 3;
  try {
    while (failures < maximum) {
      try {
        for await (const raw of client.streamEvents(cursor, options.signal)) {
          const event = record(raw);
          if (typeof event.sequence === "number") cursor = event.sequence;
          if (event.correlationId !== correlationId) continue;
          await options.onEvent?.(event);
          const type = event.type;
          if (type === "run.completed")
            return {
              schemaVersion: "massion.cli.run.v1",
              type: "result",
              status: "completed",
              runId,
              correlationId,
              cursor,
            };
          if (type === "run.suspended")
            return {
              schemaVersion: "massion.cli.run.v1",
              type: "result",
              status: "awaiting-approval",
              runId,
              correlationId,
              cursor,
            };
          if (type === "run.blocked")
            return {
              schemaVersion: "massion.cli.run.v1",
              type: "result",
              status: "blocked",
              runId,
              correlationId,
              cursor,
            };
          if (type === "run.cancelled")
            return {
              schemaVersion: "massion.cli.run.v1",
              type: "result",
              status: "cancelled",
              runId,
              correlationId,
              cursor,
            };
        }
        if (options.signal?.aborted)
          return {
            schemaVersion: "massion.cli.run.v1",
            type: "result",
            status: "cancelled",
            runId,
            correlationId,
            cursor,
          };
        failures += 1;
      } catch (error) {
        if (options.signal?.aborted)
          return {
            schemaVersion: "massion.cli.run.v1",
            type: "result",
            status: "cancelled",
            runId,
            correlationId,
            cursor,
          };
        failures += 1;
        if (failures >= maximum) throw error;
      }
    }
    throw new Error("Application event stream reconnect 상한을 초과했습니다");
  } finally {
    options.signal?.removeEventListener("abort", cancel);
  }
}
