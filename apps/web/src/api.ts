export interface TenantContextView {
  readonly userId: string;
  readonly organizationId: string;
  readonly membershipId: string;
  readonly role: "owner" | "admin" | "member";
}

export interface WebSessionEnvelope {
  readonly schemaVersion: "massion.web.session.v1";
  readonly sessionId: string;
  readonly context: TenantContextView;
  readonly scopes: readonly string[];
  readonly csrfToken: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly idleExpiresAt: string;
}

export interface ApplicationQueryEnvelope {
  readonly schemaVersion: "massion.application.v1";
  readonly operation: string;
  readonly data: unknown;
}

export interface ApplicationCommandInput {
  readonly schemaVersion: "massion.application.v1";
  readonly commandId: string;
  readonly correlationId: string;
  readonly operation: string;
  readonly expectedRevision?: number;
  readonly payload: unknown;
}

export interface ApplicationCommandEnvelope {
  readonly schemaVersion: "massion.application.v1";
  readonly commandId: string;
  readonly correlationId: string;
  readonly operation: string;
  readonly outcome: "succeeded" | "accepted" | "awaiting-approval" | "blocked";
  readonly resource?: Readonly<Record<string, unknown>>;
  readonly data?: unknown;
}

interface WebApiClientOptions {
  readonly fetcher?: typeof fetch;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}가 object가 아닙니다`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label}에 알 수 없는 필드가 있습니다: ${unknown}`);
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}가 문자열이 아닙니다`);
  return value;
}

function session(value: unknown): WebSessionEnvelope {
  const candidate = record(value, "Web session 응답");
  exact(
    candidate,
    ["schemaVersion", "sessionId", "context", "scopes", "csrfToken", "issuedAt", "expiresAt", "idleExpiresAt"],
    "Web session 응답",
  );
  if (candidate.schemaVersion !== "massion.web.session.v1") throw new Error("Web session schemaVersion이 다릅니다");
  const context = record(candidate.context, "Web session context");
  exact(context, ["userId", "organizationId", "membershipId", "role"], "Web session context");
  const role = string(context.role, "role");
  if (role !== "owner" && role !== "admin" && role !== "member") throw new Error("Web session role이 다릅니다");
  if (!Array.isArray(candidate.scopes) || candidate.scopes.some((scope) => typeof scope !== "string"))
    throw new Error("Web session scopes가 다릅니다");
  const csrfToken = string(candidate.csrfToken, "csrfToken");
  if (!/^[A-Za-z0-9_-]{43}$/u.test(csrfToken)) throw new Error("Web session csrfToken이 다릅니다");
  return {
    schemaVersion: "massion.web.session.v1",
    sessionId: string(candidate.sessionId, "sessionId"),
    context: {
      userId: string(context.userId, "userId"),
      organizationId: string(context.organizationId, "organizationId"),
      membershipId: string(context.membershipId, "membershipId"),
      role,
    },
    scopes: candidate.scopes as string[],
    csrfToken,
    issuedAt: string(candidate.issuedAt, "issuedAt"),
    expiresAt: string(candidate.expiresAt, "expiresAt"),
    idleExpiresAt: string(candidate.idleExpiresAt, "idleExpiresAt"),
  };
}

function queryEnvelope(value: unknown): ApplicationQueryEnvelope {
  const candidate = record(value, "Application query 응답");
  exact(candidate, ["schemaVersion", "operation", "data"], "Application query 응답");
  if (candidate.schemaVersion !== "massion.application.v1")
    throw new Error("Application query schemaVersion이 다릅니다");
  return {
    schemaVersion: "massion.application.v1",
    operation: string(candidate.operation, "operation"),
    data: candidate.data,
  };
}

function commandEnvelope(value: unknown): ApplicationCommandEnvelope {
  const candidate = record(value, "Application command 응답");
  exact(
    candidate,
    ["schemaVersion", "commandId", "correlationId", "operation", "outcome", "resource", "data"],
    "Application command 응답",
  );
  if (candidate.schemaVersion !== "massion.application.v1")
    throw new Error("Application command schemaVersion이 다릅니다");
  const outcome = string(candidate.outcome, "outcome");
  if (!["succeeded", "accepted", "awaiting-approval", "blocked"].includes(outcome))
    throw new Error("Application command outcome이 다릅니다");
  return {
    schemaVersion: "massion.application.v1",
    commandId: string(candidate.commandId, "commandId"),
    correlationId: string(candidate.correlationId, "correlationId"),
    operation: string(candidate.operation, "operation"),
    outcome: outcome as ApplicationCommandEnvelope["outcome"],
    ...(candidate.resource === undefined ? {} : { resource: record(candidate.resource, "resource") }),
    ...(candidate.data === undefined ? {} : { data: candidate.data }),
  };
}

export class WebApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly detail: unknown,
  ) {
    super(`Massion API 요청이 실패했습니다 (${String(status)})`);
  }
}

export class WebApiClient {
  private readonly fetcher: typeof fetch;
  private csrfToken: string | undefined;
  private sessionRecovery: Promise<WebSessionEnvelope> | undefined;

  public constructor(options: WebApiClientOptions = {}) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  public restoreCsrf(value: string): void {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error("CSRF token이 유효하지 않습니다");
    this.csrfToken = value;
  }

  public async login(code: string): Promise<WebSessionEnvelope> {
    const value = session(
      await this.request("/api/v1/web/sessions", { method: "POST", body: JSON.stringify({ code }) }),
    );
    this.csrfToken = value.csrfToken;
    return value;
  }

  public recoverSession(): Promise<WebSessionEnvelope> {
    if (this.sessionRecovery) return this.sessionRecovery;
    const pending = this.request("/api/v1/web/session", { method: "GET" })
      .then((response) => {
        const value = session(response);
        this.csrfToken = value.csrfToken;
        return value;
      })
      .finally(() => {
        if (this.sessionRecovery === pending) this.sessionRecovery = undefined;
      });
    this.sessionRecovery = pending;
    return pending;
  }

  public async logout(): Promise<void> {
    await this.request("/api/v1/web/session", { method: "DELETE" }, true);
    this.csrfToken = undefined;
  }

  public async query(operation: string, payload: unknown): Promise<ApplicationQueryEnvelope> {
    return queryEnvelope(
      await this.request("/api/v1/query", { method: "POST", body: JSON.stringify({ operation, payload }) }),
    );
  }

  public async snapshot(): Promise<ApplicationQueryEnvelope> {
    return queryEnvelope(await this.request("/api/v1/snapshot", { method: "GET" }));
  }

  public async command(input: ApplicationCommandInput): Promise<ApplicationCommandEnvelope> {
    return commandEnvelope(
      await this.request("/api/v1/commands", { method: "POST", body: JSON.stringify(input) }, true),
    );
  }

  private async request(path: string, init: RequestInit, mutation = false): Promise<unknown> {
    if (mutation && !this.csrfToken) throw new Error("변경 요청에 필요한 CSRF token이 없습니다");
    const response = await this.fetcher(path, {
      ...init,
      credentials: "include",
      headers: {
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(mutation ? { "x-massion-csrf": this.csrfToken ?? "" } : {}),
        ...Object.fromEntries(new Headers(init.headers)),
      },
    });
    const value: unknown =
      response.status === 204 ? undefined : await response.json().catch(() => undefined as unknown);
    if (!response.ok) throw new WebApiError(response.status, value);
    return value;
  }
}
