import { randomBytes } from "node:crypto";

import { PolicyStore } from "@massion/governance";
import { IdentityService, OrganizationService } from "@massion/identity";
import { OrganizationGraphService } from "@massion/organization";
import { createDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";
import { describe, expect, it, vi } from "vitest";

import { ApplicationHttpClient } from "./http-client.js";
import { ApplicationBootstrapCapability } from "./http-server.js";
import { ApplicationProduct } from "./product.js";

const bootstrapCapability = Buffer.alloc(32, 7).toString("base64url");

function bootstrapAuthorization() {
  return new ApplicationBootstrapCapability({
    capability: Buffer.from(bootstrapCapability, "base64url"),
    expiresAt: Date.now() + 60_000,
  });
}

describe("ApplicationProduct", () => {
  it("공개 approval.decide를 실제 제품 명령 레지스트리에 조립한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const graph = await OrganizationGraphService.create(database, organizations);
    const policies = await PolicyStore.create(database, organizations);
    const owner = await identities.registerPersonalUser({
      email: "approval-decide-product@example.com",
      displayName: "Owner",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const vote = vi.fn().mockResolvedValue({
      approval_id: "approval-product-0001",
      status: "pending",
      revision: 2,
    });
    const executors = Object.fromEntries(
      (["intake", "context-strategy", "evidence", "delivery", "assurance", "records"] as const).map((stage) => [
        stage,
        { execute: async () => ({ outcome: "advanced" as const }) },
      ]),
    ) as never;
    await using product = await ApplicationProduct.create({
      database,
      identities,
      organizations,
      graph,
      policies,
      tokenKey: { keyId: "approval-decide-product-key", key: randomBytes(32) },
      executors,
      domain: { approvals: { vote, cancel: vi.fn() } as never },
      queries: { status: async () => ({ status: "ready" }) },
    });

    await expect(
      product.commands.dispatch(context, ["approval:write"], {
        schemaVersion: "massion.application.v1",
        commandId: "approval-decide-product-command-0001",
        correlationId: "approval-decide-product-correlation-0001",
        operation: "approval.decide",
        payload: {
          approvalId: "approval-product-0001",
          expectedApprovalRevision: 1,
          vote: "approve",
          reason: "검토 완료",
        },
      }),
    ).resolves.toMatchObject({
      outcome: "succeeded",
      resource: { type: "Approval", id: "approval-product-0001", revision: 2 },
    });
    expect(vote).toHaveBeenCalledWith(context, {
      commandId: "approval-decide-product-command-0001",
      approvalId: "approval-product-0001",
      expectedRevision: 1,
      vote: "approve",
      reason: "검토 완료",
    });
  });

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
      bootstrapAuthorization: bootstrapAuthorization(),
      executors,
      domain: {},
      queries: { status: async () => ({ status: "ready" }) },
    });
    const endpoint = await product.start();
    const initialized = (await ApplicationHttpClient.bootstrap(endpoint.url, {
      commandId: "product-bootstrap-command-0001",
      capability: bootstrapCapability,
    })) as {
      access: { token: string };
      context: { userId: string; organizationId: string; membershipId: string; role: "owner" };
    };
    const client = new ApplicationHttpClient({ baseUrl: endpoint.url, token: initialized.access.token });
    await expect(client.status()).resolves.toMatchObject({ data: { status: "ready" } });
    const started = (await client.command({
      schemaVersion: "massion.application.v1",
      commandId: "product-run-command-0001",
      correlationId: "product-run-correlation-0001",
      operation: "run.start",
      payload: { request: { text: "제품 경계 검증" } },
    })) as { readonly outcome: string; readonly data?: { readonly runId?: string; readonly status?: string } };
    expect(started).toMatchObject({ outcome: "accepted", data: { status: "ready", runId: expect.any(String) } });
    const runId = started.data?.runId;
    if (!runId) throw new Error("run.start가 runId를 반환하지 않았습니다");
    await product.drain();
    await expect(client.query("run.get", { runId })).resolves.toMatchObject({
      operation: "run.get",
      data: { runId, workId: "product-work-0001", status: "completed", stage: "terminal" },
    });
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

  it("run.resume은 background retry를 한 번 예약하고 같은 command를 accepted로 replay한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const graph = await OrganizationGraphService.create(database, organizations);
    const policies = await PolicyStore.create(database, organizations);
    let deliveryAttempts = 0;
    let releaseRetry: () => void = () => undefined;
    const retryCompletion = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const executors = Object.fromEntries(
      (["intake", "context-strategy", "evidence", "delivery", "assurance", "records"] as const).map((stage) => [
        stage,
        {
          async execute() {
            if (stage === "intake") return { outcome: "advanced" as const, workId: "product-resume-work-0001" };
            if (stage !== "delivery") return { outcome: "advanced" as const };
            deliveryAttempts += 1;
            if (deliveryAttempts === 1) return { outcome: "blocked" as const, reason: "delivery-retry-required" };
            await retryCompletion;
            return { outcome: "advanced" as const };
          },
        },
      ]),
    ) as never;
    await using product = await ApplicationProduct.create({
      database,
      identities,
      organizations,
      graph,
      policies,
      tokenKey: { keyId: "product-resume-key", key: randomBytes(32) },
      bootstrapAuthorization: bootstrapAuthorization(),
      executors,
      domain: {},
      queries: { status: async () => ({ status: "ready" }) },
    });
    const endpoint = await product.start();
    const initialized = (await ApplicationHttpClient.bootstrap(endpoint.url, {
      commandId: "product-resume-bootstrap-0001",
      capability: bootstrapCapability,
    })) as {
      access: { token: string };
      context: { userId: string; organizationId: string; membershipId: string; role: "owner" };
    };
    const client = new ApplicationHttpClient({ baseUrl: endpoint.url, token: initialized.access.token });
    const started = (await client.command({
      schemaVersion: "massion.application.v1",
      commandId: "product-resume-start-0001",
      correlationId: "product-resume-start-correlation-0001",
      operation: "run.start",
      payload: { request: { text: "차단 뒤 비동기 재시도" } },
    })) as { readonly data?: { readonly runId?: string } };
    const runId = started.data?.runId;
    if (!runId) throw new Error("run.start가 runId를 반환하지 않았습니다");
    await product.drain();
    await expect(client.query("run.get", { runId })).resolves.toMatchObject({
      data: { status: "blocked", stage: "delivery", blockedReason: "delivery-retry-required" },
    });

    const resumeCommand = {
      schemaVersion: "massion.application.v1",
      commandId: "product-resume-command-0001",
      correlationId: "product-resume-correlation-0001",
      operation: "run.resume",
      payload: { runId, retryBlocked: true },
    };
    const first = client.command(resumeCommand);
    await vi.waitFor(() => expect(deliveryAttempts).toBe(2));
    const firstBeforeRelease = await Promise.race([
      first.then(
        (value) => ({ state: "settled" as const, value }),
        (error: unknown) => ({ state: "rejected" as const, error }),
      ),
      new Promise<{ readonly state: "pending" }>((resolve) => {
        setTimeout(() => resolve({ state: "pending" }), 100);
      }),
    ]);
    const replayBeforeRelease = await client.command(resumeCommand).then(
      (value) => ({ state: "settled" as const, value }),
      (error: unknown) => ({ state: "rejected" as const, error }),
    );

    releaseRetry();
    const firstResult = await first;
    await product.drain();

    expect(firstBeforeRelease).toMatchObject({ state: "settled", value: { outcome: "accepted" } });
    expect(replayBeforeRelease).toMatchObject({ state: "settled", value: { outcome: "accepted" } });
    expect(firstResult).toMatchObject({ outcome: "accepted", data: { runId } });
    expect(deliveryAttempts).toBe(2);
    await expect(client.query("run.get", { runId })).resolves.toMatchObject({
      data: { status: "completed", stage: "terminal" },
    });
  });

  it("백그라운드 stage 예외도 run.blocked 이벤트로 종료한다", async () => {
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
          async execute() {
            if (stage === "intake") return { outcome: "advanced" as const, workId: "product-failed-work-0001" };
            if (stage === "delivery") throw new Error("ready 전이에는 모든 실행 Task의 Assignment가 필요합니다");
            return { outcome: "advanced" as const };
          },
        },
      ]),
    ) as never;
    await using product = await ApplicationProduct.create({
      database,
      identities,
      organizations,
      graph,
      policies,
      tokenKey: { keyId: "product-stage-failure-key", key: randomBytes(32) },
      bootstrapAuthorization: bootstrapAuthorization(),
      executors,
      domain: {},
      queries: { status: async () => ({ status: "ready" }) },
    });
    const endpoint = await product.start();
    const initialized = (await ApplicationHttpClient.bootstrap(endpoint.url, {
      commandId: "product-stage-failure-bootstrap-0001",
      capability: bootstrapCapability,
    })) as { access: { token: string } };
    const client = new ApplicationHttpClient({ baseUrl: endpoint.url, token: initialized.access.token });
    const correlationId = "product-stage-failure-correlation-0001";
    const started = (await client.command({
      schemaVersion: "massion.application.v1",
      commandId: "product-stage-failure-run-0001",
      correlationId,
      operation: "run.start",
      payload: { request: { text: "실패 종료 검증" } },
    })) as { readonly outcome: string; readonly data?: { readonly runId?: string } };
    const runId = started.data?.runId;
    if (!runId) throw new Error("run.start가 runId를 반환하지 않았습니다");

    await expect(product.drain()).resolves.toBeUndefined();
    await expect(client.query("run.get", { runId })).resolves.toMatchObject({
      data: {
        runId,
        workId: "product-failed-work-0001",
        status: "blocked",
        stage: "delivery",
        blockedReason: "delivery-stage-failed",
      },
    });
    await expect(client.events()).resolves.toMatchObject({
      events: expect.arrayContaining([expect.objectContaining({ type: "run.blocked", correlationId })]),
    });
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
      bootstrapAuthorization: bootstrapAuthorization(),
      executors,
      domain: {},
      queries: { status: async () => ({ status: "ready" }) },
    });
    const endpoint = await product.start();
    const initialized = (await ApplicationHttpClient.bootstrap(endpoint.url, {
      commandId: "web-product-bootstrap-0001",
      capability: bootstrapCapability,
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
    const session = (await exchange.json()) as {
      csrfToken: string;
      issuedAt: string;
      expiresAt: string;
      idleExpiresAt: string;
      sessionToken?: string;
    };
    expect(session.sessionToken).toBeUndefined();

    const replayed = await fetch(`${endpoint.url}/api/v1/web/sessions`, {
      method: "POST",
      headers: {
        origin: endpoint.url,
        "sec-fetch-site": "same-origin",
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ code: ticket.code }),
    });
    expect(replayed.status).toBe(401);
    await expect(replayed.json()).resolves.toMatchObject({
      category: "authentication",
      userMessage: "Web login code가 유효하지 않거나 만료됐습니다",
    });

    const recovered = await fetch(`${endpoint.url}/api/v1/web/session`, {
      headers: { cookie, origin: endpoint.url, accept: "application/json" },
    });
    expect(recovered.status).toBe(200);
    const recoveredSession = (await recovered.json()) as {
      csrfToken: string;
      issuedAt: string;
      expiresAt: string;
      idleExpiresAt: string;
    };
    expect(recoveredSession.csrfToken).not.toBe(session.csrfToken);
    expect(recoveredSession).toMatchObject({
      issuedAt: session.issuedAt,
      expiresAt: session.expiresAt,
      idleExpiresAt: expect.any(String),
    });
    expect(Date.parse(recoveredSession.idleExpiresAt)).toBeGreaterThanOrEqual(Date.parse(session.idleExpiresAt));
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

  it("실제 HTTP work.directive.submit을 영속화하고 다음 stage executor에 전달한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const graph = await OrganizationGraphService.create(database, organizations);
    const policies = await PolicyStore.create(database, organizations);
    const works = await WorkService.create(database, organizations);
    let workId = "";
    let entered!: () => void;
    let release!: () => void;
    const stageEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const stageRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const received: unknown[] = [];
    const stages = ["intake", "context-strategy", "evidence", "delivery", "assurance", "records"] as const;
    const executors = Object.fromEntries(
      stages.map((stage) => [
        stage,
        {
          async execute(
            _context: unknown,
            input: { readonly directives?: readonly { readonly directiveId: string }[] },
          ) {
            if (stage === "intake") return { outcome: "advanced" as const, workId };
            if (stage === "context-strategy") {
              entered();
              await stageRelease;
              return { outcome: "advanced" as const };
            }
            if (stage === "evidence") {
              received.push(input.directives);
              return {
                outcome: "advanced" as const,
                appliedDirectiveIds: input.directives?.map((directive) => directive.directiveId) ?? [],
              };
            }
            return { outcome: "advanced" as const };
          },
        },
      ]),
    ) as never;
    await using product = await ApplicationProduct.create({
      database,
      identities,
      organizations,
      graph,
      policies,
      tokenKey: { keyId: "product-directive-key", key: randomBytes(32) },
      bootstrapAuthorization: bootstrapAuthorization(),
      executors,
      domain: { works },
      queries: { status: async () => ({ status: "ready" }) },
    });
    const endpoint = await product.start();
    const initialized = (await ApplicationHttpClient.bootstrap(endpoint.url, {
      commandId: "product-directive-bootstrap-0001",
      capability: bootstrapCapability,
    })) as {
      access: { token: string };
      context: { userId: string; organizationId: string; membershipId: string; role: "owner" };
    };
    const work = await works.createWork(initialized.context, {
      commandId: "product-directive-work-command-0001",
      text: "실제 HTTP 지시 전달",
      surface: "desktop",
      organizationVersionId: "product-directive-org-version-0001",
    });
    workId = work.work.work_id;
    const client = new ApplicationHttpClient({ baseUrl: endpoint.url, token: initialized.access.token });
    const started = (await client.command({
      schemaVersion: "massion.application.v1",
      commandId: "product-directive-run-command-0001",
      correlationId: "product-directive-run-correlation-0001",
      operation: "run.start",
      payload: { request: { text: "기존 요청" } },
    })) as { readonly data?: { readonly runId?: string } };
    const runId = started.data?.runId;
    if (!runId) throw new Error("run.start가 runId를 반환하지 않았습니다");
    await stageEntered;

    try {
      await expect(
        client.command({
          schemaVersion: "massion.application.v1",
          commandId: "product-directive-submit-command-0001",
          correlationId: "product-directive-submit-correlation-0001",
          operation: "work.directive.submit",
          expectedRevision: work.work.revision,
          payload: {
            workId,
            runId,
            content: "최종 보고서에서 개인정보를 제외해주세요",
            mode: "now",
          },
        }),
      ).resolves.toMatchObject({
        outcome: "accepted",
        resource: { type: "WorkDirective", id: expect.any(String), revision: 0 },
        data: { workId, runId, status: "queued" },
      });
    } finally {
      release();
    }
    await product.drain();

    expect(received).toEqual([
      [
        expect.objectContaining({
          content: "최종 보고서에서 개인정보를 제외해주세요",
          mode: "now",
        }),
      ],
    ]);
    await expect(product.directives.listByRun(initialized.context, runId)).resolves.toEqual([
      expect.objectContaining({ status: "applied", workId, runId }),
    ]);
  }, 20_000);
});
