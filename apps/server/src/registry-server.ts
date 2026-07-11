import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

interface RegistryHandler {
  handle(request: Request, organizationId: string): Promise<Response>;
}

const PUBLIC_ORGANIZATION = "public-registry";
const FORWARDED_HEADERS = new Set([
  "allow",
  "cache-control",
  "content-length",
  "content-type",
  "etag",
  "retry-after",
  "x-content-type-options",
]);

export class RegistryReadHttpServer {
  private readonly server: Server;
  private activeRequests = 0;
  private readonly rateWindows = new Map<string, { readonly startedAt: number; readonly count: number }>();

  public constructor(
    private readonly handler: RegistryHandler,
    private readonly options: {
      readonly host: string;
      readonly port: number;
      readonly maximumConcurrentRequests?: number;
      readonly rateLimitPerMinute?: number;
      readonly now?: () => number;
    },
  ) {
    this.server = createServer({ maxHeaderSize: 8 * 1024, requestTimeout: 5_000 }, (request, response) => {
      const method = request.method ?? "GET";
      const path = request.url ?? "/";
      const guarded = (method === "GET" || method === "HEAD") && path.startsWith("/npm/");
      if (guarded && this.activeRequests >= (this.options.maximumConcurrentRequests ?? 64)) {
        void this.end(
          response,
          new Response(JSON.stringify({ error: "Registry is busy" }), { status: 503 }),
          method,
          "1",
        );
        return;
      }
      if (guarded) {
        const retryAfter = this.rateLimitRetryAfter(request.socket.remoteAddress ?? "unknown");
        if (retryAfter !== undefined) {
          void this.end(
            response,
            new Response(JSON.stringify({ error: "Registry rate limit exceeded" }), { status: 429 }),
            method,
            String(retryAfter),
          );
          return;
        }
        this.activeRequests += 1;
      }
      void this.respond(method, path)
        .then(async (result) => {
          await this.end(response, result, method);
        })
        .catch(() => {
          response.writeHead(500).end();
        })
        .finally(() => {
          if (guarded) this.activeRequests -= 1;
        });
    });
    this.server.maxHeadersCount = 32;
    this.server.headersTimeout = 3_000;
    this.server.keepAliveTimeout = 2_000;
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
    if (!address || typeof address === "string") throw new Error("Registry listener address를 확인할 수 없습니다");
    const host = address.address.includes(":") ? `[${address.address}]` : address.address;
    return { host: address.address, port: address.port, url: `http://${host}:${String(address.port)}` };
  }

  public async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }

  private async respond(method: string, path: string): Promise<Response> {
    if (method !== "GET" && method !== "HEAD")
      return new Response(JSON.stringify({ error: "public Registry is read-only" }), {
        status: 405,
        headers: { "content-type": "application/json", allow: "GET, HEAD" },
      });
    if (!path.startsWith("/npm/")) return new Response(null, { status: 404 });
    try {
      return await this.handler.handle(
        new Request(`http://registry.invalid${path}`, { method: "GET" }),
        PUBLIC_ORGANIZATION,
      );
    } catch {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
  }

  private async end(
    response: import("node:http").ServerResponse,
    result: Response,
    method: string,
    retryAfter?: string,
  ): Promise<void> {
    const headers = Object.fromEntries(
      [...result.headers].filter(([name]) => FORWARDED_HEADERS.has(name.toLocaleLowerCase("en-US"))),
    );
    response.writeHead(result.status, {
      ...headers,
      ...(retryAfter ? { "retry-after": retryAfter } : {}),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    });
    if (method === "HEAD") response.end();
    else response.end(Buffer.from(await result.arrayBuffer()));
  }

  private rateLimitRetryAfter(remoteAddress: string): number | undefined {
    const now = this.options.now?.() ?? Date.now();
    const key = createHash("sha256").update(remoteAddress).digest("hex").slice(0, 32);
    const current = this.rateWindows.get(key);
    if (!current || now - current.startedAt >= 60_000) {
      if (this.rateWindows.size >= 4096) this.rateWindows.delete(this.rateWindows.keys().next().value as string);
      this.rateWindows.set(key, { startedAt: now, count: 1 });
      return undefined;
    }
    if (current.count >= (this.options.rateLimitPerMinute ?? 600))
      return Math.max(1, Math.ceil((60_000 - (now - current.startedAt)) / 1_000));
    this.rateWindows.set(key, { ...current, count: current.count + 1 });
    return undefined;
  }
}
