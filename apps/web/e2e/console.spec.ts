import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const session = {
  schemaVersion: "massion.web.session.v1",
  sessionId: "session-e2e",
  context: { userId: "user-e2e", organizationId: "organization-e2e", membershipId: "membership-e2e", role: "owner" },
  scopes: ["application:*"],
  csrfToken: "c".repeat(43),
  issuedAt: "2026-07-11T00:00:00.000Z",
  expiresAt: "2026-07-11T08:00:00.000Z",
  idleExpiresAt: "2026-07-11T00:30:00.000Z",
};

const snapshot = {
  schemaVersion: "massion.collaboration.snapshot.v1",
  revision: "a".repeat(64),
  nodes: [
    {
      handle: "representative",
      name: "대표 에이전트",
      responsibility: "사용자의 목표를 조직에 연결",
      capabilities: ["routing"],
      status: "active",
      role: "representative",
      executionStatus: "running",
    },
    {
      handle: "documentarian",
      name: "문서화 에이전트",
      responsibility: "결정과 근거를 추적 가능하게 기록",
      capabilities: ["documentation"],
      status: "active",
      role: "specialist",
    },
    {
      handle: "software-engineering",
      name: "소프트웨어 개발 조직",
      responsibility: "검증 가능한 제품 개발",
      capabilities: ["tdd", "delivery"],
      status: "active",
      role: "organization",
    },
  ],
  works: [{ workId: "work-e2e", status: "running", revision: 3, artifactIds: [], taskIds: ["task-e2e"], roomIds: [] }],
  tasks: [],
  assignments: [],
  executions: [
    {
      executionId: "exec-e2e",
      workId: "work-e2e",
      agentHandle: "representative",
      status: "running",
      modelRoute: "coding-balanced",
      inputTokens: 1200,
      outputTokens: 340,
      costMicros: 19000,
    },
  ],
  rooms: [],
  pendingApprovals: [],
  extensions: [],
};

async function mockProduct(page: import("@playwright/test").Page) {
  await page.route("**/api/v1/web/session", async (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session) }),
  );
  await page.route("**/api/v1/snapshot", async (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "massion.application.v1",
        operation: "organization.graph.snapshot",
        data: snapshot,
      }),
    }),
  );
  await page.route("**/api/v1/query", async (route) => {
    const request = route.request().postDataJSON() as { operation: string };
    const data: Record<string, unknown> = {
      "identity.me": session.context,
      "work.list": [{ workId: "work-e2e", status: "running", revision: 3, artifactIds: [] }],
      "governance.approval.list": [
        {
          approvalId: "approval-e2e",
          action: "extension.install",
          status: "pending",
          requestedBy: "extension-host",
          expiresAt: "2026-07-11T08:00:00.000Z",
        },
      ],
      "application.audit": {
        events: [
          {
            schemaVersion: "massion.application.event.v1",
            eventId: "event-e2e",
            organizationId: "organization-e2e",
            sequence: 7,
            type: "work.updated",
            author: { kind: "agent", id: "representative" },
            occurredAt: "2026-07-11T00:10:00.000Z",
            payload: {},
          },
        ],
        cursor: 7,
        snapshotRequired: false,
      },
      "subscription.providers": [
        {
          providerId: "openai-codex",
          displayName: "OpenAI Codex",
          authKinds: ["oauth"],
          executionKind: "agent-runtime",
          billingKinds: ["subscription"],
          modelDiscovery: "protocol",
          quotaDiscovery: "command",
          protocols: ["codex-app-server"],
          availability: "supported",
          officialDocumentation: "https://developers.openai.com/codex/auth",
          credentialPolicies: ["adaptive", "quota-headroom", "round-robin"],
          verified: true,
        },
      ],
      "subscription.accounts": [
        {
          accountId: "account-e2e",
          providerId: "openai-codex",
          alias: "개인 Codex",
          scope: "personal",
          canManage: true,
          connectorId: "connector-e2e",
          connectorLocation: "local",
          connectorExecutionKind: "agent-runtime",
          connectorStatus: "ready",
          billingKind: "subscription",
          status: "active",
          version: 4,
          token: "never-render-e2e-token",
          ownerUserId: "never-render-e2e-owner",
          profileFingerprint: "never-render-e2e-fingerprint",
          publicKey: "never-render-e2e-key",
        },
      ],
      "subscription.quota": [
        {
          accountId: "account-e2e",
          minimumRemainingRatio: 0.65,
          exhausted: false,
          observedAt: "2026-07-11T00:20:00.000Z",
          windows: [
            {
              kind: "weekly",
              remainingRatio: 0.65,
              resetsAt: "2026-07-18T00:00:00.000Z",
              observedAt: "2026-07-11T00:20:00.000Z",
              confidence: "provider-reported",
            },
          ],
        },
      ],
      "subscription.policy": [
        { providerId: "openai-codex", credentialPolicy: "adaptive", version: 2, source: "configured" },
      ],
      "subscription.doctor": [
        {
          accountId: "account-e2e",
          providerId: "openai-codex",
          alias: "개인 Codex",
          connectorId: "connector-e2e",
          connectorStatus: "ready",
          quotaStatus: "available",
          action: "none",
        },
      ],
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "massion.application.v1",
        operation: request.operation,
        data: data[request.operation] ?? [],
      }),
    });
  });
  await page.route("**/api/v1/events/stream?**", async (route) =>
    route.fulfill({ status: 200, contentType: "text/event-stream", body: ": heartbeat\n\n" }),
  );
}

test("운영 개요는 반응형 화면과 접근성 기준을 충족한다", async ({ page }, testInfo) => {
  await mockProduct(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "조직은 지금 무엇을 하고 있나요?" })).toBeVisible();
  await expect(page.getByText("ACTIVE WORK")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("overview.png"), fullPage: true });
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("조직 화면은 그래프와 동일한 접근성 명부를 제공한다", async ({ page }) => {
  await mockProduct(page);
  await page.goto("/organization");
  await expect(page.getByRole("img", { name: /Massion 에이전트 조직 관계/u })).toBeVisible();
  await expect(page.getByRole("heading", { name: "에이전트 명부" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();
});

test("구독 화면은 실제 route와 메뉴에서 계정·할당량·정책을 접근 가능하게 제공한다", async ({ page }) => {
  await mockProduct(page);
  await page.goto("/subscriptions");

  await expect(page.getByRole("heading", { name: "모델 구독을 어떻게 사용하고 있나요?" })).toBeVisible();
  await expect(page.getByRole("link", { name: "구독" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "개인 Codex" })).toBeVisible();
  await expect(page.getByText("65%", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "OpenAI Codex 계정 선택 정책" })).toHaveValue("adaptive");
  const content = await page.locator("body").innerText();
  for (const forbidden of [
    "never-render-e2e-token",
    "never-render-e2e-owner",
    "never-render-e2e-fingerprint",
    "never-render-e2e-key",
    "connector-e2e",
  ])
    expect(content).not.toContain(forbidden);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});
