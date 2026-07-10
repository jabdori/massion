import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import { OrganizationService, type TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { EVIDENCE_RESEARCH_MIGRATION } from "./schema.js";

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface HttpResearchResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface HttpResearchTransport {
  request(input: {
    readonly url: URL;
    readonly address: ResolvedAddress;
    readonly timeoutMs: number;
    readonly maxBytes: number;
  }): Promise<HttpResearchResponse>;
}

export interface ResearchFetchResult {
  readonly canonicalUrl: string;
  readonly providerKind: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly fetchedAt: string;
  readonly mediaType: string;
  readonly contentHash: string;
  readonly content: string;
}

export interface ResearchSourceProvider {
  fetch(url: string): Promise<ResearchFetchResult>;
}

export interface SecureHttpResearchOptions {
  readonly resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  readonly transport?: HttpResearchTransport;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxRedirects: number;
  readonly now?: () => Date;
}

export interface ExternalResearchSource extends ResearchFetchResult {
  readonly externalSourceId: string;
  readonly organizationId: string;
  readonly createdByUserId: string;
  readonly createdAt: unknown;
}

interface ExternalSourceRecord {
  readonly external_source_id: string;
  readonly organization_id: string;
  readonly canonical_url: string;
  readonly provider_kind: string;
  readonly etag?: string;
  readonly last_modified?: string;
  readonly fetched_at: unknown;
  readonly media_type: string;
  readonly content_hash: string;
  readonly content: string;
  readonly created_by_user_id: string;
  readonly created_at: unknown;
}

interface ResearchEventRecord {
  readonly request_hash: string;
  readonly result_json: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalUrl(input: string, base?: URL): URL {
  const url = base ? new URL(input, base) : new URL(input);
  if (url.protocol !== "https:") throw new Error("External research는 HTTPS URL만 허용합니다");
  if (url.username || url.password) throw new Error("External research URL credential은 허용되지 않습니다");
  url.hash = "";
  if (url.port === "443") url.port = "";
  return url;
}

function isPublicIpv4(address: string): boolean {
  const toInteger = (value: string): number | undefined => {
    const octets = value.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255))
      return undefined;
    return (
      ((((octets[0] ?? 0) << 24) >>> 0) + ((octets[1] ?? 0) << 16) + ((octets[2] ?? 0) << 8) + (octets[3] ?? 0)) >>> 0
    );
  };
  const value = toInteger(address);
  if (value === undefined) return false;
  const blocked = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const;
  return !blocked.some(([network, prefix]) => {
    const networkValue = toInteger(network);
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    return networkValue !== undefined && (value & mask) >>> 0 === (networkValue & mask) >>> 0;
  });
}

function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) return isPublicIpv4(lower.slice("::ffff:".length));
  return !(
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    /^fe[89ab]/u.test(lower) ||
    lower.startsWith("ff") ||
    lower.startsWith("2001:db8")
  );
}

function header(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const target = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1];
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("External research timeout"));
    }, timeoutMs);
    timer.unref();
    operation.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("External research transport 실패"));
      },
    );
  });
}

class NodeHttpsResearchTransport implements HttpResearchTransport {
  public async request(input: {
    readonly url: URL;
    readonly address: ResolvedAddress;
    readonly timeoutMs: number;
    readonly maxBytes: number;
  }): Promise<HttpResearchResponse> {
    return await new Promise<HttpResearchResponse>((resolve, reject) => {
      const signal = AbortSignal.timeout(input.timeoutMs);
      const request = httpsRequest(
        {
          protocol: "https:",
          hostname: input.address.address,
          family: input.address.family,
          port: input.url.port ? Number(input.url.port) : 443,
          path: `${input.url.pathname}${input.url.search}`,
          method: "GET",
          servername: input.url.hostname,
          signal,
          headers: { host: input.url.host, accept: "text/plain,text/markdown,text/html,application/json" },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          const declared = Number(response.headers["content-length"] ?? 0);
          if (declared > input.maxBytes) {
            response.destroy();
            reject(new Error("External research 응답 크기가 제한을 초과했습니다"));
            return;
          }
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > input.maxBytes) {
              response.destroy(new Error("External research 응답 크기가 제한을 초과했습니다"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            const headers = Object.fromEntries(
              Object.entries(response.headers)
                .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
                .map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value]),
            );
            resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
          });
        },
      );
      request.on("error", reject);
      request.end();
    });
  }
}

export class SecureHttpResearchProvider implements ResearchSourceProvider {
  private readonly resolver: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  private readonly transport: HttpResearchTransport;
  private readonly now: () => Date;

  public constructor(private readonly options: SecureHttpResearchOptions) {
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("timeoutMs가 잘못됐습니다");
    if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1) throw new Error("maxBytes가 잘못됐습니다");
    if (!Number.isInteger(options.maxRedirects) || options.maxRedirects < 0 || options.maxRedirects > 10)
      throw new Error("maxRedirects가 잘못됐습니다");
    this.resolver =
      options.resolve ??
      (async (hostname) =>
        (await lookup(hostname, { all: true, order: "verbatim" })).map((item) => ({
          address: item.address,
          family: item.family === 6 ? 6 : 4,
        })));
    this.transport = options.transport ?? new NodeHttpsResearchTransport();
    this.now = options.now ?? (() => new Date());
  }

  public async fetch(input: string): Promise<ResearchFetchResult> {
    let url = canonicalUrl(input);
    for (let redirects = 0; ; redirects += 1) {
      if (redirects > this.options.maxRedirects) throw new Error("External research redirect 제한을 초과했습니다");
      const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
      const addresses = isIP(hostname)
        ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
        : await withTimeout(this.resolver(hostname), this.options.timeoutMs);
      if (
        addresses.length === 0 ||
        addresses.some((address) => isIP(address.address) !== address.family || !isPublicIp(address.address))
      )
        throw new Error("External research 대상은 public IP로만 해석되어야 합니다");
      const response = await withTimeout(
        this.transport.request({
          url,
          address: addresses[0] as ResolvedAddress,
          timeoutMs: this.options.timeoutMs,
          maxBytes: this.options.maxBytes,
        }),
        this.options.timeoutMs,
      );
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = header(response.headers, "location");
        if (!location) throw new Error("External research redirect location이 없습니다");
        url = canonicalUrl(location, url);
        continue;
      }
      if (response.status < 200 || response.status >= 300)
        throw new Error(`External research HTTP status가 성공이 아닙니다: ${String(response.status)}`);
      if (response.body.byteLength > this.options.maxBytes)
        throw new Error("External research 응답 크기가 제한을 초과했습니다");
      const mediaType = (header(response.headers, "content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
      if (!mediaType || !["text/plain", "text/markdown", "text/html", "application/json"].includes(mediaType))
        throw new Error(`External research media type이 허용되지 않습니다: ${mediaType ?? "missing"}`);
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
      } catch {
        throw new Error("External research 응답이 유효한 UTF-8이 아닙니다");
      }
      if (!content.trim()) throw new Error("External research URL-only 응답은 evidence가 아닙니다");
      const etag = header(response.headers, "etag");
      const lastModified = header(response.headers, "last-modified");
      return {
        canonicalUrl: url.toString(),
        providerKind: "secure-http",
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
        fetchedAt: this.now().toISOString(),
        mediaType,
        contentHash: sha256(response.body),
        content,
      };
    }
  }
}

export class ExternalResearchStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
    private readonly provider: ResearchSourceProvider,
  ) {}

  public static async create(
    database: MassionDatabase,
    provider: ResearchSourceProvider,
  ): Promise<ExternalResearchStore> {
    const organizations = await OrganizationService.create(database);
    await applyMigrations(database, [EVIDENCE_RESEARCH_MIGRATION]);
    return new ExternalResearchStore(database, organizations, provider);
  }

  public async capture(
    context: TenantContext,
    input: { readonly commandId: string; readonly url: string },
  ): Promise<{ readonly source: ExternalResearchSource }> {
    await this.organizations.verifyTenantContext(context);
    if (!input.commandId.trim() || !input.url.trim()) throw new Error("Research command와 URL이 필요합니다");
    const requestHash = sha256(canonicalJson(input));
    const replayed = await this.replay(this.database, context.organizationId, input.commandId, requestHash);
    if (replayed) return { source: await this.getSource(context, replayed.externalSourceId) };
    const fetched = await this.provider.fetch(input.url);
    if (!fetched.content.trim()) throw new Error("External research URL-only 응답은 evidence가 아닙니다");
    if (sha256(fetched.content) !== fetched.contentHash)
      throw new Error("External research content checksum이 일치하지 않습니다");
    const parsedFetchedAt = new Date(fetched.fetchedAt);
    if (!Number.isFinite(parsedFetchedAt.getTime())) throw new Error("External research fetchedAt이 잘못됐습니다");
    const url = canonicalUrl(fetched.canonicalUrl).toString();
    return await this.database.transaction(async (tx) => {
      await this.organizations.verifyTenantContext(context, undefined, tx);
      const repeated = await this.replay(tx, context.organizationId, input.commandId, requestHash);
      if (repeated) return { source: await this.getSource(context, repeated.externalSourceId) };
      const [existing] = await tx.query<[ExternalSourceRecord[]]>(
        "SELECT * OMIT id FROM external_research_source WHERE organization_id = $organization_id AND canonical_url = $canonical_url AND content_hash = $content_hash LIMIT 1;",
        { organization_id: context.organizationId, canonical_url: url, content_hash: fetched.contentHash },
      );
      let record = existing[0];
      if (!record) {
        const [created] = await tx.query<[ExternalSourceRecord[]]>(
          "CREATE external_research_source CONTENT { external_source_id: $external_source_id, organization_id: $organization_id, canonical_url: $canonical_url, provider_kind: $provider_kind, etag: $etag, last_modified: $last_modified, fetched_at: $fetched_at, media_type: $media_type, content_hash: $content_hash, content: $content, created_by_user_id: $created_by_user_id, created_at: time::now() } RETURN AFTER;",
          {
            external_source_id: randomUUID(),
            organization_id: context.organizationId,
            canonical_url: url,
            provider_kind: fetched.providerKind,
            etag: fetched.etag,
            last_modified: fetched.lastModified,
            fetched_at: parsedFetchedAt,
            media_type: fetched.mediaType,
            content_hash: fetched.contentHash,
            content: fetched.content,
            created_by_user_id: context.userId,
          },
        );
        record = created[0];
      }
      if (!record) throw new Error("External research source 생성 결과가 없습니다");
      await tx.query(
        "CREATE external_research_event CONTENT { event_id: $event_id, organization_id: $organization_id, external_source_id: $external_source_id, command_id: $command_id, request_hash: $request_hash, event_type: 'research_source_captured', payload_json: $payload_json, result_json: $result_json, actor_user_id: $actor_user_id, created_at: time::now() };",
        {
          event_id: randomUUID(),
          organization_id: context.organizationId,
          external_source_id: record.external_source_id,
          command_id: input.commandId,
          request_hash: requestHash,
          payload_json: canonicalJson({ mediaType: fetched.mediaType, contentHash: fetched.contentHash }),
          result_json: JSON.stringify({ externalSourceId: record.external_source_id }),
          actor_user_id: context.userId,
        },
      );
      return { source: this.view(record) };
    });
  }

  public async getSource(context: TenantContext, externalSourceId: string): Promise<ExternalResearchSource> {
    await this.organizations.verifyTenantContext(context);
    const [records] = await this.database.query<[ExternalSourceRecord[]]>(
      "SELECT * OMIT id FROM external_research_source WHERE organization_id = $organization_id AND external_source_id = $external_source_id LIMIT 1;",
      { organization_id: context.organizationId, external_source_id: externalSourceId },
    );
    if (!records[0]) throw new Error(`External research source를 찾을 수 없습니다: ${externalSourceId}`);
    const source = this.view(records[0]);
    if (sha256(source.content) !== source.contentHash)
      throw new Error(`External research source checksum이 일치하지 않습니다: ${externalSourceId}`);
    return source;
  }

  private async replay(
    executor: QueryExecutor,
    organizationId: string,
    commandId: string,
    requestHash: string,
  ): Promise<{ readonly externalSourceId: string } | undefined> {
    const [events] = await executor.query<[ResearchEventRecord[]]>(
      "SELECT request_hash, result_json FROM external_research_event WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
      { organization_id: organizationId, command_id: commandId },
    );
    if (!events[0]) return undefined;
    if (events[0].request_hash !== requestHash)
      throw new Error("같은 commandId에 다른 external research 요청을 사용할 수 없습니다");
    return JSON.parse(events[0].result_json) as { readonly externalSourceId: string };
  }

  private view(record: ExternalSourceRecord): ExternalResearchSource {
    const fetchedAt =
      record.fetched_at instanceof Date
        ? record.fetched_at.toISOString()
        : typeof record.fetched_at === "string"
          ? new Date(record.fetched_at).toISOString()
          : String(record.fetched_at);
    return {
      externalSourceId: record.external_source_id,
      organizationId: record.organization_id,
      canonicalUrl: record.canonical_url,
      providerKind: record.provider_kind,
      ...(record.etag ? { etag: record.etag } : {}),
      ...(record.last_modified ? { lastModified: record.last_modified } : {}),
      fetchedAt,
      mediaType: record.media_type,
      contentHash: record.content_hash,
      content: record.content,
      createdByUserId: record.created_by_user_id,
      createdAt: record.created_at,
    };
  }
}
