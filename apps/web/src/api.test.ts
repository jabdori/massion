import { describe, expect, it, vi } from "vitest";

import { WebApiClient } from "./api.js";

describe("WebApiClient", () => {
  it("일회성 code를 cookie session으로 교환하고 bearer token을 저장하지 않는다", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Response(
        JSON.stringify({
          schemaVersion: "massion.web.session.v1",
          sessionId: "session-1",
          context: { userId: "user-1", organizationId: "org-1", membershipId: "member-1", role: "owner" },
          scopes: ["application:*"],
          csrfToken: "c".repeat(43),
          issuedAt: "2026-07-11T00:00:00.000Z",
          expiresAt: "2026-07-11T08:00:00.000Z",
          idleExpiresAt: "2026-07-11T00:30:00.000Z",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const client = new WebApiClient({ fetcher });

    await expect(client.login("mwt_ticket.secret")).resolves.toMatchObject({ sessionId: "session-1" });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/web/sessions",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("authorization");
  });

  it("변경 요청에만 메모리의 CSRF token을 싣고 엄격한 wire envelope를 검사한다", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            schemaVersion: "massion.application.v1",
            commandId: "command-12345678",
            correlationId: "correlation-12345678",
            operation: "application.session.revoke",
            outcome: "succeeded",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const client = new WebApiClient({ fetcher });
    client.restoreCsrf("x".repeat(43));
    await client.command({
      schemaVersion: "massion.application.v1",
      commandId: "command-12345678",
      correlationId: "correlation-12345678",
      operation: "application.session.revoke",
      expectedRevision: 0,
      payload: { sessionId: "session-1", reason: "test" },
    });
    const call = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const headers = new Headers(call[1].headers);
    expect(headers.get("x-massion-csrf")).toBe("x".repeat(43));

    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ schemaVersion: "unknown", operation: "identity.me", data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(client.query("identity.me", {})).rejects.toThrow(/schemaVersion/u);
  });

  it("동시에 발생한 session 복구 요청을 한 번으로 합친다", async () => {
    let release: ((response: Response) => void) | undefined;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => (release = resolve)));
    const client = new WebApiClient({ fetcher });
    const first = client.recoverSession();
    const second = client.recoverSession();
    expect(fetcher).toHaveBeenCalledTimes(1);
    release?.(
      new Response(
        JSON.stringify({
          schemaVersion: "massion.web.session.v1",
          sessionId: "session-1",
          context: { userId: "user-1", organizationId: "org-1", membershipId: "member-1", role: "owner" },
          scopes: ["application:*"],
          csrfToken: "c".repeat(43),
          issuedAt: "2026-07-11T00:00:00.000Z",
          expiresAt: "2026-07-11T08:00:00.000Z",
          idleExpiresAt: "2026-07-11T00:30:00.000Z",
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });
});
