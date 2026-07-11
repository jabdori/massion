import type { ArtifactStore } from "./artifact-store.js";
import type { RegistryCatalog } from "./catalog.js";

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

export class RegistryHttpHandler {
  private readonly baseUrl: URL;
  public constructor(
    private readonly dependencies: {
      readonly catalog: RegistryCatalog;
      readonly artifacts: ArtifactStore;
      readonly publicBaseUrl: string;
      readonly stagePublisher?: {
        stage(input: {
          commandId: string;
          organizationId: string;
          uploadGrant: string;
          archive: Buffer;
          provenanceBundle: unknown;
        }): Promise<unknown>;
      };
    },
  ) {
    this.baseUrl = new URL(dependencies.publicBaseUrl);
    const loopback = ["127.0.0.1", "::1", "localhost"].includes(this.baseUrl.hostname);
    if (
      (this.baseUrl.protocol !== "https:" && !(this.baseUrl.protocol === "http:" && loopback)) ||
      this.baseUrl.username ||
      this.baseUrl.password ||
      this.baseUrl.search ||
      this.baseUrl.hash
    )
      throw new Error("Registry public base URL은 credential 없는 HTTPS여야 합니다");
  }

  public async handle(request: Request, organizationId: string): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "DELETE")
      return json({ error: "package versions are immutable; use recall" }, 405, { allow: "GET, PUT" });
    if (!url.pathname.startsWith("/npm/")) return json({ error: "not found" }, 404);
    const rest = url.pathname.slice("/npm/".length);
    const marker = rest.indexOf("/-/");
    if (request.method === "GET" && marker < 0) {
      const packageName = decodeURIComponent(rest);
      const packument = structuredClone(await this.dependencies.catalog.packument(organizationId, packageName)) as {
        name: string;
        "dist-tags": Record<string, string>;
        versions: Record<string, { deprecated?: string; dist: { tarball: string; integrity: string } }>;
      };
      for (const value of Object.values(packument.versions)) {
        const target = new URL(value.dist.tarball, this.baseUrl);
        const versionId = target.searchParams.get("v");
        if (!versionId || value.deprecated) continue;
        const grant = await this.dependencies.catalog.issueDownload({ organizationId, versionId });
        target.searchParams.set("grant", grant.token);
        value.dist.tarball = target.toString();
      }
      return json(packument, 200, { "cache-control": "private, max-age=60" });
    }
    if (request.method === "GET" && marker >= 0) {
      const packageName = decodeURIComponent(rest.slice(0, marker));
      const grant = url.searchParams.get("grant");
      if (!grant) return json({ error: "download grant required" }, 401);
      const version = await this.dependencies.catalog.verifyDownload(grant, organizationId);
      if (version.packageName !== packageName) return json({ error: "download package mismatch" }, 403);
      const body = await this.dependencies.artifacts.get(version.artifactDigest);
      return new Response(body as unknown as BodyInit, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(body.length),
          "cache-control": "private, immutable, max-age=31536000",
          "x-content-type-options": "nosniff",
          etag: `"sha256-${version.artifactDigest}"`,
        },
      });
    }
    if (request.method === "PUT" && marker < 0)
      return await this.stage(request, organizationId, decodeURIComponent(rest));
    return json({ error: "method not allowed" }, 405, { allow: "GET, PUT" });
  }

  private async stage(request: Request, organizationId: string, packageName: string): Promise<Response> {
    if (!this.dependencies.stagePublisher) return json({ error: "publish ingress disabled" }, 503);
    const length = Number(request.headers.get("content-length") ?? "0");
    if (length > 48 * 1024 * 1024) return json({ error: "publish payload too large" }, 413);
    const text = await request.text();
    if (Buffer.byteLength(text) > 48 * 1024 * 1024) return json({ error: "publish payload too large" }, 413);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return json({ error: "invalid publish JSON" }, 400);
    }
    if (payload.name !== packageName) return json({ error: "package name mismatch" }, 400);
    const attachments = payload._attachments;
    if (!attachments || typeof attachments !== "object" || Array.isArray(attachments))
      return json({ error: "attachment required" }, 400);
    const entries = Object.values(attachments as Record<string, unknown>);
    if (entries.length !== 1 || !entries[0] || typeof entries[0] !== "object")
      return json({ error: "exactly one attachment required" }, 400);
    const data = (entries[0] as Record<string, unknown>).data;
    if (typeof data !== "string") return json({ error: "attachment data required" }, 400);
    const archive = Buffer.from(data, "base64");
    if (archive.length === 0 || archive.length > 32 * 1024 * 1024)
      return json({ error: "attachment size invalid" }, 413);
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) return json({ error: "upload grant required" }, 401);
    const provenanceHeader = request.headers.get("x-massion-provenance");
    if (!provenanceHeader || provenanceHeader.length > 1024 * 1024) return json({ error: "provenance required" }, 400);
    let provenanceBundle: unknown;
    try {
      provenanceBundle = JSON.parse(Buffer.from(provenanceHeader, "base64url").toString("utf8")) as unknown;
    } catch {
      return json({ error: "invalid provenance" }, 400);
    }
    const commandId = request.headers.get("x-massion-command-id");
    if (!commandId) return json({ error: "command id required" }, 400);
    const result = await this.dependencies.stagePublisher.stage({
      commandId,
      organizationId,
      uploadGrant: authorization.slice(7),
      archive,
      provenanceBundle,
    });
    return json({ ok: true, result }, 201);
  }
}
