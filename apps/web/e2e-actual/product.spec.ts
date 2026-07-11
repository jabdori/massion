import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("실제 SurrealDB cookie session에서 snapshot·SSE·query를 운영한다", async ({ page, request }) => {
  const bootstrap = await request.post("/api/v1/bootstrap", {
    data: { commandId: "web-actual-bootstrap-0001", email: "actual-web@example.com", displayName: "Actual Web" },
  });
  expect(bootstrap.status()).toBe(201);
  const initialized = (await bootstrap.json()) as { access: { token: string } };
  const ticketResponse = await request.post("/api/v1/web/login-tickets", {
    headers: { authorization: `Bearer ${initialized.access.token}`, origin: "http://127.0.0.1:4174" },
    data: { commandId: "web-actual-ticket-0001", ttlSeconds: 300 },
  });
  expect(ticketResponse.status()).toBe(201);
  const ticket = (await ticketResponse.json()) as { code: string };
  for (const operation of ["identity.me", "work.list", "governance.approval.list", "application.audit"]) {
    const response = await request.post("/api/v1/query", {
      headers: { authorization: `Bearer ${initialized.access.token}` },
      data: { operation, payload: operation === "application.audit" ? { limit: 100 } : {} },
    });
    expect(response.status(), `${operation}: ${await response.text()}`).toBe(200);
  }
  const snapshotResponse = await request.get("/api/v1/snapshot", {
    headers: { authorization: `Bearer ${initialized.access.token}` },
  });
  expect(snapshotResponse.status(), await snapshotResponse.text()).toBe(200);

  await page.goto("/login");
  await page.getByLabel("일회성 로그인 코드").fill(ticket.code);
  const exchangeResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/web/sessions"));
  await page.getByRole("button", { name: "운영실 열기" }).click();
  const exchanged = await exchangeResponse;
  expect(exchanged.status(), await exchanged.text()).toBe(201);
  await expect(page.getByRole("heading", { name: "조직은 지금 무엇을 하고 있나요?" })).toBeVisible();
  await expect(page.getByText("LIVE", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: /조직/u }).click();
  await expect(page.getByRole("heading", { name: "에이전트 명부" })).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});
