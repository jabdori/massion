import { describe, expect, it, vi } from "vitest";

import { ApplicationHttpClient, ApplicationRemoteError } from "./http-client.js";

describe("ApplicationHttpClient", () => {
  it("query와 동일 command는 일시 네트워크 실패를 bounded retry한다", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: "query" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ outcome: "succeeded" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const client = new ApplicationHttpClient({
      baseUrl: "http://127.0.0.1:9000",
      token: "secret",
      fetcher,
      retry: { attempts: 2, delayMs: 0 },
    });
    await expect(client.query("work.list", {})).resolves.toEqual({ data: "query" });
    await expect(client.command({ commandId: "command-client-0001" })).resolves.toEqual({ outcome: "succeeded" });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.every(([url]) => !String(url).includes("secret"))).toBe(true);
  });

  it("authentication·validation 응답과 artifact upload는 자동 retry하지 않는다", async () => {
    const authentication = new Response(JSON.stringify({ category: "authentication", userMessage: "인증 실패" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(authentication)
      .mockRejectedValueOnce(new TypeError("upload network"));
    const client = new ApplicationHttpClient({
      baseUrl: "http://127.0.0.1:9000",
      token: "secret",
      fetcher,
      retry: { attempts: 3, delayMs: 0 },
    });
    await expect(client.query("work.list", {})).rejects.toBeInstanceOf(ApplicationRemoteError);
    await expect(client.inspectArtifact(Buffer.from("artifact"))).rejects.toThrow("upload network");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("http endpoint만 허용하고 TLS certificate 검증 비활성화 option을 노출하지 않는다", () => {
    expect(() => new ApplicationHttpClient({ baseUrl: "file:///tmp/socket", token: "secret" })).toThrow("HTTP");
    expect(() => new ApplicationHttpClient({ baseUrl: "http://example.com", token: "secret" })).toThrow("loopback");
  });

  it("Registry publish를 metadata 길이 prefix와 artifact byte로 전송한다", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ state: "staged" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ApplicationHttpClient({
      baseUrl: "http://127.0.0.1:9000",
      token: "secret",
      fetcher,
    });
    await client.publishArtifact("registry-publish-command-1", Buffer.from("artifact"), {
      uploadGrant: "grant-reference",
    });
    const init = fetcher.mock.calls[0]?.[1];
    const body = Buffer.from(init?.body as unknown as Uint8Array);
    const metadataLength = body.readUInt32BE(0);
    expect(JSON.parse(body.subarray(4, 4 + metadataLength).toString("utf8"))).toEqual({
      uploadGrant: "grant-reference",
    });
    expect(body.subarray(4 + metadataLength).toString()).toBe("artifact");
  });
});
