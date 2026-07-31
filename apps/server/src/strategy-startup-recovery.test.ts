import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ContextStore,
  hashContextContent,
  StrategyGenerator,
  StrategyRecovery,
  type StrategyPlan,
} from "@massion/context-strategy";
import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";
import { WorkService } from "@massion/work";

import { StrategyStartupRecoveryService } from "./strategy-startup-recovery.js";

const PLAN: StrategyPlan = {
  objective: "종료 가능한 시작 복구",
  summary: "임대 대기를 안전하게 중단한다",
  scopeIn: ["recovery"],
  scopeOut: [],
  assumptions: [],
  unknowns: [],
  acceptanceCriteria: [
    {
      key: "criterion-safe-close",
      statement: "종료 뒤 Provider를 실행하지 않는다",
      method: "evidence",
      evidenceKinds: ["runtime-event"],
      planLevel: false,
    },
  ],
  risks: [],
  tasks: [
    {
      key: "safe-close",
      title: "시작 복구 종료",
      objective: "임대 대기를 중단한다",
      criterionKeys: ["criterion-safe-close"],
      dependencyKeys: [],
      requiredCapabilities: ["recovery"],
      recommendedAgentHandles: ["delivery-coordination"],
      parallelizable: false,
    },
  ],
  evidenceRequests: [],
};

describe("Strategy 시작 복구 서비스 종료", () => {
  let database: MassionDatabase | undefined;

  afterEach(async () => await database?.close());

  it("시작 전 close와 반복 close는 즉시 끝나고 이후 start를 거부한다", async () => {
    const listStartupRecoverable = vi.fn(async () => []);
    const recoverGeneration = vi.fn();
    const service = new StrategyStartupRecoveryService(
      { listStartupRecoverable },
      { resolveTenantContext: vi.fn() },
      { recoverGeneration },
    );

    await expect(Promise.all([service.close(), service.close()])).resolves.toEqual([undefined, undefined]);
    await expect(service.start()).rejects.toThrow("종료");
    expect(listStartupRecoverable).not.toHaveBeenCalled();
    expect(recoverGeneration).not.toHaveBeenCalled();
  });

  it("2099년 lease 대기 중 동시 close는 bounded 완료되고 이후에도 claim과 Provider를 실행하지 않는다", async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({
      email: "strategy-startup-close@example.com",
      displayName: "Strategy Startup Close",
    });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const works = await WorkService.create(database, organizations);
    const work = await works.createWork(context, {
      commandId: "strategy-startup-close-work",
      text: "종료할 시작 복구",
      surface: "test",
      organizationVersionId: "organization-v1",
    });
    const contexts = await ContextStore.create(database, organizations, works);
    const content = "종료할 시작 복구";
    const version = await contexts.create(context, {
      commandId: "strategy-startup-close-context",
      workId: work.work.work_id,
      tokenBudget: 1_000,
      objective: "Strategy 시작 복구 종료",
      scopeIn: ["recovery"],
      scopeOut: [],
      constraints: [],
      assumptions: [],
      unknowns: [],
      decisions: [],
      sources: [
        {
          kind: "request",
          sourceId: "strategy-startup-close-request",
          revision: "1",
          contentHash: hashContextContent(content),
          observedAt: "2026-07-30T00:00:00.000Z",
          classification: "internal",
          priority: 100,
          estimatedTokens: 100,
          mandatory: true,
          content,
        },
      ],
    });
    const executeStructured = vi.fn().mockResolvedValue({
      executionId: "execution-after-close",
      status: "succeeded",
      output: PLAN,
    });
    const generator = await StrategyGenerator.create(database, organizations, { executeStructured }, contexts, works);
    const strategyGenerationId = crypto.randomUUID();
    await database.query(
      "CREATE strategy_generation CONTENT { strategy_generation_id: $strategy_generation_id, organization_id: $organization_id, work_id: $work_id, context_version_id: $context_version_id, command_id: 'strategy-startup-close:generate', request_hash: $request_hash, expected_work_revision: 1, status: 'pending', execution_claim_id: 'previous-process', execution_claim_expires_at: type::datetime('2099-01-01T00:00:00.000Z'), created_by_user_id: $created_by_user_id, created_at: time::now(), updated_at: time::now() };",
      {
        strategy_generation_id: strategyGenerationId,
        organization_id: context.organizationId,
        work_id: work.work.work_id,
        context_version_id: version.contextVersionId,
        request_hash: "0".repeat(64),
        created_by_user_id: context.userId,
      },
    );
    const recovery = StrategyRecovery.create(generator, works);
    const recoverGeneration = vi.fn(recovery.recoverGeneration.bind(recovery));
    const service = new StrategyStartupRecoveryService(
      generator,
      {
        resolveTenantContext: async (userId, organizationId) =>
          await organizations.resolveTenantContext(userId, organizationId),
      },
      { recoverGeneration },
    );

    const starting = service.start();
    await vi.waitFor(() => expect(recoverGeneration).toHaveBeenCalledOnce());
    const callsBeforeClose = executeStructured.mock.calls.length;
    const completed = Promise.all([starting, service.close(), service.close()]);
    const closedWithinOneSecond = await Promise.race([completed.then(() => true), delay(1_000).then(() => false)]);

    await database.query(
      "UPDATE strategy_generation SET execution_claim_expires_at = type::datetime('2000-01-01T00:00:00.000Z') WHERE strategy_generation_id = $strategy_generation_id;",
      { strategy_generation_id: strategyGenerationId },
    );
    await completed;
    await delay(20);
    const [rows] = await database.query<[{ readonly status: string; readonly execution_claim_id?: string }[]]>(
      "SELECT status, execution_claim_id FROM strategy_generation WHERE strategy_generation_id = $strategy_generation_id;",
      { strategy_generation_id: strategyGenerationId },
    );

    expect({
      closedWithinOneSecond,
      callsBeforeClose,
      callsAfterLeaseExpiry: executeStructured.mock.calls.length,
      row: rows[0],
    }).toEqual({
      closedWithinOneSecond: true,
      callsBeforeClose: 0,
      callsAfterLeaseExpiry: 0,
      row: { status: "pending", execution_claim_id: "previous-process" },
    });
    expect(recoverGeneration).toHaveBeenCalledWith(context, strategyGenerationId, true, expect.any(AbortSignal));
    expect(recoverGeneration.mock.calls[0]?.[3]?.aborted).toBe(true);
    expect(service.ready()).toBe(false);
  });
});
