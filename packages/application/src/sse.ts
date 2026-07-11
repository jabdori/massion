export function encodeApplicationSseEvent(event: { readonly sequence: number; readonly type: string }): string {
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1)
    throw new Error("SSE event sequence가 유효하지 않습니다");
  if (!/^[a-z][a-z0-9.-]*$/u.test(event.type)) throw new Error("SSE event type이 유효하지 않습니다");
  return `id: ${String(event.sequence)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function parseEventCursor(lastEventId: string | undefined, after: string | undefined): number {
  const value = lastEventId ?? after ?? "0";
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error("Application event cursor가 유효하지 않습니다");
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) throw new Error("Application event cursor가 유효하지 않습니다");
  return cursor;
}

export async function* decodeApplicationSseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const reader = stream.getReader();
  let pending = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      if (Buffer.byteLength(pending) > 4 * 1024 * 1024) throw new Error("SSE client buffer byte 상한을 초과했습니다");
      pending = pending.replaceAll("\r\n", "\n");
      let boundary = pending.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        boundary = pending.indexOf("\n\n");
        if (frame.startsWith(":")) continue;
        const fields = new Map<string, string>();
        for (const line of frame.split("\n")) {
          const separator = line.indexOf(":");
          if (separator < 0) continue;
          fields.set(line.slice(0, separator), line.slice(separator + 1).replace(/^ /u, ""));
        }
        const id = fields.get("id");
        const type = fields.get("event");
        const data = fields.get("data");
        if (id === undefined || type === undefined || data === undefined)
          throw new Error("SSE event frame이 불완전합니다");
        const value = JSON.parse(data) as { sequence?: unknown; type?: unknown };
        if (String(value.sequence) !== id || value.type !== type)
          throw new Error("SSE event identity가 일치하지 않습니다");
        yield value;
      }
      if (chunk.done) break;
    }
    if (pending.trim()) throw new Error("SSE stream이 불완전한 frame으로 종료됐습니다");
  } finally {
    reader.releaseLock();
  }
}
