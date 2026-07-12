import { describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@massion/identity";

import { runtimeSubscriptionLineage } from "./runtime-subscription-lineage.js";

const context: TenantContext = {
  userId: "user-12345678",
  organizationId: "organization-12345678",
  membershipId: "membership-12345678",
  role: "member",
};

function execution() {
  return {
    execution_id: "execution-12345678",
    organization_id: context.organizationId,
    actor_user_id: context.userId,
    work_id: "work-12345678",
    agent_handle: "representative",
    model_route: "orchestration-balanced",
    correlation_id: "correlation-12345678",
    input_json: '{"private":"prompt-secret"}',
    status: "succeeded" as const,
    version: 3,
    event_sequence: 8,
    created_at: new Date(0),
    updated_at: new Date(0),
  };
}

function receipt(
  sequence: number,
  type: string,
  attemptId: string,
  leaseId: string,
  accountId: string,
  extra: Readonly<Record<string, unknown>> = {},
) {
  return {
    event_id: `event-${String(sequence)}`,
    organization_id: context.organizationId,
    execution_id: "execution-12345678",
    command_id: `private-command-${String(sequence)}`,
    sequence,
    event_type: type,
    request_json: '{"secret":"do-not-return"}',
    payload_json: JSON.stringify({
      executionId: "execution-12345678",
      workId: "work-12345678",
      agentHandle: "representative",
      routeAttemptId: attemptId,
      leaseId,
      accountId,
      connectorId: `connector-${accountId}`,
      adapterId: "codex",
      quotaSnapshotId: `quota-${attemptId}`,
      ...extra,
    }),
    result_json: '{"providerOutput":"private-completion"}',
    created_at: new Date(sequence * 1_000),
  };
}

function attempt(input: {
  readonly id: string;
  readonly credentialId: string;
  readonly profileId: string;
  readonly sequence: number;
  readonly status: "failed" | "succeeded";
  readonly fallbackFrom?: string;
}) {
  return {
    attempt_id: input.id,
    organization_id: context.organizationId,
    route_id: "route-12345678",
    candidate_id: "candidate-private",
    model_profile_id: input.profileId,
    credential_id: input.credentialId,
    credential_secret_version: 7,
    command_id: "command-private",
    status: input.status,
    selection_sequence: input.sequence,
    estimated_tokens: 100,
    reserved_cost_micros: 0,
    fallback_from_attempt_id: input.fallbackFrom,
    quota_snapshot_id: `quota-${input.id}`,
    routing_policy_version: 4,
    effective_credential_policy: "adaptive",
    subscription_policy_version_id: "subscription-policy-private",
    subscription_policy_version: 2,
    explanation_json: '{"prompt":"private"}',
    failure_class: input.status === "failed" ? "quota" : undefined,
    status_code: input.status === "failed" ? 429 : undefined,
    emitted_tokens: input.status === "failed" ? 0 : 4,
    side_effects_started: false,
    actual_input_tokens: 3,
    actual_output_tokens: input.status === "failed" ? 0 : 4,
    actual_cost_micros: 0,
    fallback_allowed: input.status === "failed",
    created_at: new Date(0),
    updated_at: new Date(0),
  };
}

describe("공개 구독 실행 계보 투영", () => {
  it("실행자 전용 정본에서 attempt·lease·fallback 최소 사실만 반환하고 비밀 내부 ID를 제거한다", async () => {
    const events = [
      receipt(1, "subscription_route_session_acquired", "attempt-a", "lease-a", "account-a"),
      receipt(2, "subscription_invocation_started", "attempt-a", "lease-a", "account-a"),
      receipt(3, "subscription_terminal_observed", "attempt-a", "lease-a", "account-a", {
        outcome: "failed",
        usage: { inputTokens: 0, outputTokens: 0 },
        emittedTokens: 0,
        sideEffectsStarted: false,
        signal: { kind: "http", statusCode: 429, retryAfter: "private-header" },
        providerSessionId: "provider-session-private",
      }),
      receipt(4, "subscription_settlement_completed", "attempt-a", "lease-a", "account-a"),
      receipt(5, "subscription_route_session_acquired", "attempt-b", "lease-b", "account-b"),
      receipt(6, "subscription_invocation_started", "attempt-b", "lease-b", "account-b"),
      receipt(7, "subscription_terminal_observed", "attempt-b", "lease-b", "account-b", {
        outcome: "completed",
        usage: { inputTokens: 3, outputTokens: 4 },
        emittedTokens: 4,
        sideEffectsStarted: true,
        output: { kind: "inline", value: "private-completion" },
      }),
      receipt(8, "subscription_settlement_completed", "attempt-b", "lease-b", "account-b"),
    ];
    const first = attempt({
      id: "attempt-a",
      credentialId: "credential-private-a",
      profileId: "profile-a",
      sequence: 1,
      status: "failed",
    });
    const second = attempt({
      id: "attempt-b",
      credentialId: "credential-private-b",
      profileId: "profile-b",
      sequence: 2,
      status: "succeeded",
      fallbackFrom: "attempt-a",
    });
    const runtime = { getRecovery: vi.fn().mockResolvedValue({ execution: execution(), events }) };
    const router = {
      readAttempt: vi.fn().mockImplementation((_context, id) => Promise.resolve(id === "attempt-a" ? first : second)),
      listModels: vi.fn().mockResolvedValue([
        { model_profile_id: "profile-a", provider_id: "openai-codex", model_id: "gpt-5.6-sol" },
        { model_profile_id: "profile-b", provider_id: "minimax-token-plan", model_id: "MiniMax-M2.7" },
      ]),
    };

    const projected = await runtimeSubscriptionLineage(
      context,
      "execution-12345678",
      runtime as never,
      router as never,
    );

    expect(projected).toEqual({
      executionId: "execution-12345678",
      status: "succeeded",
      attempts: [
        expect.objectContaining({
          attemptId: "attempt-a",
          sequence: 1,
          accountId: "account-a",
          credentialRef: expect.stringMatching(/^[a-f0-9]{64}$/u),
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
          status: "failed",
          failureClass: "quota",
          statusCode: 429,
          fallbackAllowed: true,
          lease: expect.objectContaining({ leaseId: "lease-a", state: "settled" }),
          terminal: {
            outcome: "failed",
            inputTokens: 0,
            outputTokens: 0,
            emittedTokens: 0,
            sideEffectsStarted: false,
            failure: { kind: "http", statusCode: 429 },
          },
        }),
        expect.objectContaining({
          attemptId: "attempt-b",
          sequence: 2,
          accountId: "account-b",
          credentialRef: expect.stringMatching(/^[a-f0-9]{64}$/u),
          providerId: "minimax-token-plan",
          modelId: "MiniMax-M2.7",
          status: "succeeded",
          fallbackFromAttemptId: "attempt-a",
          fallbackAllowed: false,
          lease: expect.objectContaining({ leaseId: "lease-b", state: "settled" }),
        }),
      ],
    });
    expect(projected.attempts[0]?.credentialRef).not.toBe(projected.attempts[1]?.credentialRef);
    const encoded = JSON.stringify(projected);
    expect(encoded).not.toMatch(
      /credential-private|candidate-private|command-private|subscription-policy-private|private-completion|private-header|provider-session-private|prompt-secret|do-not-return/iu,
    );
    expect(router.readAttempt).toHaveBeenCalledTimes(2);
  });

  it("손상된 receipt 계보와 다른 실행자 Route Attempt 거부를 fail-closed로 전파한다", async () => {
    const malformed = receipt(1, "subscription_invocation_started", "attempt-a", "lease-a", "account-a");
    await expect(
      runtimeSubscriptionLineage(
        context,
        "execution-12345678",
        { getRecovery: vi.fn().mockResolvedValue({ execution: execution(), events: [malformed] }) } as never,
        { readAttempt: vi.fn(), listModels: vi.fn().mockResolvedValue([]) } as never,
      ),
    ).rejects.toThrow("Session 획득");

    const acquired = receipt(1, "subscription_route_session_acquired", "attempt-a", "lease-a", "account-a");
    await expect(
      runtimeSubscriptionLineage(
        context,
        "execution-12345678",
        { getRecovery: vi.fn().mockResolvedValue({ execution: execution(), events: [acquired] }) } as never,
        {
          readAttempt: vi.fn().mockRejectedValue(new Error("Route Attempt 실행자가 일치하지 않습니다")),
          listModels: vi.fn().mockResolvedValue([]),
        } as never,
      ),
    ).rejects.toThrow("실행자");
  });

  it("boolean 위조와 0번 Route Attempt 순서를 fail-closed로 거부한다", async () => {
    const events = [
      receipt(1, "subscription_route_session_acquired", "attempt-a", "lease-a", "account-a"),
      receipt(2, "subscription_invocation_started", "attempt-a", "lease-a", "account-a"),
      receipt(3, "subscription_terminal_observed", "attempt-a", "lease-a", "account-a", {
        outcome: "failed",
        usage: { inputTokens: 0, outputTokens: 0 },
        emittedTokens: 0,
        sideEffectsStarted: "false",
        signal: { kind: "timeout" },
      }),
    ];
    const routerAttempt = attempt({
      id: "attempt-a",
      credentialId: "credential-private-a",
      profileId: "profile-a",
      sequence: 1,
      status: "failed",
    });
    const models = [{ model_profile_id: "profile-a", provider_id: "openai-codex", model_id: "gpt-5.6-sol" }];

    await expect(
      runtimeSubscriptionLineage(
        context,
        "execution-12345678",
        { getRecovery: vi.fn().mockResolvedValue({ execution: execution(), events }) } as never,
        {
          readAttempt: vi.fn().mockResolvedValue(routerAttempt),
          listModels: vi.fn().mockResolvedValue(models),
        } as never,
      ),
    ).rejects.toThrow("side effect");

    await expect(
      runtimeSubscriptionLineage(
        context,
        "execution-12345678",
        {
          getRecovery: vi.fn().mockResolvedValue({
            execution: execution(),
            events: [receipt(1, "subscription_route_session_acquired", "attempt-a", "lease-a", "account-a")],
          }),
        } as never,
        {
          readAttempt: vi.fn().mockResolvedValue({ ...routerAttempt, selection_sequence: 0 }),
          listModels: vi.fn().mockResolvedValue(models),
        } as never,
      ),
    ).rejects.toThrow("순서");
  });

  it.each([
    {
      name: "호출 시작 중복",
      events: [
        receipt(1, "subscription_route_session_acquired", "attempt-a", "lease-a", "account-a"),
        receipt(2, "subscription_invocation_started", "attempt-a", "lease-a", "account-a"),
        receipt(3, "subscription_invocation_started", "attempt-a", "lease-a", "account-a"),
      ],
    },
    {
      name: "호출 시작 전 checkpoint",
      events: [
        receipt(1, "subscription_route_session_acquired", "attempt-a", "lease-a", "account-a"),
        receipt(2, "subscription_checkpoint_observed", "attempt-a", "lease-a", "account-a", {
          approvalId: "approval-a",
        }),
      ],
    },
    {
      name: "terminal 전 settlement",
      events: [
        receipt(1, "subscription_route_session_acquired", "attempt-a", "lease-a", "account-a"),
        receipt(2, "subscription_invocation_started", "attempt-a", "lease-a", "account-a"),
        receipt(3, "subscription_settlement_completed", "attempt-a", "lease-a", "account-a"),
      ],
    },
    {
      name: "settlement 중복",
      events: [
        receipt(1, "subscription_route_session_acquired", "attempt-a", "lease-a", "account-a"),
        receipt(2, "subscription_invocation_started", "attempt-a", "lease-a", "account-a"),
        receipt(3, "subscription_terminal_observed", "attempt-a", "lease-a", "account-a", {
          outcome: "completed",
          usage: { inputTokens: 1, outputTokens: 1 },
          emittedTokens: 1,
          sideEffectsStarted: false,
        }),
        receipt(4, "subscription_settlement_completed", "attempt-a", "lease-a", "account-a"),
        receipt(5, "subscription_settlement_completed", "attempt-a", "lease-a", "account-a"),
      ],
    },
    {
      name: "이전 attempt 정산 전 다음 획득",
      events: [
        receipt(1, "subscription_route_session_acquired", "attempt-a", "lease-a", "account-a"),
        receipt(2, "subscription_invocation_started", "attempt-a", "lease-a", "account-a"),
        receipt(3, "subscription_route_session_acquired", "attempt-b", "lease-b", "account-b"),
      ],
    },
  ])("$name receipt 순서를 저장소 FSM과 동일하게 거부한다", async ({ events }) => {
    await expect(
      runtimeSubscriptionLineage(
        context,
        "execution-12345678",
        { getRecovery: vi.fn().mockResolvedValue({ execution: execution(), events }) } as never,
        { readAttempt: vi.fn(), listModels: vi.fn().mockResolvedValue([]) } as never,
      ),
    ).rejects.toThrow(/허용되지 않는|순서/u);
  });
});
