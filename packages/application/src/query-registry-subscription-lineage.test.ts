import type { TenantContext } from "@massion/identity";
import { describe, expect, it, vi } from "vitest";

import { ApplicationQueryRegistry, registerApplicationQueries } from "./query-registry.js";

const context: TenantContext = {
  userId: "lineage-user",
  organizationId: "lineage-organization",
  membershipId: "lineage-membership",
  role: "member",
};

describe("구독 실행 계보 공개 질의", () => {
  it("실행자 정본과 Router 정본을 결합하고 runtime:read 범위를 강제한다", async () => {
    const getRecovery = vi.fn().mockResolvedValue({
      execution: {
        execution_id: "execution-lineage",
        organization_id: context.organizationId,
        actor_user_id: context.userId,
        work_id: "work-lineage",
        agent_handle: "representative",
        model_route: "orchestration-balanced",
        correlation_id: "correlation-lineage",
        input_json: '{"secret":"private-prompt"}',
        status: "running",
        version: 1,
        event_sequence: 1,
        created_at: new Date(0),
        updated_at: new Date(0),
      },
      events: [
        {
          event_id: "event-lineage",
          organization_id: context.organizationId,
          execution_id: "execution-lineage",
          command_id: "private-command",
          sequence: 1,
          event_type: "subscription_route_session_acquired",
          request_json: '{"secret":"private-request"}',
          payload_json: JSON.stringify({
            executionId: "execution-lineage",
            workId: "work-lineage",
            agentHandle: "representative",
            routeAttemptId: "attempt-lineage",
            leaseId: "lease-lineage",
            accountId: "account-lineage",
            connectorId: "connector-lineage",
            adapterId: "codex",
            quotaSnapshotId: "quota-lineage",
          }),
          result_json: '{"secret":"private-result"}',
          created_at: new Date(0),
        },
      ],
    });
    const readAttempt = vi.fn().mockResolvedValue({
      attempt_id: "attempt-lineage",
      organization_id: context.organizationId,
      route_id: "route-lineage",
      candidate_id: "private-candidate",
      model_profile_id: "profile-lineage",
      credential_id: "private-credential",
      credential_secret_version: 1,
      command_id: "private-command",
      status: "reserved",
      selection_sequence: 1,
      estimated_tokens: 1,
      reserved_cost_micros: 0,
      quota_snapshot_id: "quota-lineage",
      emitted_tokens: 0,
      side_effects_started: false,
      fallback_allowed: false,
      created_at: new Date(0),
      updated_at: new Date(0),
    });
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel: {} as never,
      runtime: { listEvents: vi.fn(), getRecovery } as never,
      router: {
        readAttempt,
        listModels: vi.fn().mockResolvedValue([
          {
            model_profile_id: "profile-lineage",
            provider_id: "openai-codex",
            model_id: "gpt-5.6-sol",
          },
        ]),
        listRoutes: vi.fn(),
        listCandidates: vi.fn(),
      } as never,
    });

    await expect(
      registry.query(context, ["runtime:read"], "runtime.execution.subscription-lineage", {
        executionId: "execution-lineage",
      }),
    ).resolves.toMatchObject({
      operation: "runtime.execution.subscription-lineage",
      data: {
        executionId: "execution-lineage",
        attempts: [
          {
            attemptId: "attempt-lineage",
            credentialRef: expect.stringMatching(/^[a-f0-9]{64}$/u),
            providerId: "openai-codex",
            modelId: "gpt-5.6-sol",
          },
        ],
      },
    });
    expect(getRecovery).toHaveBeenCalledWith(context, "execution-lineage");
    expect(readAttempt).toHaveBeenCalledWith(context, "attempt-lineage");
    await expect(
      registry.query(context, ["work:read"], "runtime.execution.subscription-lineage", {
        executionId: "execution-lineage",
      }),
    ).rejects.toMatchObject({ category: "authorization" });
  });

  it("실행 상관관계(correlation)로 현재 사용자의 여러 Runtime Execution 계보를 찾는다", async () => {
    const runtimeExecution = {
      execution_id: "execution-correlation",
      organization_id: context.organizationId,
      actor_user_id: context.userId,
      work_id: "work-correlation",
      agent_handle: "representative",
      model_route: "orchestration-balanced",
      correlation_id: "correlation-public",
      input_json: '{"private":"prompt"}',
      status: "succeeded",
      version: 1,
      event_sequence: 1,
      created_at: new Date(0),
      updated_at: new Date(0),
    };
    const listByCorrelation = vi.fn().mockResolvedValue([runtimeExecution]);
    const getRecovery = vi.fn().mockResolvedValue({ execution: runtimeExecution, events: [] });
    const registry = new ApplicationQueryRegistry();
    registerApplicationQueries(registry, {
      readModel: {} as never,
      runtime: { listEvents: vi.fn(), getRecovery, listByCorrelation } as never,
      router: {
        readAttempt: vi.fn(),
        listModels: vi.fn().mockResolvedValue([]),
        listRoutes: vi.fn(),
        listCandidates: vi.fn(),
      } as never,
    });

    await expect(
      registry.query(context, ["runtime:read"], "runtime.execution.subscription-lineage", {
        correlationId: "correlation-public",
      }),
    ).resolves.toMatchObject({
      data: {
        correlationId: "correlation-public",
        executions: [{ executionId: "execution-correlation", status: "succeeded", attempts: [] }],
      },
    });
    expect(listByCorrelation).toHaveBeenCalledWith(context, "correlation-public");
    await expect(
      registry.query(context, ["runtime:read"], "runtime.execution.subscription-lineage", {
        executionId: "execution-correlation",
        correlationId: "correlation-public",
      }),
    ).rejects.toThrow("하나만");
  });
});
