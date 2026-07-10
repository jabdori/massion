import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import {
  ExternalResearchStore,
  SecureHttpResearchProvider,
  type HttpResearchTransport,
  type ResearchSourceProvider,
} from "./index.js";

describe("secure external research", () => {
  it("HTTPS만 허용하고 private DNS·private redirect·timeout·size·media type을 차단한다", async () => {
    const publicAddress = [{ address: "93.184.216.34", family: 4 as const }];
    const response = (overrides: Partial<Awaited<ReturnType<HttpResearchTransport["request"]>>> = {}) => ({
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: new TextEncoder().encode("verified research"),
      ...overrides,
    });
    const transport: HttpResearchTransport = { request: async () => response() };
    const provider = new SecureHttpResearchProvider({
      resolve: async () => publicAddress,
      transport,
      timeoutMs: 50,
      maxBytes: 100,
      maxRedirects: 2,
    });
    await expect(provider.fetch("http://example.com/source")).rejects.toThrow("HTTPS");
    await expect(
      new SecureHttpResearchProvider({
        resolve: async () => [{ address: "127.0.0.1", family: 4 }],
        transport,
        timeoutMs: 50,
        maxBytes: 100,
        maxRedirects: 2,
      }).fetch("https://internal.example/source"),
    ).rejects.toThrow("public IP");

    const redirectTransport: HttpResearchTransport = {
      request: async () => response({ status: 302, headers: { location: "https://127.0.0.1/admin" } }),
    };
    await expect(
      new SecureHttpResearchProvider({
        resolve: async () => publicAddress,
        transport: redirectTransport,
        timeoutMs: 50,
        maxBytes: 100,
        maxRedirects: 2,
      }).fetch("https://example.com/source"),
    ).rejects.toThrow("public IP");

    const never: HttpResearchTransport = { request: async () => await new Promise(() => undefined) };
    await expect(
      new SecureHttpResearchProvider({
        resolve: async () => publicAddress,
        transport: never,
        timeoutMs: 10,
        maxBytes: 100,
        maxRedirects: 2,
      }).fetch("https://example.com/source"),
    ).rejects.toThrow("timeout");
    await expect(
      new SecureHttpResearchProvider({
        resolve: async () => publicAddress,
        transport: { request: async () => response({ body: new Uint8Array(101) }) },
        timeoutMs: 50,
        maxBytes: 100,
        maxRedirects: 2,
      }).fetch("https://example.com/source"),
    ).rejects.toThrow("크기");
    await expect(
      new SecureHttpResearchProvider({
        resolve: async () => publicAddress,
        transport: {
          request: async () => response({ headers: { "content-type": "application/octet-stream" } }),
        },
        timeoutMs: 50,
        maxBytes: 100,
        maxRedirects: 2,
      }).fetch("https://example.com/source"),
    ).rejects.toThrow("media type");
  });

  it("redirect 후 canonical URL·validator·content hash·fetch time이 있는 snapshot을 만든다", async () => {
    const provider = new SecureHttpResearchProvider({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: {
        request: async (input) =>
          input.url.pathname === "/start"
            ? { status: 301, headers: { location: "/final#fragment" }, body: new Uint8Array() }
            : {
                status: 200,
                headers: {
                  "content-type": "text/markdown; charset=utf-8",
                  etag: '"version-1"',
                  "last-modified": "Wed, 01 Jul 2026 00:00:00 GMT",
                },
                body: new TextEncoder().encode("# Verified\n\nPrimary source."),
              },
      },
      timeoutMs: 100,
      maxBytes: 1_000,
      maxRedirects: 2,
      now: () => new Date("2026-07-10T00:00:00.000Z"),
    });
    const fetched = await provider.fetch("https://Example.com/start#ignored");

    expect(fetched).toMatchObject({
      canonicalUrl: "https://example.com/final",
      mediaType: "text/markdown",
      etag: '"version-1"',
      lastModified: "Wed, 01 Jul 2026 00:00:00 GMT",
      fetchedAt: "2026-07-10T00:00:00.000Z",
      content: "# Verified\n\nPrimary source.",
    });
    expect(fetched.contentHash).toMatch(/^[a-f0-9]{64}$/u);
  });
});

describe("external research snapshot store", () => {
  let database: MassionDatabase;
  let context: TenantContext;

  beforeEach(async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "research@example.com", displayName: "Research" });
    context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
  });

  afterEach(async () => database.close());

  it("URL-only와 checksum 변조를 거부하고 완전한 source snapshot을 command 멱등 저장한다", async () => {
    const result = {
      canonicalUrl: "https://example.com/research",
      providerKind: "secure-http",
      fetchedAt: "2026-07-10T00:00:00.000Z",
      mediaType: "text/plain",
      content: "verified external evidence",
      contentHash: createHash("sha256").update("verified external evidence").digest("hex"),
      etag: '"v1"',
    } as const;
    const provider: ResearchSourceProvider = { fetch: async () => result };
    const store = await ExternalResearchStore.create(database, provider);
    const commandId = crypto.randomUUID();
    const first = await store.capture(context, { commandId, url: result.canonicalUrl });
    const repeated = await store.capture(context, { commandId, url: result.canonicalUrl });

    expect(first.source).toMatchObject(result);
    expect(repeated.source.externalSourceId).toBe(first.source.externalSourceId);
    const urlOnly: ResearchSourceProvider = {
      fetch: async () => ({
        ...result,
        content: "",
        contentHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      }),
    };
    await expect(
      (await ExternalResearchStore.create(database, urlOnly)).capture(context, {
        commandId: crypto.randomUUID(),
        url: result.canonicalUrl,
      }),
    ).rejects.toThrow("URL-only");
    const tampered: ResearchSourceProvider = { fetch: async () => ({ ...result, contentHash: "0".repeat(64) }) };
    await expect(
      (await ExternalResearchStore.create(database, tampered)).capture(context, {
        commandId: crypto.randomUUID(),
        url: result.canonicalUrl,
      }),
    ).rejects.toThrow("checksum");
  });
});
