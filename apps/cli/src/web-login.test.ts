import { describe, expect, it } from "vitest";

import { issueWebLoginTicket, openWebConsole } from "./web-login.js";

describe("Web Console 진입", () => {
  it("인증된 profile로 5분 ticket을 발급하고 code를 URL에 넣지 않는다", async () => {
    const code = "mwt_123e4567-e89b-12d3-a456-426614174000." + "a".repeat(43);
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    let opened = "";
    const result = await openWebConsole({
      endpoint: "http://127.0.0.1:7331",
      token: "owner-token",
      fetcher: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ ticketId: "ticket-1", expiresAt: "2030-01-01T00:05:00.000Z", code }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
      openBrowser: async (url) => {
        opened = url;
      },
    });
    expect(result).toEqual({ url: "http://127.0.0.1:7331/", code, expiresAt: "2030-01-01T00:05:00.000Z" });
    expect(opened).toBe("http://127.0.0.1:7331/");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:7331/api/v1/web/login-tickets");
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer owner-token" });
    expect(String(calls[0]?.init?.body)).toContain('"ttlSeconds":300');
    expect(opened).not.toContain(code);
  });

  it("ticket response가 유효하지 않으면 Web을 열지 않는다", async () => {
    let opened = false;
    await expect(
      issueWebLoginTicket({
        endpoint: "https://massion.example.com",
        token: "owner-token",
        fetcher: async () => new Response(JSON.stringify({ ticketId: "missing-code" }), { status: 201 }),
      }),
    ).rejects.toThrow("Web login ticket");
    await expect(
      openWebConsole({
        endpoint: "https://massion.example.com",
        token: "owner-token",
        fetcher: async () => new Response(JSON.stringify({ ticketId: "missing-code" }), { status: 201 }),
        openBrowser: async () => {
          opened = true;
        },
      }),
    ).rejects.toThrow();
    expect(opened).toBe(false);
  });
});
