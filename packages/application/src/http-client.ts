import { decodeApplicationSseStream } from "./sse.js";

export class ApplicationRemoteError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(
      body && typeof body === "object" && typeof (body as { userMessage?: unknown }).userMessage === "string"
        ? (body as { userMessage: string }).userMessage
        : `Application HTTP 요청이 실패했습니다: ${String(status)}`,
    );
    this.name = "ApplicationRemoteError";
  }
}

export interface ApplicationHttpClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetcher?: typeof fetch;
  readonly retry?: { readonly attempts: number; readonly delayMs: number };
}

function isLoopback(hostname: string): boolean {
  return ["127.0.0.1", "::1", "localhost"].includes(hostname);
}

async function decode(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0];
  if (contentType !== "application/json") throw new Error("Application HTTP 응답 Content-Type이 유효하지 않습니다");
  return (await response.json()) as unknown;
}

export class ApplicationHttpClient {
  private readonly baseUrl: URL;
  private readonly fetcher: typeof fetch;
  private readonly retry: { readonly attempts: number; readonly delayMs: number };

  public constructor(private readonly options: ApplicationHttpClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(this.baseUrl.protocol))
      throw new Error("Application endpoint는 HTTP(S)여야 합니다");
    if (this.baseUrl.username || this.baseUrl.password || this.baseUrl.search || this.baseUrl.hash)
      throw new Error("Application endpoint에 credential·query·fragment를 사용할 수 없습니다");
    if (this.baseUrl.protocol === "http:" && !isLoopback(this.baseUrl.hostname)) {
      throw new Error("loopback 밖 Application endpoint에는 HTTPS가 필요합니다");
    }
    if (!options.token.trim()) throw new Error("Application token이 필요합니다");
    this.fetcher = options.fetcher ?? fetch;
    this.retry = options.retry ?? { attempts: 3, delayMs: 100 };
    if (
      !Number.isSafeInteger(this.retry.attempts) ||
      this.retry.attempts < 1 ||
      this.retry.attempts > 5 ||
      !Number.isSafeInteger(this.retry.delayMs) ||
      this.retry.delayMs < 0 ||
      this.retry.delayMs > 5_000
    )
      throw new Error("Application HTTP retry 설정이 유효하지 않습니다");
  }

  public static async bootstrap(
    baseUrl: string,
    input: { readonly commandId: string; readonly email: string; readonly displayName: string },
    fetcher: typeof fetch = fetch,
  ): Promise<unknown> {
    const endpoint = new URL(baseUrl);
    if (endpoint.protocol !== "http:" || !isLoopback(endpoint.hostname) || endpoint.username || endpoint.password)
      throw new Error("Application bootstrap endpoint는 credential 없는 loopback HTTP여야 합니다");
    const response = await fetcher(new URL("/api/v1/bootstrap", endpoint), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const value = await decode(response);
    if (!response.ok) throw new ApplicationRemoteError(response.status, value);
    return value;
  }

  public async status(): Promise<unknown> {
    return await this.jsonRequest("/api/v1/status", { method: "GET" }, true);
  }
  public async me(): Promise<unknown> {
    return await this.jsonRequest("/api/v1/me", { method: "GET" }, true);
  }
  public async snapshot(): Promise<unknown> {
    return await this.jsonRequest("/api/v1/snapshot", { method: "GET" }, true);
  }

  public async events(after = 0): Promise<unknown> {
    return await this.jsonRequest(`/api/v1/events?after=${String(after)}`, { method: "GET" }, true);
  }

  public async *streamEvents(after = 0, signal?: AbortSignal): AsyncGenerator {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("Application event cursor가 유효하지 않습니다");
    const response = await this.request(
      `/api/v1/events/stream?after=${String(after)}`,
      {
        method: "GET",
        headers: { accept: "text/event-stream", ...(after === 0 ? {} : { "last-event-id": String(after) }) },
        ...(signal === undefined ? {} : { signal }),
      },
      false,
    );
    if (!response.ok) throw new ApplicationRemoteError(response.status, await this.safeBody(response));
    if (!response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body)
      throw new Error("Application SSE 응답이 유효하지 않습니다");
    yield* decodeApplicationSseStream(response.body);
  }

  public async query(operation: string, payload: unknown): Promise<unknown> {
    return await this.jsonRequest(
      "/api/v1/query",
      { method: "POST", body: JSON.stringify({ operation, payload }) },
      true,
    );
  }

  public async command(input: unknown): Promise<unknown> {
    return await this.jsonRequest("/api/v1/commands", { method: "POST", body: JSON.stringify(input) }, true);
  }

  public async issueToken(input: unknown): Promise<unknown> {
    return await this.jsonRequest("/api/v1/tokens", { method: "POST", body: JSON.stringify(input) }, true);
  }

  public async revokeToken(tokenId: string, commandId: string): Promise<void> {
    const response = await this.request(
      `/api/v1/tokens/${encodeURIComponent(tokenId)}`,
      { method: "DELETE", headers: { "x-massion-command-id": commandId } },
      true,
    );
    if (!response.ok) throw new ApplicationRemoteError(response.status, await this.safeBody(response));
  }

  public async inspectArtifact(archive: Uint8Array): Promise<unknown> {
    return await this.artifact("/api/v1/artifacts/inspect", archive);
  }

  public async installArtifact(commandId: string, archive: Uint8Array): Promise<unknown> {
    return await this.artifact("/api/v1/artifacts/install", archive, commandId);
  }

  public async updateArtifact(commandId: string, archive: Uint8Array): Promise<unknown> {
    return await this.artifact("/api/v1/artifacts/install", archive, commandId, "update");
  }

  public async publishArtifact(commandId: string, archive: Uint8Array, metadata: unknown): Promise<unknown> {
    const encoded = Buffer.from(JSON.stringify(metadata), "utf8");
    if (encoded.length < 2 || encoded.length > 1024 * 1024)
      throw new Error("Registry publish metadata byte 상한을 초과했습니다");
    if (archive.byteLength === 0 || archive.byteLength > 64 * 1024 * 1024)
      throw new Error("Registry publish artifact byte 상한을 초과했습니다");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(encoded.length);
    const framed = Buffer.concat([header, encoded, Buffer.from(archive)]);
    const response = await this.request(
      "/api/v1/registry/publish",
      {
        method: "POST",
        headers: {
          "content-type": "application/vnd.massion.registry-publish.v1",
          "x-massion-command-id": commandId,
        },
        body: framed,
      },
      false,
    );
    const value = await this.safeBody(response);
    if (!response.ok) throw new ApplicationRemoteError(response.status, value);
    return value;
  }

  private async artifact(
    path: string,
    archive: Uint8Array,
    commandId?: string,
    operation?: "update",
  ): Promise<unknown> {
    const response = await this.request(
      path,
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          ...(commandId === undefined ? {} : { "x-massion-command-id": commandId }),
          ...(operation === undefined ? {} : { "x-massion-operation": operation }),
        },
        body: archive as BodyInit,
      },
      false,
    );
    const value = await this.safeBody(response);
    if (!response.ok) throw new ApplicationRemoteError(response.status, value);
    return value;
  }

  private async jsonRequest(path: string, init: RequestInit, retryable: boolean): Promise<unknown> {
    const response = await this.request(path, init, retryable);
    const value = await this.safeBody(response);
    if (!response.ok) throw new ApplicationRemoteError(response.status, value);
    return value;
  }

  private async request(path: string, init: RequestInit, retryable: boolean): Promise<Response> {
    const attempts = retryable ? this.retry.attempts : 1;
    let failure: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this.fetcher(new URL(path, this.baseUrl), {
          ...init,
          headers: {
            authorization: `Bearer ${this.options.token}`,
            accept: "application/json",
            ...Object.fromEntries(new Headers(init.headers)),
            ...(init.body === undefined || new Headers(init.headers).has("content-type")
              ? {}
              : { "content-type": "application/json" }),
          },
        });
        if (!(retryable && [502, 503, 504].includes(response.status) && attempt < attempts)) return response;
        await response.body?.cancel();
      } catch (error) {
        failure = error;
        if (attempt === attempts) throw error;
      }
      if (this.retry.delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.retry.delayMs));
    }
    throw failure instanceof Error ? failure : new Error("Application HTTP retry가 실패했습니다");
  }

  private async safeBody(response: Response): Promise<unknown> {
    if (response.status === 204) return undefined;
    return await decode(response);
  }
}
