import { TextDecoder } from "node:util";

export const MAX_INPUT_BYTES = 1024 * 1024;
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const MAX_PENDING_REQUESTS = 128;
export const BRIDGE_PROTOCOL = "massion.desktop-bridge.v1" as const;

const METHODS = [
  "hello",
  "connect",
  "query",
  "command",
  "events.start",
  "events.stop",
  "executions.start",
  "executions.stop",
  "shutdown",
] as const;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

type BridgeMethod = (typeof METHODS)[number];
type StreamName = "events" | "executions";
type HandleResult = "continue" | "shutdown";

interface BridgeRequest {
  readonly id: string;
  readonly method: BridgeMethod;
  readonly params: Record<string, unknown>;
}

interface StreamState {
  readonly controller: AbortController;
  readonly iterator: AsyncIterator<unknown>;
}

export interface BridgeAdapter {
  connect(params: Readonly<Record<string, unknown>>): Promise<unknown>;
  query(params: Readonly<Record<string, unknown>>): Promise<unknown>;
  command(params: Readonly<Record<string, unknown>>): Promise<unknown>;
  events(params: Readonly<Record<string, unknown>>, signal: AbortSignal): AsyncIterable<unknown>;
  executions(params: Readonly<Record<string, unknown>>, signal: AbortSignal): AsyncIterable<unknown>;
  shutdown(): Promise<void>;
}

export interface BridgeOptions {
  readonly adapter: BridgeAdapter;
  readonly write: (line: string) => Promise<void>;
  readonly log?: (message: string) => void;
}

type Frame = { readonly kind: "line"; readonly value: Buffer } | { readonly kind: "oversized" };

export class JsonlFramer {
  private readonly buffered = Buffer.allocUnsafe(MAX_INPUT_BYTES);
  private bufferedBytes = 0;
  private dropping = false;

  public push(chunk: Uint8Array): readonly Frame[] {
    const source = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const frames: Frame[] = [];
    let offset = 0;

    while (offset < source.length) {
      const newline = source.indexOf(0x0a, offset);
      const end = newline === -1 ? source.length : newline;
      const fragment = source.subarray(offset, end);

      if (!this.dropping) {
        if (this.bufferedBytes + fragment.length > MAX_INPUT_BYTES) {
          this.bufferedBytes = 0;
          this.dropping = true;
        } else if (fragment.length > 0) {
          fragment.copy(this.buffered, this.bufferedBytes);
          this.bufferedBytes += fragment.length;
        }
      }

      if (newline === -1) break;
      if (this.dropping) {
        frames.push({ kind: "oversized" });
        this.dropping = false;
      } else {
        const buffered = Buffer.from(this.buffered.subarray(0, this.bufferedBytes));
        const value = buffered.at(-1) === 0x0d ? buffered.subarray(0, -1) : buffered;
        frames.push({ kind: "line", value });
      }
      this.bufferedBytes = 0;
      offset = newline + 1;
    }

    return frames;
  }

  public end(): readonly Frame[] {
    if (this.dropping) {
      this.dropping = false;
      this.bufferedBytes = 0;
      return [{ kind: "oversized" }];
    }
    if (this.bufferedBytes === 0) return [];
    const value = Buffer.from(this.buffered.subarray(0, this.bufferedBytes));
    this.bufferedBytes = 0;
    return [{ kind: "line", value }];
  }
}

class DesktopBridge {
  private pending = 0;
  private readonly streams = new Map<StreamName, StreamState>();

  public constructor(private readonly options: BridgeOptions) {}

  public async handle(raw: Uint8Array): Promise<HandleResult> {
    if (raw.byteLength > MAX_INPUT_BYTES) {
      await this.error("invalid", "REQUEST_TOO_LARGE", "요청 크기 상한을 초과했습니다");
      return "continue";
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(UTF8_DECODER.decode(raw)) as unknown;
    } catch {
      await this.error("invalid", "INVALID_REQUEST", "요청 형식이 올바르지 않습니다");
      return "continue";
    }

    const id = requestId(parsed);
    const request = parseRequest(parsed);
    if (request === undefined) {
      await this.error(id, "INVALID_REQUEST", "요청 형식이 올바르지 않습니다");
      return "continue";
    }
    if (!isMethod(request.method)) {
      await this.error(id, "METHOD_NOT_FOUND", "지원하지 않는 요청입니다");
      return "continue";
    }
    const validRequest: BridgeRequest = { ...request, method: request.method };
    if (this.pending >= MAX_PENDING_REQUESTS) {
      await this.error(id, "TOO_MANY_REQUESTS", "동시 요청 상한을 초과했습니다");
      return "continue";
    }

    this.pending += 1;
    try {
      const result = await this.dispatch(validRequest);
      await this.success(id, result.value);
      return result.shutdown ? "shutdown" : "continue";
    } catch (error) {
      if (error instanceof StreamActiveError) {
        await this.error(id, "STREAM_ALREADY_ACTIVE", `${error.stream} 스트림이 이미 실행 중입니다`);
      } else {
        this.log(`${request.method} 요청 실패`);
        await this.error(id, "OPERATION_FAILED", "요청을 처리하지 못했습니다");
      }
      return "continue";
    } finally {
      this.pending -= 1;
    }
  }

  public async oversized(): Promise<void> {
    await this.error("invalid", "REQUEST_TOO_LARGE", "요청 크기 상한을 초과했습니다");
  }

  private async dispatch(request: BridgeRequest): Promise<{ readonly value: unknown; readonly shutdown?: true }> {
    switch (request.method) {
      case "hello":
        return {
          value: {
            protocol: BRIDGE_PROTOCOL,
            methods: [...METHODS],
            limits: {
              inputBytes: MAX_INPUT_BYTES,
              outputBytes: MAX_OUTPUT_BYTES,
              pendingRequests: MAX_PENDING_REQUESTS,
            },
          },
        };
      case "connect":
        return { value: await this.options.adapter.connect(request.params) };
      case "query":
        return { value: await this.options.adapter.query(request.params) };
      case "command":
        return { value: await this.options.adapter.command(request.params) };
      case "events.start":
        this.start("events", (signal) => this.options.adapter.events(request.params, signal));
        return { value: { started: true } };
      case "events.stop":
        return { value: { stopped: this.stop("events") } };
      case "executions.start":
        this.start("executions", (signal) => this.options.adapter.executions(request.params, signal));
        return { value: { started: true } };
      case "executions.stop":
        return { value: { stopped: this.stop("executions") } };
      case "shutdown":
        this.stop("events");
        this.stop("executions");
        await this.options.adapter.shutdown();
        return { value: { shuttingDown: true }, shutdown: true };
    }
  }

  private start(stream: StreamName, source: (signal: AbortSignal) => AsyncIterable<unknown>): void {
    if (this.streams.has(stream)) throw new StreamActiveError(stream);
    const controller = new AbortController();
    const iterator = source(controller.signal)[Symbol.asyncIterator]();
    const state = { controller, iterator };
    this.streams.set(stream, state);
    void this.pump(stream, state).catch(() => {
      this.log(`${stream} 스트림 정리 실패`);
    });
  }

  private stop(stream: StreamName): boolean {
    const state = this.streams.get(stream);
    if (state === undefined || state.controller.signal.aborted) return false;
    state.controller.abort();
    try {
      const completion = state.iterator.return?.();
      if (completion)
        void completion.catch(() => {
          this.log(`${stream} 스트림 정리 실패`);
        });
    } catch {
      this.log(`${stream} 스트림 정리 실패`);
    }
    return true;
  }

  private async pump(stream: StreamName, state: StreamState): Promise<void> {
    try {
      while (!state.controller.signal.aborted) {
        const next = await state.iterator.next();
        // ponytail: AbortSignal.aborted는 타입 추론상 항상 false지만 abort() 호출 후 true로 바뀐다
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (state.controller.signal.aborted || this.streams.get(stream) !== state) break;
        if (next.done) break;
        await this.event(stream, next.value);
      }
    } catch {
      if (!state.controller.signal.aborted) {
        this.log(`${stream} 스트림 실패`);
        await this.event(stream, { error: { code: "STREAM_FAILED", message: "스트림을 읽지 못했습니다" } }).catch(
          () => {
            this.log(`${stream} 스트림 오류 알림 실패`);
          },
        );
      }
    } finally {
      if (this.streams.get(stream) === state) this.streams.delete(stream);
    }
  }

  private async success(id: string, result: unknown): Promise<void> {
    const envelope = result === undefined ? { id, ok: true } : { id, ok: true, result };
    const encoded = encode(envelope);
    if (encoded === undefined || Buffer.byteLength(encoded, "utf8") + 1 > MAX_OUTPUT_BYTES) {
      await this.error(id, "RESPONSE_TOO_LARGE", "응답 크기 상한을 초과했습니다");
      return;
    }
    await this.options.write(`${encoded}\n`);
  }

  private async error(id: string, code: string, message: string): Promise<void> {
    await this.writeSmall({ id, ok: false, error: { code, message } });
  }

  private async event(stream: StreamName, payload: unknown): Promise<void> {
    const envelope = { type: "event", stream, payload };
    const encoded = encode(envelope);
    if (encoded !== undefined && Buffer.byteLength(encoded, "utf8") + 1 <= MAX_OUTPUT_BYTES) {
      await this.options.write(`${encoded}\n`);
      return;
    }
    await this.writeSmall({
      type: "event",
      stream,
      payload: { error: { code: "EVENT_TOO_LARGE", message: "이벤트 크기 상한을 초과했습니다" } },
    });
  }

  private async writeSmall(value: unknown): Promise<void> {
    const encoded = JSON.stringify(value);
    await this.options.write(`${encoded}\n`);
  }

  private log(message: string): void {
    try {
      this.options.log?.(message);
    } catch {
      // 로그 실패는 프로토콜 처리를 중단하지 않습니다.
    }
  }
}

class StreamActiveError extends Error {
  public constructor(public readonly stream: StreamName) {
    super("stream active");
  }
}

export function createBridge(options: BridgeOptions): DesktopBridge {
  return new DesktopBridge(options);
}

function requestId(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid";
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id) ? id : "invalid";
}

function parseRequest(value: unknown): (Omit<BridgeRequest, "method"> & { readonly method: string }) | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !["id", "method", "params"].includes(key))) return undefined;
  if (requestId(value) === "invalid" || typeof candidate.method !== "string") return undefined;
  if (!candidate.params || typeof candidate.params !== "object" || Array.isArray(candidate.params)) return undefined;
  if (!safeJson(candidate.params)) return undefined;
  return { id: candidate.id as string, method: candidate.method, params: candidate.params as Record<string, unknown> };
}

function safeJson(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || ["string", "boolean"].includes(typeof value)) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((child) => safeJson(child, depth + 1));
  if (typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([key, child]) => !["__proto__", "prototype", "constructor"].includes(key) && safeJson(child, depth + 1),
  );
}

function encode(value: unknown): string | undefined {
  if (jsonByteLength(value, MAX_OUTPUT_BYTES - 1, new Set(), 0) === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function jsonByteLength(value: unknown, limit: number, seen: Set<object>, depth: number): number | undefined {
  if (depth > 32 || limit < 0) return undefined;
  if (value === null) return 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") return Number.isFinite(value) ? Buffer.byteLength(String(value), "utf8") : undefined;
  if (typeof value === "string") return jsonStringByteLength(value, limit);
  if (typeof value !== "object" || seen.has(value)) return undefined;

  seen.add(value);
  let size = 2;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const child = jsonByteLength(value[index], limit - size, seen, depth + 1);
      if (child === undefined) return undefined;
      size += child + (index === 0 ? 0 : 1);
      if (size > limit) return undefined;
    }
    seen.delete(value);
    return size;
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || "toJSON" in value) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  let index = 0;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) continue;
    if (!("value" in descriptor)) return undefined;
    const keySize = jsonStringByteLength(key, limit - size);
    if (keySize === undefined) return undefined;
    const child = jsonByteLength(descriptor.value, limit - size - keySize - 1, seen, depth + 1);
    if (child === undefined) return undefined;
    size += keySize + child + 1 + (index === 0 ? 0 : 1);
    if (size > limit) return undefined;
    index += 1;
  }
  seen.delete(value);
  return size;
}

function jsonStringByteLength(value: string, limit: number): number | undefined {
  if (value.length + 2 > limit) return undefined;
  let size = Buffer.byteLength(value, "utf8") + 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) size += 1;
    else if (code <= 0x1f) size += [0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(code) ? 1 : 5;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (following >= 0xdc00 && following <= 0xdfff) index += 1;
      else size += 3;
    } else if (code >= 0xdc00 && code <= 0xdfff) size += 3;
    if (size > limit) return undefined;
  }
  return size;
}

function isMethod(value: string): value is BridgeMethod {
  return (METHODS as readonly string[]).includes(value);
}
