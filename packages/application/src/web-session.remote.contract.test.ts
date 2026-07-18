import { randomBytes, randomUUID } from "node:crypto";

import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase } from "@massion/storage";
import { describe, expect, it } from "vitest";

import { ApplicationAccessTokenService } from "./auth.js";
import { WebSessionService } from "./web-session.js";

const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;

describe("Web session remote contract", () => {
  remoteTest("실제 SurrealDB 3.2.x에서 동시 session 인증과 revision session 폐기를 검증한다", async () => {
    const databaseName = `web_session_${randomUUID().replaceAll("-", "")}`;
    const sqlUrl = (remoteUrl ?? "")
      .replace(/^ws:/u, "http:")
      .replace(/^wss:/u, "https:")
      .replace(/\/rpc$/u, "/sql");
    const provisioned = await fetch(sqlUrl, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from("root:root").toString("base64")}`,
        accept: "application/json",
        "content-type": "text/plain",
      },
      body: `DEFINE NAMESPACE IF NOT EXISTS massion; USE NS massion; DEFINE DATABASE IF NOT EXISTS ${databaseName};`,
    });
    if (!provisioned.ok) throw new Error(`SurrealDB 원격 테스트 프로비저닝 실패: ${String(provisioned.status)}`);
    await using database = await createDatabase({
      url: remoteUrl ?? "",
      namespace: "massion",
      database: databaseName,
      authentication: { username: "root", password: "root" },
    });
    expect(await database.version()).toMatch(/^surrealdb-3\.2\./u);
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: `web-${randomUUID()}@example.com`,
      displayName: "Web Remote",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    expect(owner.membership.revision).toBe(0);
    const tokens = await ApplicationAccessTokenService.create(database, organizations, {
      keyId: "web-remote-token-key",
      key: randomBytes(32),
    });
    const issued = await tokens.issue(context, {
      commandId: "web-remote-source-token-0001",
      audience: "massion-api",
      scopes: ["application:*"],
      ttlSeconds: 3_600,
    });
    if (!issued.token) throw new Error("source token 원문이 없습니다");
    const access = await tokens.authenticateAccess(`Bearer ${issued.token}`, "massion-api", []);
    const sessions = await WebSessionService.create(database, organizations, tokens, {
      keyId: "web-remote-session-key",
      key: randomBytes(32),
    });
    const ticket = await sessions.issueLoginTicket(access, { commandId: "web-remote-ticket-0001" });
    if (!ticket.code) throw new Error("login ticket 원문이 없습니다");
    const exchanged = await sessions.exchangeLoginTicket(ticket.code);
    await expect(
      Promise.all(
        Array.from({ length: 5 }, async () => await sessions.authenticate(exchanged.sessionToken, "massion-api", [])),
      ),
    ).resolves.toHaveLength(5);
    await expect(sessions.list(context)).resolves.toMatchObject([
      { sessionId: exchanged.sessionId, status: "active", revision: 0 },
    ]);
    await expect(sessions.revokeById(context, exchanged.sessionId, 0, "remote-contract")).resolves.toMatchObject({
      status: "revoked",
      revision: 1,
    });
  });
});
