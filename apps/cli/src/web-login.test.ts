import { describe, expect, it } from "vitest";

import { issueDesktopSession, issueWebLoginTicket, openWebConsole } from "./web-login.js";

describe("Web Console 진입", () => {
  it("인증된 profile로 5분 ticket을 발급하고 자동 로그인용 code를 URL에 포함한다", async () => {
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
    const expectedUrl = `http://127.0.0.1:7331/login?code=${encodeURIComponent(code)}`;
    expect(result).toEqual({ url: expectedUrl, code, expiresAt: "2030-01-01T00:05:00.000Z" });
    expect(opened).toBe(expectedUrl);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:7331/api/v1/web/login-tickets");
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer owner-token" });
    expect(String(calls[0]?.init?.body)).toContain('"ttlSeconds":300');
    expect(opened).toContain(code);
  });

  it("데스크톱 세션은 티켓을 서버측에서 교환해 주입용 세션 쿠키를 반환한다", async () => {
    const code = "mwt_123e4567-e89b-12d3-a456-426614174000." + "a".repeat(43);
    const token = "mws_9a-token." + "b".repeat(43);
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const session = await issueDesktopSession({
      endpoint: "http://127.0.0.1:7331",
      token: "owner-token",
      fetcher: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith("/api/v1/web/login-tickets"))
          return new Response(JSON.stringify({ ticketId: "ticket-1", expiresAt: "2030-01-01T00:05:00.000Z", code }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        return new Response(JSON.stringify({ schemaVersion: "massion.web.session.v1" }), {
          status: 201,
          headers: {
            "content-type": "application/json",
            "set-cookie": `massion_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28799`,
          },
        });
      },
    });
    // 주입용 쿠키는 name=value만 남기고 속성은 shell이 붙인다.
    expect(session).toEqual({
      origin: "http://127.0.0.1:7331",
      cookie: `massion_session=${token}`,
      maxAgeSeconds: 28799,
    });
    // 교환 요청은 브라우저와 동일한 Origin·Fetch Metadata를 실어 서버 CSRF 방어를 통과해야 한다.
    const exchange = calls.find((entry) => entry.url.endsWith("/api/v1/web/sessions"));
    expect(exchange?.init?.headers).toMatchObject({
      origin: "http://127.0.0.1:7331",
      "sec-fetch-site": "same-origin",
    });
    expect(String(exchange?.init?.body)).toContain(code);
  });

  it("세션 교환이 거부되면 데스크톱 세션 발급이 실패한다", async () => {
    const code = "mwt_123e4567-e89b-12d3-a456-426614174000." + "a".repeat(43);
    await expect(
      issueDesktopSession({
        endpoint: "http://127.0.0.1:7331",
        token: "owner-token",
        fetcher: async (url) =>
          String(url).endsWith("/api/v1/web/login-tickets")
            ? new Response(JSON.stringify({ ticketId: "ticket-1", expiresAt: "2030-01-01T00:05:00.000Z", code }), {
                status: 201,
                headers: { "content-type": "application/json" },
              })
            : new Response(JSON.stringify({ detail: "denied" }), { status: 401 }),
      }),
    ).rejects.toThrow("Web session 교환");
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
