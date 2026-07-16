import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { realpath, readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { TenantContext } from "@massion/identity";
import type { IssueEnrollmentInput, IssuedEnrollment } from "@massion/subscriptions";

import type { AuthenticatedApplicationAccess, IssueApplicationTokenInput } from "./auth.js";
import type { ApplicationEventV1 } from "./contracts.js";
import { ApplicationError, applicationErrorToHttpStatus } from "./errors.js";
import { ApplicationEventCursorExpiredError } from "./event-store.js";
import { encodeApplicationSseEvent, parseEventCursor } from "./sse.js";
import type { AuthenticatedWebSession, ExchangedWebSession } from "./web-session.js";

const JSON_LIMIT = 1024 * 1024;
const ARTIFACT_LIMIT = 64 * 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

export interface ApplicationHttpDependencies {
  readonly health?: {
    readiness(): Promise<Readonly<Record<string, boolean>>>;
  };
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
    update?(context: TenantContext, input: { readonly commandId: string; readonly archive: Buffer }): Promise<unknown>;
  };
  readonly registryPublisher?: {
    publish(
      context: TenantContext,
      input: { readonly commandId: string; readonly archive: Buffer; readonly metadata: unknown },
    ): Promise<unknown>;
  };
  readonly connectorEnrollments?: {
    issue(context: TenantContext, input: IssueEnrollmentInput): Promise<IssuedEnrollment>;
  };
  readonly bootstrap?: {
    initialize(input: {
      readonly commandId: string;
      readonly remoteAddress: string;
      readonly trustedLocal: boolean;
      readonly email: string;
      readonly displayName: string;
    }): Promise<unknown>;
  };
  readonly webSessions?: {
    issueLoginTicket(
      access: AuthenticatedApplicationAccess,
      input: { readonly commandId: string; readonly ttlSeconds?: number },
    ): Promise<unknown>;
    exchangeLoginTicket(code: string): Promise<ExchangedWebSession>;
    authenticate(
      sessionToken: string,
      audience: string,
      requiredScopes: readonly string[],
    ): Promise<AuthenticatedWebSession>;
    verifyCsrf(sessionToken: string, csrfToken: string): Promise<boolean>;
    rotateCsrf(sessionToken: string): Promise<string>;
    revoke(sessionToken: string, csrfToken: string, reason: string): Promise<void>;
  };
  readonly integrations?: {
    handle(input: {
      readonly method: string;
      readonly path: string;
      readonly query?: Readonly<Record<string, string | undefined>>;
      readonly headers: Readonly<Record<string, string | undefined>>;
      readonly body: Buffer;
      readonly receivedAt: Date;
    }): Promise<{
      readonly status: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: unknown;
    }>;
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
  readonly webRoot?: string;
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

function cookie(request: IncomingMessage, name: string): string | undefined {
  const source = header(request, "cookie");
  if (!source) return undefined;
  const values = source
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  if (values.length > 1) throw validation(`중복 ${name} cookie는 허용되지 않습니다`);
  return values[0];
}

function requestOrigin(request: IncomingMessage, secure: boolean): string | undefined {
  const host = header(request, "host");
  if (!host || !/^(?:\[[0-9a-f:]+\]|[A-Za-z0-9.-]+)(?::[0-9]{1,5})?$/u.test(host)) return undefined;
  return `${secure ? "https" : "http"}://${host}`;
}

interface HttpAccess extends AuthenticatedApplicationAccess {
  readonly web?: {
    readonly sessionId: string;
    readonly sessionToken: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
    readonly idleExpiresAt: string;
  };
}

async function body(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const declared = header(request, "content-length");
  if (declared !== undefined && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maximum))
    throw validation("HTTP Content-Length가 유효하지 않습니다");
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

function validateJsonValue(value: unknown, depth = 0): void {
  if (depth > 20) throw validation("JSON body 깊이 상한을 초과했습니다");
  if (typeof value === "string" && value.length > 64 * 1024) throw validation("JSON 문자열 상한을 초과했습니다");
  if (Array.isArray(value)) {
    if (value.length > 1000) throw validation("JSON 배열 상한을 초과했습니다");
    for (const child of value) validateJsonValue(child, depth + 1);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (["__proto__", "prototype", "constructor"].includes(key))
        throw validation("JSON prototype key를 허용하지 않습니다");
      validateJsonValue(child, depth + 1);
    }
  }
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
    const value = JSON.parse(text) as unknown;
    validateJsonValue(value);
    return value;
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
  private readonly streams = new Set<ServerResponse>();
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
  private draining = false;

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
    if (this.options.webRoot !== undefined && !isAbsolute(this.options.webRoot))
      throw new Error("Web root는 절대 경로여야 합니다");
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
    this.beginDrain();
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }

  public beginDrain(): void {
    this.draining = true;
    for (const response of this.streams) response.destroy();
  }

  public upgradeServer(): Server {
    return this.server;
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
    const url = new URL(request.url ?? "/", "http://massion.invalid");
    if (url.pathname === "/health/live" || url.pathname === "/health/ready") {
      if (request.method !== "GET") {
        this.method(response, ["GET"]);
        return;
      }
      response.setHeader("cache-control", "no-store");
      if (url.pathname === "/health/live") {
        sendJson(response, 200, { status: "live" });
        return;
      }
      if (this.draining) {
        sendJson(response, 503, { status: "not-ready" });
        return;
      }
      try {
        const readiness = (await this.dependencies.health?.readiness()) ?? {};
        const entries = Object.entries(readiness)
          .filter(([name, value]) => /^[a-z][a-z0-9-]{0,31}$/u.test(name) && typeof value === "boolean")
          .sort(([left], [right]) => left.localeCompare(right))
          .slice(0, 16);
        if (entries.some(([, ready]) => !ready)) {
          sendJson(response, 503, {
            status: "not-ready",
            components: Object.fromEntries(entries.map(([name, ready]) => [name, ready ? "ready" : "not-ready"])),
          });
          return;
        }
        sendJson(response, 200, {
          status: "ready",
          components: Object.fromEntries(entries.map(([name]) => [name, "ready"])),
        });
      } catch {
        sendJson(response, 503, { status: "not-ready" });
      }
      return;
    }
    if (await this.webAsset(request, response, url)) return;
    if (this.draining) {
      sendJson(response, 503, { status: "draining" });
      return;
    }
    const origin = header(request, "origin");
    const secure = !LOOPBACK.has(this.options.host);
    if (origin !== undefined) {
      const sameOrigin = origin === requestOrigin(request, secure);
      if (!sameOrigin && !this.options.allowedOrigins?.includes(origin))
        throw new ApplicationError({
          category: "authorization",
          severity: "error",
          retryable: false,
          userMessage: "허용되지 않은 Origin입니다",
          operatorCode: "APP_HTTP_ORIGIN",
        });
      if (!sameOrigin) {
        response.setHeader("access-control-allow-origin", origin);
        response.setHeader("vary", "Origin");
      }
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
    if (url.searchParams.has("access_token") || url.searchParams.has("token"))
      throw validation("URL token은 허용되지 않습니다");
    if (request.method === "OPTIONS") throw validation("CORS preflight를 지원하지 않습니다");
    if (url.pathname.startsWith("/integrations/")) {
      if (!this.dependencies.integrations) throw validation("Integration HTTP gateway를 사용할 수 없습니다");
      const integrationQuery: Record<string, string> = {};
      for (const [name, value] of url.searchParams) {
        if (name in integrationQuery) throw validation("Integration query parameter가 중복됐습니다");
        integrationQuery[name] = value;
      }
      const integrationResponse = await this.dependencies.integrations.handle({
        method: request.method ?? "",
        path: url.pathname,
        query: integrationQuery,
        headers: {
          "content-type": header(request, "content-type"),
          "x-slack-request-timestamp": header(request, "x-slack-request-timestamp"),
          "x-slack-signature": header(request, "x-slack-signature"),
          "x-signature-timestamp": header(request, "x-signature-timestamp"),
          "x-signature-ed25519": header(request, "x-signature-ed25519"),
          "x-hub-signature-256": header(request, "x-hub-signature-256"),
          "x-github-delivery": header(request, "x-github-delivery"),
          "x-github-event": header(request, "x-github-event"),
        },
        body: await body(request, JSON_LIMIT),
        receivedAt: new Date(),
      });
      for (const [name, value] of Object.entries(integrationResponse.headers ?? {})) response.setHeader(name, value);
      if (integrationResponse.body === undefined) {
        response.writeHead(integrationResponse.status);
        response.end();
      } else sendJson(response, integrationResponse.status, integrationResponse.body);
      return;
    }
    if (url.pathname === "/api/v1/bootstrap") {
      if (request.method !== "POST") {
        this.method(response, ["POST"]);
        return;
      }
      if (
        !LOOPBACK.has(this.options.host) ||
        !LOOPBACK.has(request.socket.remoteAddress ?? "") ||
        !this.dependencies.bootstrap
      )
        throw new ApplicationError({
          category: "authorization",
          severity: "error",
          retryable: false,
          userMessage: "로컬 bootstrap을 사용할 수 없습니다",
          operatorCode: "APP_HTTP_BOOTSTRAP_LOCAL",
        });
      this.acceptJson(request);
      const input = (await json(request)) as Record<string, unknown>;
      if (
        typeof input.commandId !== "string" ||
        typeof input.email !== "string" ||
        typeof input.displayName !== "string" ||
        Object.keys(input).some((key) => !["commandId", "email", "displayName"].includes(key))
      )
        throw validation("bootstrap input이 유효하지 않습니다");
      sendJson(
        response,
        201,
        await this.dependencies.bootstrap.initialize({
          commandId: input.commandId,
          email: input.email,
          displayName: input.displayName,
          remoteAddress: request.socket.remoteAddress ?? "",
          trustedLocal: true,
        }),
      );
      return;
    }
    if (url.pathname === "/api/v1/web/sessions") {
      if (request.method !== "POST") {
        this.method(response, ["POST"]);
        return;
      }
      this.browserOrigin(request);
      if (!this.dependencies.webSessions) throw validation("Web session을 사용할 수 없습니다");
      this.acceptJson(request);
      const input = (await json(request)) as Record<string, unknown>;
      if (Object.keys(input).some((key) => key !== "code") || typeof input.code !== "string")
        throw validation("Web login code가 필요합니다");
      const exchanged = await this.dependencies.webSessions.exchangeLoginTicket(input.code);
      response.setHeader("set-cookie", this.sessionCookie(exchanged.sessionToken, exchanged.expiresAt, secure));
      response.setHeader("cache-control", "no-store");
      sendJson(response, 201, {
        schemaVersion: "massion.web.session.v1",
        sessionId: exchanged.sessionId,
        context: exchanged.context,
        scopes: exchanged.scopes,
        csrfToken: exchanged.csrfToken,
        issuedAt: exchanged.issuedAt,
        expiresAt: exchanged.expiresAt,
        idleExpiresAt: exchanged.idleExpiresAt,
      });
      return;
    }
    const access = await this.authenticate(request);
    if (url.pathname === "/api/v1/subscriptions/connectors/enrollments") {
      if (request.method !== "POST") {
        this.method(response, ["POST"]);
        return;
      }
      if (access.web) await this.browserMutation(request, access);
      if (
        !this.dependencies.connectorEnrollments ||
        !hasScope(access.scopes, "subscription:write") ||
        !["owner", "admin", "member"].includes(access.context.role)
      ) {
        throw this.scope();
      }
      this.acceptJson(request);
      const input = (await json(request)) as Record<string, unknown>;
      if (
        Object.keys(input).some((key) => !["commandId", "location", "executionKind", "ttlMs"].includes(key)) ||
        typeof input.commandId !== "string" ||
        input.location !== "edge" ||
        (input.executionKind !== "model" && input.executionKind !== "agent-runtime") ||
        (input.ttlMs !== undefined && !Number.isSafeInteger(input.ttlMs))
      ) {
        throw validation("Connector enrollment 발급 입력이 유효하지 않습니다");
      }
      response.setHeader("cache-control", "no-store");
      sendJson(
        response,
        201,
        await this.dependencies.connectorEnrollments.issue(access.context, {
          commandId: input.commandId,
          location: "edge",
          executionKind: input.executionKind,
          ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs as number }),
        }),
      );
      return;
    }
    if (url.pathname === "/api/v1/web/login-tickets") {
      if (request.method !== "POST") {
        this.method(response, ["POST"]);
        return;
      }
      if (!this.dependencies.webSessions || access.web) throw this.scope();
      if (!hasScope(access.scopes, "web-session:write") || !["owner", "admin", "member"].includes(access.context.role))
        throw this.scope();
      this.acceptJson(request);
      const input = (await json(request)) as Record<string, unknown>;
      if (
        Object.keys(input).some((key) => !["commandId", "ttlSeconds"].includes(key)) ||
        typeof input.commandId !== "string"
      )
        throw validation("Web login ticket input이 유효하지 않습니다");
      response.setHeader("cache-control", "no-store");
      sendJson(
        response,
        201,
        await this.dependencies.webSessions.issueLoginTicket(access, {
          commandId: input.commandId,
          ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: Number(input.ttlSeconds) }),
        }),
      );
      return;
    }
    if (url.pathname === "/api/v1/web/session") {
      if (!access.web || !this.dependencies.webSessions) throw this.scope();
      response.setHeader("cache-control", "no-store");
      if (request.method === "GET") {
        const csrfToken = await this.dependencies.webSessions.rotateCsrf(access.web.sessionToken);
        sendJson(response, 200, {
          schemaVersion: "massion.web.session.v1",
          sessionId: access.web.sessionId,
          context: access.context,
          scopes: access.scopes,
          csrfToken,
          issuedAt: access.web.issuedAt,
          expiresAt: access.web.expiresAt,
          idleExpiresAt: access.web.idleExpiresAt,
        });
        return;
      }
      if (request.method === "DELETE") {
        const csrfToken = await this.browserMutation(request, access);
        await this.dependencies.webSessions.revoke(access.web.sessionToken, csrfToken, "user-logout");
        response.setHeader("set-cookie", this.clearSessionCookie(secure));
        response.writeHead(204);
        response.end();
        return;
      }
      this.method(response, ["GET", "DELETE"]);
      return;
    }
    if (url.pathname === "/api/v1/events/stream") {
      if (request.method !== "GET") {
        this.method(response, ["GET"]);
        return;
      }
      if (!hasScope(access.scopes, "event:read")) throw this.scope();
      await this.stream(request, response, access.context, url);
      return;
    }
    if (url.pathname === "/api/v1/events") {
      if (request.method !== "GET") {
        this.method(response, ["GET"]);
        return;
      }
      if (!hasScope(access.scopes, "event:read")) throw this.scope();
      this.acceptJson(request);
      const after = parseEventCursor(undefined, url.searchParams.get("after") ?? undefined);
      sendJson(response, 200, await this.readEvents(access.context, { after, limit: 1000 }));
      return;
    }
    const fixedQueries: Readonly<Record<string, string>> = {
      "/api/v1/status": "system.status",
      "/api/v1/me": "identity.me",
      "/api/v1/snapshot": "organization.graph.snapshot",
    };
    const fixed = fixedQueries[url.pathname];
    if (fixed) {
      if (request.method !== "GET") {
        this.method(response, ["GET"]);
        return;
      }
      this.acceptJson(request);
      sendJson(response, 200, await this.dependencies.queries.query(access.context, access.scopes, fixed, {}));
      return;
    }
    if (url.pathname === "/api/v1/query") {
      if (request.method !== "POST") {
        this.method(response, ["POST"]);
        return;
      }
      this.acceptJson(request);
      const input = (await json(request)) as { operation?: unknown; payload?: unknown };
      if (typeof input.operation !== "string") throw validation("query operation이 필요합니다");
      sendJson(
        response,
        200,
        await this.dependencies.queries.query(access.context, access.scopes, input.operation, input.payload ?? {}),
      );
      return;
    }
    if (url.pathname === "/api/v1/commands") {
      if (request.method !== "POST") {
        this.method(response, ["POST"]);
        return;
      }
      if (access.web) await this.browserMutation(request, access);
      this.acceptJson(request);
      const result = await this.dependencies.commands.dispatch(access.context, access.scopes, await json(request));
      sendJson(response, result.outcome === "accepted" || result.outcome === "awaiting-approval" ? 202 : 200, result);
      return;
    }
    if (url.pathname === "/api/v1/tokens") {
      if (request.method !== "POST") {
        this.method(response, ["POST"]);
        return;
      }
      if (access.web) await this.browserMutation(request, access);
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
      if (request.method !== "DELETE") {
        this.method(response, ["DELETE"]);
        return;
      }
      if (access.web) await this.browserMutation(request, access);
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
      if (request.method !== "POST") {
        this.method(response, ["POST"]);
        return;
      }
      if (access.web) await this.browserMutation(request, access);
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
        const operation = header(request, "x-massion-operation") ?? "install";
        if (!(["install", "update"] as const).includes(operation as never))
          throw validation("x-massion-operation이 유효하지 않습니다");
        if (operation === "update" && !this.dependencies.artifacts.update)
          throw validation("Extension update artifact handler가 없습니다");
        const result =
          operation === "update"
            ? await this.dependencies.artifacts.update?.(access.context, { commandId, archive })
            : await this.dependencies.artifacts.install(access.context, { commandId, archive });
        sendJson(response, 200, result);
      }
      return;
    }
    if (url.pathname === "/api/v1/registry/publish") {
      if (request.method !== "POST") {
        this.method(response, ["POST"]);
        return;
      }
      if (access.web) await this.browserMutation(request, access);
      this.acceptJson(request);
      if (header(request, "content-type") !== "application/vnd.massion.registry-publish.v1")
        throw validation("Registry publish Content-Type이 유효하지 않습니다");
      if (
        !this.dependencies.registryPublisher ||
        !hasScope(access.scopes, "extension:write") ||
        !["owner", "admin"].includes(access.context.role)
      )
        throw this.scope();
      const framed = await body(request, ARTIFACT_LIMIT + JSON_LIMIT + 4);
      if (framed.length < 5) throw validation("Registry publish frame이 비어 있습니다");
      const metadataLength = framed.readUInt32BE(0);
      if (metadataLength < 2 || metadataLength > JSON_LIMIT || framed.length <= 4 + metadataLength)
        throw validation("Registry publish metadata 길이가 유효하지 않습니다");
      let metadata: unknown;
      try {
        metadata = JSON.parse(framed.subarray(4, 4 + metadataLength).toString("utf8")) as unknown;
      } catch {
        throw validation("Registry publish metadata JSON이 유효하지 않습니다");
      }
      const archive = framed.subarray(4 + metadataLength);
      if (archive.length === 0 || archive.length > ARTIFACT_LIMIT)
        throw validation("Registry publish artifact 크기가 유효하지 않습니다");
      const commandId = header(request, "x-massion-command-id");
      if (!commandId) throw validation("x-massion-command-id header가 필요합니다");
      sendJson(
        response,
        201,
        await this.dependencies.registryPublisher.publish(access.context, { commandId, archive, metadata }),
      );
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

  private async authenticate(request: IncomingMessage): Promise<HttpAccess> {
    try {
      const authorization = header(request, "authorization");
      if (authorization !== undefined)
        return await this.dependencies.auth.authenticateAccess(authorization, this.options.audience, []);
      if (this.dependencies.webSessions) {
        const secure = !LOOPBACK.has(this.options.host);
        const cookieName = secure ? "__Host-massion_session" : "massion_session";
        const sessionToken = cookie(request, cookieName);
        if (sessionToken) {
          const access = await this.dependencies.webSessions.authenticate(sessionToken, this.options.audience, []);
          return {
            ...access,
            web: {
              sessionId: access.sessionId,
              sessionToken,
              issuedAt: access.issuedAt,
              expiresAt: access.expiresAt,
              idleExpiresAt: access.idleExpiresAt,
            },
          };
        }
      }
      return await this.dependencies.auth.authenticateAccess(undefined, this.options.audience, []);
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

  private async browserMutation(request: IncomingMessage, access: HttpAccess): Promise<string> {
    if (!access.web || !this.dependencies.webSessions) throw this.scope();
    this.browserOrigin(request);
    const csrfToken = header(request, "x-massion-csrf");
    if (!csrfToken || !(await this.dependencies.webSessions.verifyCsrf(access.web.sessionToken, csrfToken)))
      throw new ApplicationError({
        category: "authorization",
        severity: "error",
        retryable: false,
        userMessage: "Web mutation CSRF 검증에 실패했습니다",
        operatorCode: "APP_HTTP_WEB_CSRF",
      });
    return csrfToken;
  }

  private browserOrigin(request: IncomingMessage): void {
    const secure = !LOOPBACK.has(this.options.host);
    if (header(request, "origin") !== requestOrigin(request, secure))
      throw new ApplicationError({
        category: "authorization",
        severity: "error",
        retryable: false,
        userMessage: "Web mutation Origin이 일치하지 않습니다",
        operatorCode: "APP_HTTP_WEB_ORIGIN",
      });
    if (header(request, "sec-fetch-site") !== "same-origin")
      throw new ApplicationError({
        category: "authorization",
        severity: "error",
        retryable: false,
        userMessage: "Web mutation Fetch Metadata가 유효하지 않습니다",
        operatorCode: "APP_HTTP_WEB_FETCH_METADATA",
      });
  }

  private async webAsset(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const root = this.options.webRoot;
    if (!root || (request.method !== "GET" && request.method !== "HEAD")) return false;
    if (
      url.pathname === "/connectors" ||
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/health/") ||
      url.pathname.startsWith("/integrations/")
    )
      return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      sendJson(response, 404, { error: "Web asset를 찾을 수 없습니다" });
      return true;
    }
    if (decoded.includes("\0")) {
      sendJson(response, 404, { error: "Web asset를 찾을 수 없습니다" });
      return true;
    }
    const resolvedRoot = await realpath(root).catch(() => undefined);
    if (!resolvedRoot) return false;
    const candidate = resolve(resolvedRoot, `.${decoded}`);
    if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${sep}`)) {
      sendJson(response, 404, { error: "Web asset를 찾을 수 없습니다" });
      return true;
    }
    let target = candidate;
    let metadata = await stat(target).catch(() => undefined);
    if (!metadata?.isFile()) {
      if (extname(decoded) !== "") {
        sendJson(response, 404, { error: "Web asset를 찾을 수 없습니다" });
        return true;
      }
      target = join(resolvedRoot, "index.html");
      metadata = await stat(target).catch(() => undefined);
    }
    if (!metadata?.isFile()) return false;
    const realTarget = await realpath(target).catch(() => undefined);
    if (!realTarget || (realTarget !== resolvedRoot && !realTarget.startsWith(`${resolvedRoot}${sep}`))) {
      sendJson(response, 404, { error: "Web asset를 찾을 수 없습니다" });
      return true;
    }
    const content = await readFile(realTarget);
    const extension = extname(realTarget).toLowerCase();
    const contentType =
      extension === ".html"
        ? "text/html; charset=utf-8"
        : extension === ".js"
          ? "text/javascript; charset=utf-8"
          : extension === ".css"
            ? "text/css; charset=utf-8"
            : extension === ".json"
              ? "application/json; charset=utf-8"
              : extension === ".svg"
                ? "image/svg+xml"
                : extension === ".woff2"
                  ? "font/woff2"
                  : "application/octet-stream";
    response.writeHead(200, {
      "content-type": contentType,
      "content-length": content.length,
      "cache-control":
        relative(resolvedRoot, realTarget) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    if (request.method === "GET") response.end(content);
    else response.end();
    return true;
  }

  private sessionCookie(sessionToken: string, expiresAt: string, secure: boolean): string {
    const name = secure ? "__Host-massion_session" : "massion_session";
    const maximumAge = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1_000));
    return `${name}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${String(maximumAge)}${secure ? "; Secure" : ""}`;
  }

  private clearSessionCookie(secure: boolean): string {
    const name = secure ? "__Host-massion_session" : "massion_session";
    return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
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
    this.streams.add(response);
    try {
      let batch = await this.readEvents(context, { after: cursor, limit: 1000 });
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      let heartbeatAt = Date.now() + this.options.heartbeatMs;
      while (!this.streamClosed(request, response)) {
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
        if (this.streamClosed(request, response)) break;
        batch = await this.readEvents(context, { after: cursor, limit: 1000 });
      }
    } finally {
      this.streams.delete(response);
      this.activeStreams -= 1;
      if (response.headersSent && !response.writableEnded) response.end();
    }
  }

  private async readEvents(
    context: TenantContext,
    input: { readonly after: number; readonly limit: number },
  ): Promise<{ readonly events: readonly ApplicationEventV1[]; readonly cursor: number }> {
    try {
      return await this.dependencies.events.read(context, input);
    } catch (cause) {
      if (cause instanceof ApplicationEventCursorExpiredError) {
        throw new ApplicationError({
          category: "conflict",
          severity: "warning",
          retryable: true,
          userMessage: "사건 보존 범위가 지나 snapshot 재동기화가 필요합니다",
          operatorCode: "APP_EVENT_CURSOR_EXPIRED",
          cause,
        });
      }
      throw cause;
    }
  }

  private streamClosed(request: IncomingMessage, response: ServerResponse): boolean {
    return this.draining || request.destroyed || response.destroyed;
  }
}
