import { randomBytes } from "node:crypto";

import { PolicyStore } from "@massion/governance";
import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase } from "@massion/storage";
import { describe, expect, it } from "vitest";

import { ApplicationHttpClient } from "./http-client.js";
import { ApplicationProduct } from "./product.js";

describe("ApplicationProduct", () => {
  it("인증·명령·Core run·event를 하나의 실제 HTTP 제품 경계로 조립한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const graph = await OrganizationGraphService.create(database, organizations);
    const policies = await PolicyStore.create(database, organizations);
    const stages = ["intake", "context-strategy", "evidence", "delivery", "assurance", "records"] as const;
    const executors = Object.fromEntries(
      stages.map((stage) => [
        stage,
        {
          execute: async () =>
            stage === "intake"
              ? { outcome: "advanced" as const, workId: "product-work-0001" }
              : { outcome: "advanced" as const },
        },
      ]),
    ) as never;
    await using product = await ApplicationProduct.create({
      database,
      identities,
      organizations,
      graph,
      policies,
      tokenKey: { keyId: "product-test-key", key: randomBytes(32) },
      executors,
      domain: {},
      queries: { status: async () => ({ status: "ready" }) },
    });
    const endpoint = await product.start();
    const initialized = (await ApplicationHttpClient.bootstrap(endpoint.url, {
      commandId: "product-bootstrap-command-0001",
      email: "product@example.com",
      displayName: "Product",
    })) as {
      access: { token: string };
      context: { userId: string; organizationId: string; membershipId: string; role: "owner" };
    };
    const client = new ApplicationHttpClient({ baseUrl: endpoint.url, token: initialized.access.token });
    await expect(client.status()).resolves.toMatchObject({ data: { status: "ready" } });
    await expect(
      client.command({
        schemaVersion: "massion.application.v1",
        commandId: "product-run-command-0001",
        correlationId: "product-run-correlation-0001",
        operation: "run.start",
        payload: { request: { text: "제품 경계 검증" } },
      }),
    ).resolves.toMatchObject({ outcome: "accepted", data: { status: "ready" } });
    await product.drain();
    await expect(product.runs.getByCommand(initialized.context, "product-run-command-0001")).resolves.toMatchObject({
      status: "completed",
      stage: "terminal",
    });
    await expect(product.metrics.aggregate(initialized.context, "application_command_total")).resolves.toEqual([
      { dimensions: { operationClass: "run", result: "accepted" }, value: 1 },
    ]);
    await expect(product.metrics.aggregate(initialized.context, "application_run_total")).resolves.toEqual([
      { dimensions: { stage: "terminal", result: "completed" }, value: 1 },
    ]);
    await expect(client.events()).resolves.toMatchObject({ events: expect.any(Array) });
  });

  it("Bearer를 일회성 code→HttpOnly cookie로 교환하고 Web mutation에 CSRF를 강제한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const graph = await OrganizationGraphService.create(database, organizations);
    const policies = await PolicyStore.create(database, organizations);
    const executors = Object.fromEntries(
      (["intake", "context-strategy", "evidence", "delivery", "assurance", "records"] as const).map((stage) => [
        stage,
        {
          execute: async () =>
            stage === "intake"
              ? { outcome: "advanced" as const, workId: "web-session-work-0001" }
              : { outcome: "advanced" as const },
        },
      ]),
    ) as never;
    await using product = await ApplicationProduct.create({
      database,
      identities,
      organizations,
      graph,
      policies,
      tokenKey: { keyId: "web-product-key", key: randomBytes(32) },
      executors,
      domain: {},
      queries: { status: async () => ({ status: "ready" }) },
    });
    const endpoint = await product.start();
    const initialized = (await ApplicationHttpClient.bootstrap(endpoint.url, {
      commandId: "web-product-bootstrap-0001",
      email: "web-product@example.com",
      displayName: "Web Product",
    })) as {
      access: { token: string };
      context: { userId: string; organizationId: string; membershipId: string; role: "owner" };
    };
    const ticketResponse = await fetch(`${endpoint.url}/api/v1/web/login-tickets`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${initialized.access.token}`,
        origin: endpoint.url,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ commandId: "web-product-ticket-0001", ttlSeconds: 300 }),
    });
    expect(ticketResponse.status).toBe(201);
    const ticket = (await ticketResponse.json()) as { code?: string };
    expect(ticket.code).toMatch(/^mwt_/u);
    const exchange = await fetch(`${endpoint.url}/api/v1/web/sessions`, {
      method: "POST",
      headers: {
        origin: endpoint.url,
        "sec-fetch-site": "same-origin",
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ code: ticket.code }),
    });
    expect(exchange.status).toBe(201);
    const setCookie = exchange.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("massion_session=mws_");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("Secure");
    const cookie = setCookie.split(";", 1)[0] ?? "";
    const session = (await exchange.json()) as { csrfToken: string; sessionToken?: string };
    expect(session.sessionToken).toBeUndefined();

    const recovered = await fetch(`${endpoint.url}/api/v1/web/session`, {
      headers: { cookie, origin: endpoint.url, accept: "application/json" },
    });
    expect(recovered.status).toBe(200);
    const recoveredSession = (await recovered.json()) as { csrfToken: string };
    expect(recoveredSession.csrfToken).not.toBe(session.csrfToken);
    const status = await fetch(`${endpoint.url}/api/v1/status`, {
      headers: { cookie, accept: "application/json" },
    });
    expect(status.status).toBe(200);

    const command = {
      schemaVersion: "massion.application.v1",
      commandId: "web-product-run-0001",
      correlationId: "web-product-correlation-0001",
      operation: "run.start",
      payload: { request: { text: "Web session command" } },
    };
    const missingCsrf = await fetch(`${endpoint.url}/api/v1/commands`, {
      method: "POST",
      headers: {
        cookie,
        origin: endpoint.url,
        "sec-fetch-site": "same-origin",
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    });
    expect(missingCsrf.status).toBe(403);
    const accepted = await fetch(`${endpoint.url}/api/v1/commands`, {
      method: "POST",
      headers: {
        cookie,
        origin: endpoint.url,
        "sec-fetch-site": "same-origin",
        "x-massion-csrf": recoveredSession.csrfToken,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    });
    expect(accepted.status).toBe(202);

    const logout = await fetch(`${endpoint.url}/api/v1/web/session`, {
      method: "DELETE",
      headers: {
        cookie,
        origin: endpoint.url,
        "sec-fetch-site": "same-origin",
        "x-massion-csrf": recoveredSession.csrfToken,
      },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    const denied = await fetch(`${endpoint.url}/api/v1/status`, { headers: { cookie, accept: "application/json" } });
    expect(denied.status).toBe(401);
    await expect(product.metrics.aggregate(initialized.context, "application_request_total")).resolves.toEqual(
      expect.arrayContaining([
        { dimensions: { operationClass: "csrf-rotated", result: "succeeded" }, value: 1 },
        { dimensions: { operationClass: "session-issued", result: "succeeded" }, value: 1 },
        { dimensions: { operationClass: "session-revoked", result: "succeeded" }, value: 1 },
        { dimensions: { operationClass: "ticket-issued", result: "succeeded" }, value: 1 },
      ]),
    );
  });
});
