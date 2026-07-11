import { randomBytes } from "node:crypto";

import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase } from "@massion/storage";
import { describe, expect, it } from "vitest";

import { ApplicationAccessTokenService } from "./auth.js";
import { WebSessionService } from "./web-session.js";

async function fixture() {
  const database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
  const identities = await IdentityService.create(database);
  const organizations = await OrganizationService.create(database);
  const owner = await identities.registerPersonalUser({ email: "web@example.com", displayName: "Web Owner" });
  const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
  const now = { value: new Date("2026-07-11T10:00:00.000Z") };
  const tokens = await ApplicationAccessTokenService.create(database, organizations, {
    keyId: "web-token-key",
    key: randomBytes(32),
    clock: {
      get now() {
        return now.value;
      },
    },
  });
  const issued = await tokens.issue(context, {
    commandId: "web-source-token-0001",
    audience: "massion-api",
    scopes: ["application:*"],
    ttlSeconds: 3_600,
  });
  if (!issued.token) throw new Error("source token 원문이 없습니다");
  const access = await tokens.authenticateAccess(`Bearer ${issued.token}`, "massion-api", []);
  const sessions = await WebSessionService.create(database, organizations, tokens, {
    keyId: "web-session-key",
    key: randomBytes(32),
    clock: {
      get now() {
        return now.value;
      },
    },
  });
  return { database, organizations, context, tokens, issued, access, sessions, now };
}

describe("Web login ticket와 session", () => {
  it("일회성 code를 HttpOnly session 재료로 교환하고 원문을 DB에 저장하지 않는다", async () => {
    const value = await fixture();
    try {
      const ticket = await value.sessions.issueLoginTicket(value.access, {
        commandId: "web-login-ticket-0001",
        ttlSeconds: 300,
      });
      expect(ticket.code).toMatch(/^mwt_/u);
      if (!ticket.code) throw new Error("login ticket 원문이 없습니다");
      const exchanged = await value.sessions.exchangeLoginTicket(ticket.code);
      expect(exchanged.sessionToken).toMatch(/^mws_/u);
      expect(exchanged.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(exchanged).toMatchObject({ context: value.context, scopes: ["application:*"] });
      await expect(value.sessions.exchangeLoginTicket(ticket.code)).rejects.toThrow(/사용|일회/u);
      const authenticated = await value.sessions.authenticate(exchanged.sessionToken, "massion-api", []);
      expect(authenticated).toMatchObject({ context: value.context, sessionId: exchanged.sessionId });
      expect(await value.sessions.verifyCsrf(exchanged.sessionToken, exchanged.csrfToken)).toBe(true);
      expect(await value.sessions.verifyCsrf(exchanged.sessionToken, "x".repeat(43))).toBe(false);
      const raw = JSON.stringify(
        await value.database.query(
          "SELECT * FROM application_web_login_ticket; SELECT * FROM application_web_session;",
        ),
      );
      expect(raw).not.toContain(ticket.code);
      expect(raw).not.toContain(exchanged.sessionToken);
      expect(raw).not.toContain(exchanged.csrfToken);
    } finally {
      await value.database.close();
    }
  });

  it("현재 사용자의 session 목록을 원문 secret 없이 조회한다", async () => {
    const value = await fixture();
    try {
      const ticket = await value.sessions.issueLoginTicket(value.access, {
        commandId: "web-login-ticket-list-0001",
      });
      if (!ticket.code) throw new Error("login ticket 원문이 없습니다");
      const exchanged = await value.sessions.exchangeLoginTicket(ticket.code);

      await expect(value.sessions.list(value.context)).resolves.toEqual([
        expect.objectContaining({
          sessionId: exchanged.sessionId,
          status: "active",
          issuedAt: exchanged.issuedAt,
          expiresAt: exchanged.expiresAt,
        }),
      ]);
      const serialized = JSON.stringify(await value.sessions.list(value.context));
      expect(serialized).not.toContain(exchanged.sessionToken);
      expect(serialized).not.toContain(exchanged.csrfToken);
    } finally {
      await value.database.close();
    }
  });

  it("session ID와 revision 조건으로 다른 session을 폐기한다", async () => {
    const value = await fixture();
    try {
      const ticket = await value.sessions.issueLoginTicket(value.access, {
        commandId: "web-login-ticket-revoke-0001",
      });
      if (!ticket.code) throw new Error("login ticket 원문이 없습니다");
      const exchanged = await value.sessions.exchangeLoginTicket(ticket.code);

      await expect(value.sessions.revokeById(value.context, exchanged.sessionId, 1, "access-console")).rejects.toThrow(
        /revision/u,
      );
      await expect(
        value.sessions.revokeById(value.context, exchanged.sessionId, 0, "access-console"),
      ).resolves.toMatchObject({ sessionId: exchanged.sessionId, status: "revoked", revision: 1 });
      await expect(value.sessions.authenticate(exchanged.sessionToken, "massion-api", [])).rejects.toThrow(/폐기/u);
    } finally {
      await value.database.close();
    }
  });

  it("ticket expiry와 session idle·absolute expiry를 fail-closed 처리한다", async () => {
    const value = await fixture();
    try {
      const ticket = await value.sessions.issueLoginTicket(value.access, {
        commandId: "web-login-ticket-0002",
        ttlSeconds: 60,
      });
      if (!ticket.code) throw new Error("login ticket 원문이 없습니다");
      value.now.value = new Date("2026-07-11T10:01:01.000Z");
      await expect(value.sessions.exchangeLoginTicket(ticket.code)).rejects.toThrow(/만료/u);

      value.now.value = new Date("2026-07-11T10:02:00.000Z");
      const active = await value.sessions.issueLoginTicket(value.access, {
        commandId: "web-login-ticket-0003",
        ttlSeconds: 300,
      });
      if (!active.code) throw new Error("login ticket 원문이 없습니다");
      const session = await value.sessions.exchangeLoginTicket(active.code, {
        absoluteTtlSeconds: 3_600,
        idleTtlSeconds: 60,
      });
      value.now.value = new Date("2026-07-11T10:03:01.000Z");
      await expect(value.sessions.authenticate(session.sessionToken, "massion-api", [])).rejects.toThrow(
        /idle|비활성/u,
      );
    } finally {
      await value.database.close();
    }
  });

  it("source access token이 폐기되면 연결된 web session도 즉시 거부한다", async () => {
    const value = await fixture();
    try {
      const ticket = await value.sessions.issueLoginTicket(value.access, {
        commandId: "web-login-ticket-0004",
        ttlSeconds: 300,
      });
      if (!ticket.code) throw new Error("login ticket 원문이 없습니다");
      const session = await value.sessions.exchangeLoginTicket(ticket.code);
      await value.tokens.revoke(value.context, { commandId: "web-source-revoke-0001", tokenId: value.issued.tokenId });
      await expect(value.sessions.authenticate(session.sessionToken, "massion-api", [])).rejects.toThrow(/폐기/u);
    } finally {
      await value.database.close();
    }
  });

  it("CSRF 회전과 logout은 이전 token·session replay를 거부한다", async () => {
    const value = await fixture();
    try {
      const ticket = await value.sessions.issueLoginTicket(value.access, {
        commandId: "web-login-ticket-0005",
        ttlSeconds: 300,
      });
      if (!ticket.code) throw new Error("login ticket 원문이 없습니다");
      const session = await value.sessions.exchangeLoginTicket(ticket.code);
      const rotated = await value.sessions.rotateCsrf(session.sessionToken);
      expect(rotated).not.toBe(session.csrfToken);
      expect(await value.sessions.verifyCsrf(session.sessionToken, session.csrfToken)).toBe(false);
      expect(await value.sessions.verifyCsrf(session.sessionToken, rotated)).toBe(true);
      await value.sessions.revoke(session.sessionToken, rotated, "user-logout");
      await expect(value.sessions.authenticate(session.sessionToken, "massion-api", [])).rejects.toThrow(/폐기/u);
    } finally {
      await value.database.close();
    }
  });
});
