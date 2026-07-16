import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  queryErrors: {} as Record<string, string>,
  mutate: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("../services.js", () => ({
  consoleStore: {
    mutate: testState.mutate,
    refresh: testState.refresh,
  },
}));

vi.mock("../hooks.js", () => ({
  useQueryData: (_store: unknown, operation: string) => testState.data[operation],
  useQueryError: (_store: unknown, operation: string) => testState.queryErrors[operation],
}));

import SubscriptionsPage from "./SubscriptionsPage.js";

function account(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "account-internal-1",
    providerId: "openai-codex",
    alias: "업무용 Codex",
    scope: "personal",
    canManage: true,
    connectorId: "connector-internal-1",
    connectorLocation: "server",
    connectorExecutionKind: "agent-runtime",
    connectorStatus: "ready",
    billingKind: "subscription",
    status: "active",
    version: 7,
    ownerUserId: "owner-internal-never-render",
    organizationId: "organization-internal-never-render",
    email: "private@example.com",
    token: "subscription-secret-never-render",
    profileFingerprint: "fingerprint-never-render",
    publicKey: "public-key-never-render",
    ...overrides,
  };
}

beforeEach(() => {
  testState.mutate.mockReset().mockResolvedValue({ outcome: "succeeded" });
  testState.refresh.mockReset().mockResolvedValue([]);
  testState.queryErrors = {};
  testState.data = {
    "identity.me": { role: "owner" },
    "subscription.providers": [
      {
        providerId: "openai-codex",
        displayName: "OpenAI Codex",
        authKinds: ["oauth"],
        executionKind: "agent-runtime",
        connectionSurface: "server-and-edge",
        billingKinds: ["subscription"],
        modelDiscovery: "protocol",
        quotaDiscovery: "command",
        protocols: ["codex-app-server"],
        availability: "supported",
        officialDocumentation: "https://developers.openai.com/codex/auth",
        credentialPolicies: ["adaptive", "quota-headroom", "round-robin"],
        verified: true,
        runtimeCapabilities: {
          accountIsolation: "profile-root",
          permissionBridge: "unsupported",
          maturity: "contract-tested",
          approvalModes: ["automatic", "deny"],
          approvalModesBySurface: {
            server: ["automatic", "review", "deny"],
            edge: ["automatic", "deny"],
          },
        },
        endpointAllowlist: ["secret.invalid"],
      },
    ],
    "subscription.accounts": [account()],
    "subscription.quota": [
      {
        accountId: "account-internal-1",
        windows: [{ kind: "weekly", observedAt: "2026-07-11T00:00:00.000Z", confidence: "unknown" }],
        exhausted: false,
        observedAt: "2026-07-11T00:00:00.000Z",
      },
    ],
    "subscription.policy": [
      {
        providerId: "openai-codex",
        credentialPolicy: "adaptive",
        approvalMode: "review",
        version: 3,
        source: "configured",
      },
    ],
    "subscription.doctor": [
      {
        accountId: "account-internal-1",
        providerId: "openai-codex",
        alias: "업무용 Codex",
        connectorId: "connector-internal-1",
        connectorStatus: "ready",
        quotaStatus: "unknown",
        action: "none",
      },
    ],
  };
});

afterEach(() => cleanup());

describe("SubscriptionsPage", () => {
  it("공개 필드와 실제 정책 선택지만 표시하고 민감정보와 알 수 없는 할당량을 숫자로 만들지 않는다", () => {
    const { container } = render(<SubscriptionsPage />);

    expect(screen.getByRole("heading", { name: "모델 구독을 어떻게 사용하고 있나요?" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /OpenAI Codex 공식 문서/u })).toHaveAttribute(
      "href",
      "https://developers.openai.com/codex/auth",
    );
    expect(screen.getByText("할당량 확인 불가")).toBeInTheDocument();
    expect(container.querySelector("progress")).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("0% 남음");
    expect(screen.getByText("ready")).toBeInTheDocument();
    expect(screen.getByText("server-and-edge")).toBeInTheDocument();
    expect(screen.getByText("profile-root")).toBeInTheDocument();
    expect(screen.getByText("contract-tested")).toBeInTheDocument();
    expect(screen.getByText("automatic, deny")).toBeInTheDocument();

    const selector = screen.getByRole("combobox", { name: "OpenAI Codex 계정 선택 정책" });
    expect(
      within(selector)
        .getAllByRole("option")
        .map((option) => option.getAttribute("value")),
    ).toEqual(["adaptive", "quota-headroom", "round-robin"]);
    const approvalSelector = screen.getByRole("combobox", { name: "OpenAI Codex 도구 승인 방식" });
    expect(
      within(approvalSelector)
        .getAllByRole("option")
        .map((option) => option.getAttribute("value")),
    ).toEqual(["automatic", "review", "deny"]);

    for (const forbidden of [
      "owner-internal-never-render",
      "organization-internal-never-render",
      "private@example.com",
      "subscription-secret-never-render",
      "fingerprint-never-render",
      "public-key-never-render",
      "connector-internal-1",
      "secret.invalid",
    ])
      expect(container.textContent).not.toContain(forbidden);
  });

  it("Codex Edge 계정만 연결되면 서버 전용 review 승인 방식을 선택지에서 제외한다", () => {
    testState.data["subscription.accounts"] = [account({ connectorLocation: "edge" })];
    render(<SubscriptionsPage />);

    const approvalSelector = screen.getByRole("combobox", { name: "OpenAI Codex 도구 승인 방식" });
    expect(
      within(approvalSelector)
        .getAllByRole("option")
        .map((option) => option.getAttribute("value")),
    ).toEqual(["automatic", "deny"]);
  });

  it("관리 권한이 없는 공유 계정에는 변경 동작을 제공하지 않는다", () => {
    testState.data["subscription.accounts"] = [account({ canManage: false, scope: "organization" })];
    render(<SubscriptionsPage />);

    expect(screen.queryByRole("button", { name: /공유|연결 해제/u })).not.toBeInTheDocument();
  });

  it("공식 문서가 HTTPS 주소가 아니면 클릭 가능한 링크로 만들지 않는다", () => {
    const providers = testState.data["subscription.providers"] as Array<Record<string, unknown>>;
    testState.data["subscription.providers"] = [
      { ...providers[0], officialDocumentation: "javascript:alert('never-render-secret')" },
    ];
    render(<SubscriptionsPage />);

    expect(screen.queryByRole("link", { name: /OpenAI Codex 공식 문서/u })).not.toBeInTheDocument();
  });

  it("한 query가 실패해도 나머지 화면을 유지하고 원본 오류의 secret은 표시하지 않는다", () => {
    testState.data["subscription.quota"] = undefined;
    testState.queryErrors = { "subscription.quota": "Bearer never-render-query-secret" };
    const { container } = render(<SubscriptionsPage />);

    expect(screen.getByRole("alert", { name: "" })).toHaveTextContent("할당량 조회 실패");
    expect(screen.getByRole("heading", { name: "업무용 Codex" })).toBeInTheDocument();
    expect(container.textContent).not.toContain("never-render-query-secret");
  });

  it("계정 공유는 명시적 확인 뒤 현재 version으로 전송하고 관련 조회를 갱신한다", async () => {
    const user = userEvent.setup();
    render(<SubscriptionsPage />);

    await user.click(screen.getByRole("button", { name: "조직에 공유" }));
    const dialog = screen.getByRole("dialog", { name: "계정 공유 확인" });
    const confirm = within(dialog).getByRole("button", { name: "공유 확정" });
    const cancel = within(dialog).getByRole("button", { name: "취소" });
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "계정 공유 확인" })).not.toBeInTheDocument();
    expect(testState.mutate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "조직에 공유" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "계정 공유 확인" })).getByRole("button", { name: "공유 확정" }),
    );

    expect(testState.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "subscription.account.share",
        expectedRevision: 7,
        payload: { accountId: "account-internal-1" },
      }),
    );
    expect(testState.refresh).toHaveBeenCalledWith("subscription.accounts", {});
    expect(testState.refresh).toHaveBeenCalledWith("subscription.quota", {});
    expect(testState.refresh).toHaveBeenCalledWith("subscription.doctor", {});
  });

  it("Provider가 공개한 정책만 선택해 현재 정책 version으로 적용한다", async () => {
    const user = userEvent.setup();
    render(<SubscriptionsPage />);

    await user.selectOptions(screen.getByRole("combobox", { name: "OpenAI Codex 계정 선택 정책" }), "quota-headroom");
    await user.selectOptions(screen.getByRole("combobox", { name: "OpenAI Codex 도구 승인 방식" }), "automatic");
    await user.click(screen.getByRole("button", { name: "OpenAI Codex 정책 적용" }));

    expect(testState.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "subscription.policy.configure",
        expectedRevision: 3,
        payload: {
          providerId: "openai-codex",
          credentialPolicy: "quota-headroom",
          approvalMode: "automatic",
        },
      }),
    );
  });

  it("공개 연결 표면이 unavailable인 Provider는 정책 선택과 적용을 비활성화한다", async () => {
    const providers = testState.data["subscription.providers"] as Array<Record<string, unknown>>;
    testState.data["subscription.providers"] = [
      {
        ...providers[0],
        providerId: "google-antigravity-cli",
        displayName: "Google Antigravity CLI",
        connectionSurface: "unavailable",
        availability: "experimental",
        runtimeCapabilities: {
          accountIsolation: "single-os-keyring-account",
          maturity: "experimental",
        },
      },
    ];
    testState.data["subscription.policy"] = [
      {
        providerId: "google-antigravity-cli",
        credentialPolicy: "adaptive",
        approvalMode: "deny",
        version: 1,
      },
    ];
    render(<SubscriptionsPage />);

    expect(screen.getByRole("combobox", { name: "Google Antigravity CLI 계정 선택 정책" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Google Antigravity CLI 도구 승인 방식" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Google Antigravity CLI 정책 적용" })).toBeDisabled();
    expect(screen.getByText("공개 연결 미지원")).toBeInTheDocument();
  });

  it("조직 공유 해제와 연결 해제도 각각 확인 뒤 현재 version으로 전송한다", async () => {
    const user = userEvent.setup();
    testState.data["subscription.accounts"] = [account({ scope: "organization", version: 11 })];
    render(<SubscriptionsPage />);

    await user.click(screen.getByRole("button", { name: "조직 공유 해제" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "공유 해제 확인" })).getByRole("button", {
        name: "공유 해제 확정",
      }),
    );
    await waitFor(() =>
      expect(testState.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "subscription.account.unshare",
          expectedRevision: 11,
          payload: { accountId: "account-internal-1" },
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    testState.mutate.mockClear();
    await user.click(screen.getByRole("button", { name: "연결 해제" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "연결 해제 확인" })).getByRole("button", {
        name: "연결 해제 확정",
      }),
    );
    await waitFor(() =>
      expect(testState.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "subscription.account.disconnect",
          expectedRevision: 11,
          payload: { accountId: "account-internal-1" },
        }),
      ),
    );
  });
});
