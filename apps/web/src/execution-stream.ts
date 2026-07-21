import { useEffect, useState } from "react";

// 휘발성 실행 델타(Web): TUI와 같은 누적 규칙을 사용합니다.
// 정본이 아니므로 lifecycle finish에서 버리고, 확정 내용은 work.timeline이 대체합니다.

const DELTA_KINDS = new Set(["output-text", "reasoning", "tool-call", "tool-result", "lifecycle", "error"]);
const STREAM_TEXT_LIMIT = 4_000;

export interface WebExecutionDelta {
  readonly executionId: string;
  readonly agentHandle: string;
  readonly sequence: number;
  readonly kind: "output-text" | "reasoning" | "tool-call" | "tool-result" | "lifecycle" | "error";
  readonly text?: string;
  readonly toolName?: string;
  readonly summary?: string;
}

export interface WebExecutionStreamState {
  readonly executionId: string;
  readonly agentHandle: string;
  readonly text: string;
}

export function decodeWebExecutionDelta(value: unknown): WebExecutionDelta | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const delta = value as Record<string, unknown>;
  if (
    typeof delta.executionId !== "string" ||
    typeof delta.agentHandle !== "string" ||
    !Number.isSafeInteger(delta.sequence) ||
    typeof delta.kind !== "string" ||
    !DELTA_KINDS.has(delta.kind)
  )
    return undefined;
  return {
    executionId: delta.executionId,
    agentHandle: delta.agentHandle,
    sequence: delta.sequence as number,
    kind: delta.kind as WebExecutionDelta["kind"],
    ...(typeof delta.text === "string" ? { text: delta.text } : {}),
    ...(typeof delta.toolName === "string" ? { toolName: delta.toolName } : {}),
    ...(typeof delta.summary === "string" ? { summary: delta.summary } : {}),
  };
}

export function accumulateExecutionDelta(
  previous: WebExecutionStreamState | undefined,
  delta: WebExecutionDelta,
): WebExecutionStreamState | undefined {
  if (delta.kind === "lifecycle" && delta.summary === "finish") {
    return previous?.executionId === delta.executionId ? undefined : previous;
  }
  const base = previous?.executionId === delta.executionId ? previous.text : "";
  const addition =
    delta.kind === "output-text" || delta.kind === "reasoning"
      ? (delta.text ?? "")
      : delta.kind === "tool-call"
        ? `\n▸ 도구 실행: ${delta.toolName ?? "도구"}\n`
        : delta.kind === "error"
          ? "\n⚠ 실행 오류가 발생했습니다\n"
          : "";
  if (!addition) return previous;
  return {
    executionId: delta.executionId,
    agentHandle: delta.agentHandle,
    text: (base + addition).slice(-STREAM_TEXT_LIMIT),
  };
}

// SSE frame 파서: execution-delta만 통과시키고 heartbeat(:)는 무시합니다.
export function parseExecutionDeltaFrames(pending: string): {
  readonly deltas: readonly WebExecutionDelta[];
  readonly rest: string;
} {
  const deltas: WebExecutionDelta[] = [];
  let buffer = pending.replaceAll("\r\n", "\n");
  let boundary = buffer.indexOf("\n\n");
  while (boundary >= 0) {
    const frame = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    boundary = buffer.indexOf("\n\n");
    if (frame.startsWith(":")) continue;
    const fields = new Map<string, string>();
    for (const line of frame.split("\n")) {
      const separator = line.indexOf(":");
      if (separator >= 0) fields.set(line.slice(0, separator), line.slice(separator + 1).replace(/^ /u, ""));
    }
    if (fields.get("event") !== "execution-delta") continue;
    const data = fields.get("data");
    if (data === undefined) continue;
    try {
      const decoded = decodeWebExecutionDelta(JSON.parse(data));
      if (decoded) deltas.push(decoded);
    } catch {
      // 손상 frame은 버립니다.
    }
  }
  return { deltas, rest: buffer };
}

// 실행 델타 SSE 구독 hook: 끊기면 1초 후 재연결하고 화면을 떠나면 중단합니다.
export function useExecutionStream(
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
): WebExecutionStreamState | undefined {
  const [stream, setStream] = useState<WebExecutionStreamState | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    const flag = { active: true };
    const isActive = (): boolean => flag.active;
    const run = async (): Promise<void> => {
      while (isActive()) {
        try {
          const response = await fetcher("/api/v1/executions/stream", {
            credentials: "include",
            headers: { accept: "text/event-stream" },
            signal: controller.signal,
          });
          if (!response.ok || !response.body) throw new Error("실행 스트림 연결이 거부됐습니다");
          const reader = response.body.getReader();
          const decoder = new TextDecoder("utf-8", { fatal: true });
          let pending = "";
          try {
            for (;;) {
              const chunk = await reader.read();
              pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
              const parsed = parseExecutionDeltaFrames(pending);
              pending = parsed.rest;
              for (const delta of parsed.deltas) setStream((previous) => accumulateExecutionDelta(previous, delta));
              if (chunk.done) break;
            }
          } finally {
            reader.releaseLock();
          }
        } catch {
          // 재연결로 처리합니다.
        }
        if (!isActive()) return;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1_000);
        });
      }
    };
    void run();
    return () => {
      flag.active = false;
      controller.abort();
    };
  }, [fetcher]);

  return stream;
}
