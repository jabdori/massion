import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { TenantContext } from "@massion/identity";

import type { AuthenticatedApplicationAccess, IssueApplicationTokenInput } from "./auth.js";
import type { ApplicationEventV1 } from "./contracts.js";
import { ApplicationError, applicationErrorToHttpStatus } from "./errors.js";
import { encodeApplicationSseEvent, parseEventCursor } from "./sse.js";

const JSON_LIMIT = 1024 * 1024;
const ARTIFACT_LIMIT = 64 * 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

export interface ApplicationHttpDependencies {
  readonly auth: {
    authenticateAccess(
      authorization: string | undefined,
      audience: string,
      requiredScopes: readonly string[],
    ): Promise<AuthenticatedApplicationAccess>;
  };
  readonly queries: {
    query(context: TenantContext, scopes: readonly string[], operation: string, payload: unknown): Promise<unknown>;
  };
  readonly commands: {
    dispatch(context: TenantContext, scopes: readonly string[], input: unknown): Promise<{ readonly outcome?: string }>;
  };
  readonly events: {
    read(
      context: TenantContext,
      input: { readonly after: number; readonly limit: number },
    ): Promise<{ readonly events: readonly ApplicationEventV1[]; readonly cursor: number }>;
  };
  readonly tokens?: {
    issue(context: TenantContext, input: IssueApplicationTokenInput): Promise<unknown>;
    revoke(context: TenantContext, input: { readonly commandId: string; readonly tokenId: string }): Promise<void>;
  };
  readonly artifacts?: {
    inspect(context: TenantContext, archive: Buffer): Promise<unknown>;
    install(context: TenantContext, input: { readonly commandId: string; readonly archive: Buffer }): Promise<unknown>;
  };
}

export interface ApplicationHttpServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly audience?: string;
  readonly allowedOrigins?: readonly string[];
  readonly trustedProxyAddresses?: readonly string[];
  readonly requestTimeoutMs?: number;
  readonly headersTimeoutMs?: number;
  readonly keepAliveTimeoutMs?: number;
  readonly heartbeatMs?: number;
  readonly pollMs?: number;
  readonly maxConcurrentRequests?: number;
  readonly maxStreams?: number;
}

function hasScope(scopes: readonly string[], required: string): boolean {
  return scopes.includes("application:*") || scopes.includes(required);
}

function validation(message: string): ApplicationError {
  return new ApplicationError({
    category: "validation",
    severity: "error",
    retryable: false,
    userMessage: message,
    operatorCode: "APP_HTTP_VALIDATION",
  });
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) throw validation(`${name} header는 하나만 허용됩니다`);
  return value;
}

async function body(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > maximum) throw validation("HTTP request body byte 상한을 초과했습니다");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

async function json(request: IncomingMessage): Promise<unknown> {
  const contentType = header(request, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw validation("Content-Type application/json이 필요합니다");
  const bytes = await body(request, JSON_LIMIT);
  if (bytes.length === 0) throw validation("JSON body가 필요합니다");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw validation("JSON body UTF-8이 유효하지 않습니다");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw validation("JSON body가 유효하지 않습니다");
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const encoded = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

export class ApplicationHttpServer {
  private readonly server: Server;
  private readonly options: Required<
    Pick<
      ApplicationHttpServerOptions,
      | "host"
      | "port"
      | "audience"
      | "requestTimeoutMs"
      | "headersTimeoutMs"
      | "keepAliveTimeoutMs"
      | "heartbeatMs"
      | "pollMs"
      | "maxConcurrentRequests"
      | "maxStreams"
    >
  > &
    ApplicationHttpServerOptions;
  private activeRequests = 0;
  private activeStreams = 0;

  public constructor(
    private readonly dependencies: ApplicationHttpDependencies,
    options: ApplicationHttpServerOptions = {},
  ) {
    this.options = {
      ...options,
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 0,
      audience: options.audience ?? "massion-api",
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      headersTimeoutMs: options.headersTimeoutMs ?? 10_000,
      keepAliveTimeoutMs: options.keepAliveTimeoutMs ?? 5_000,
      heartbeatMs: options.heartbeatMs ?? 15_000,
      pollMs: options.pollMs ?? 100,
      maxConcurrentRequests: options.maxConcurrentRequests ?? 128,
      maxStreams: options.maxStreams ?? 32,
    };
    if (!LOOPBACK.has(this.options.host) && (options.trustedProxyAddresses?.length ?? 0) === 0) {
      throw new Error("loopback 밖 bind에는 trusted TLS proxy allowlist가 필요합니다");
    }
    this.server = createServer(
      { maxHeaderSize: 16 * 1024, requestTimeout: this.options.requestTimeoutMs },
      (request, response) => {
        void this.handle(request, response);
      },
    );
    this.server.maxHeadersCount = 64;
    this.server.headersTimeout = this.options.headersTimeoutMs;
    this.server.keepAliveTimeout = this.options.keepAliveTimeoutMs;
  }

  public async start(): Promise<{ readonly host: string; readonly port: number; readonly url: string }> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Application HTTP listen address를 확인할 수 없습니다");
    const host = address.address.includes(":") ? `[${address.address}]` : address.address;
    return { host: address.address, port: address.port, url: `http://${host}:${String(address.port)}` };
  }

  public async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.activeRequests >= this.options.maxConcurrentRequests) {
      sendJson(response, 503, validation("동시 HTTP 요청 상한을 초과했습니다").publicView());
      return;
    }
    this.activeRequests += 1;
    try {
      await this.route(request, response);
    } catch (cause) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const error = cause instanceof ApplicationError ? cause : ApplicationError.internal(cause);
      sendJson(response, applicationErrorToHttpStatus(error), error.publicView());
    } finally {
      this.activeRequests -= 1;
    }
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.rawHeaders.length / 2 > 64) throw validation("HTTP header 개수 상한을 초과했습니다");
    const origin = header(request, "origin");
    if (origin !== undefined) {
      if (!this.options.allowedOrigins?.includes(origin))
        throw new ApplicationError({
          category: "authorization",
          severity: "error",
          retryable: false,
          userMessage: "허용되지 않은 Origin입니다",
          operatorCode: "APP_HTTP_ORIGIN",
        });
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "Origin");
    }
    if (!LOOPBACK.has(this.options.host)) {
      const remote = request.socket.remoteAddress ?? "";
      if (!this.options.trustedProxyAddresses?.includes(remote) || header(request, "x-forwarded-proto") !== "https") {
        throw new ApplicationError({
          category: "authentication",
          severity: "error",
          retryable: false,
          userMessage: "trusted TLS proxy 확인에 실패했습니다",
          operatorCode: "APP_HTTP_PROXY",
        });
      }
    }
    const url = new URL(request.url ?? "/", "http://massion.invalid");
    if (url.searchParams.has("access_token") || url.searchParams.has("token"))
      throw validation("URL token은 허용되지 않습니다");
    if (request.method === "OPTIONS") throw validation("CORS preflight를 지원하지 않습니다");
    const access = await this.authenticate(request);
    if (url.pathname === "/api/v1/events/stream") {
      if (request.method !== "GET") return this.method(response, ["GET"]);
      if (!hasScope(access.scopes, "event:read")) throw this.scope();
      await this.stream(request, response, access.context, url);
      return;
    }
    if (url.pathname === "/api/v1/events") {
      if (request.method !== "GET") return this.method(response, ["GET"]);
      if (!hasScope(access.scopes, "event:read")) throw this.scope();
      this.acceptJson(request);
      const after = parseEventCursor(undefined, url.searchParams.get("after") ?? undefined);
      sendJson(response, 200, await this.dependencies.events.read(access.context, { after, limit: 1000 }));
      return;
    }
    const fixedQueries: Readonly<Record<string, string>> = {
      "/api/v1/status": "system.status",
      "/api/v1/me": "identity.me",
      "/api/v1/snapshot": "organization.graph.snapshot",
    };
    const fixed = fixedQueries[url.pathname];
    if (fixed) {
      if (request.method !== "GET") return this.method(response, ["GET"]);
      this.acceptJson(request);
      sendJson(response, 200, await this.dependencies.queries.query(access.context, access.scopes, fixed, {}));
      return;
    }
    if (url.pathname === "/api/v1/query") {
      if (request.method !== "POST") return this.method(response, ["POST"]);
      this.acceptJson(request);
      const input = (await json(request)) as { operation?: unknown; payload?: unknown };
      if (!input || typeof input !== "object" || typeof input.operation !== "string")
        throw validation("query operation이 필요합니다");
      sendJson(
        response,
        200,
        await this.dependencies.queries.query(access.context, access.scopes, input.operation, input.payload ?? {}),
      );
      return;
    }
    if (url.pathname === "/api/v1/commands") {
      if (request.method !== "POST") return this.method(response, ["POST"]);
      this.acceptJson(request);
      const result = await this.dependencies.commands.dispatch(access.context, access.scopes, await json(request));
      sendJson(response, result.outcome === "accepted" || result.outcome === "awaiting-approval" ? 202 : 200, result);
      return;
    }
    if (url.pathname === "/api/v1/tokens") {
      if (request.method !== "POST") return this.method(response, ["POST"]);
      this.acceptJson(request);
      if (
        !this.dependencies.tokens ||
        !hasScope(access.scopes, "token:write") ||
        !["owner", "admin"].includes(access.context.role)
      )
        throw this.scope();
      sendJson(
        response,
        201,
        await this.dependencies.tokens.issue(access.context, (await json(request)) as IssueApplicationTokenInput),
      );
      return;
    }
    const tokenId = url.pathname.match(/^\/api\/v1\/tokens\/([A-Za-z0-9._:-]{8,128})$/u)?.[1];
    if (tokenId) {
      if (request.method !== "DELETE") return this.method(response, ["DELETE"]);
      if (
        !this.dependencies.tokens ||
        !hasScope(access.scopes, "token:write") ||
        !["owner", "admin"].includes(access.context.role)
      )
        throw this.scope();
      const commandId = header(request, "x-massion-command-id");
      if (!commandId) throw validation("x-massion-command-id header가 필요합니다");
      await this.dependencies.tokens.revoke(access.context, { commandId, tokenId });
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === "/api/v1/artifacts/inspect" || url.pathname === "/api/v1/artifacts/install") {
      if (request.method !== "POST") return this.method(response, ["POST"]);
      this.acceptJson(request);
      if (header(request, "content-type") !== "application/octet-stream")
        throw validation("Content-Type application/octet-stream이 필요합니다");
      if (!this.dependencies.artifacts || !hasScope(access.scopes, "extension:write")) throw this.scope();
      const archive = await body(request, ARTIFACT_LIMIT);
      if (archive.length === 0) throw validation("Extension artifact가 비어 있습니다");
      if (url.pathname.endsWith("/inspect"))
        sendJson(response, 200, await this.dependencies.artifacts.inspect(access.context, archive));
      else {
        const commandId = header(request, "x-massion-command-id");
        if (!commandId) throw validation("x-massion-command-id header가 필요합니다");
        sendJson(response, 200, await this.dependencies.artifacts.install(access.context, { commandId, archive }));
      }
      return;
    }
    throw new ApplicationError({
      category: "not-found",
      severity: "error",
      retryable: false,
      userMessage: "HTTP route를 찾을 수 없습니다",
      operatorCode: "APP_HTTP_NOT_FOUND",
    });
  }

  private async authenticate(request: IncomingMessage): Promise<AuthenticatedApplicationAccess> {
    try {
      return await this.dependencies.auth.authenticateAccess(
        header(request, "authorization"),
        this.options.audience,
        [],
      );
    } catch (cause) {
      throw new ApplicationError({
        category: "authentication",
        severity: "error",
        retryable: false,
        userMessage: "Application access token 인증에 실패했습니다",
        operatorCode: "APP_HTTP_AUTH",
        cause,
      });
    }
  }

  private acceptJson(request: IncomingMessage): void {
    const accept = header(request, "accept");
    if (
      accept !== undefined &&
      !accept.split(",").some((value) => ["application/json", "*/*"].includes(value.split(";", 1)[0]?.trim() ?? ""))
    )
      throw validation("Accept application/json이 필요합니다");
  }

  private method(response: ServerResponse, allowed: readonly string[]): void {
    response.setHeader("allow", allowed.join(", "));
    sendJson(response, 405, validation("허용되지 않은 HTTP method입니다").publicView());
  }

  private scope(): ApplicationError {
    return new ApplicationError({
      category: "authorization",
      severity: "error",
      retryable: false,
      userMessage: "Application scope 또는 역할이 부족합니다",
      operatorCode: "APP_HTTP_SCOPE",
    });
  }

  private async stream(
    request: IncomingMessage,
    response: ServerResponse,
    context: TenantContext,
    url: URL,
  ): Promise<void> {
    if (this.activeStreams >= this.options.maxStreams)
      throw new ApplicationError({
        category: "rate-limit",
        severity: "warning",
        retryable: true,
        userMessage: "동시 event stream 상한을 초과했습니다",
        operatorCode: "APP_HTTP_STREAM_LIMIT",
      });
    const accept = header(request, "accept");
    if (accept !== undefined && !accept.includes("text/event-stream"))
      throw validation("Accept text/event-stream이 필요합니다");
    const last = header(request, "last-event-id");
    let cursor = parseEventCursor(last, url.searchParams.get("after") ?? undefined);
    this.activeStreams += 1;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let closed = false;
    request.once("close", () => {
      closed = true;
    });
    let heartbeatAt = Date.now() + this.options.heartbeatMs;
    try {
      while (!closed) {
        const batch = await this.dependencies.events.read(context, { after: cursor, limit: 1000 });
        let batchBytes = 0;
        for (const event of batch.events) {
          const frame = encodeApplicationSseEvent(event);
          batchBytes += Buffer.byteLength(frame);
          if (batchBytes > 4 * 1024 * 1024) throw validation("SSE event buffer byte 상한을 초과했습니다");
          if (!response.write(frame)) await new Promise<void>((resolve) => response.once("drain", resolve));
          cursor = event.sequence;
        }
        if (Date.now() >= heartbeatAt) {
          response.write(`: heartbeat ${String(Date.now())}\n\n`);
          heartbeatAt = Date.now() + this.options.heartbeatMs;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, this.options.pollMs));
      }
    } finally {
      this.activeStreams -= 1;
      if (!response.writableEnded) response.end();
    }
  }
}
