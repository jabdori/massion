import { IdentityService, OrganizationService, type TenantContext } from "@massion/identity";
import { createDatabase } from "@massion/storage";
import { describe, expect, it, vi } from "vitest";

import { registerApplicationApprovalCommands } from "./approval-commands.js";
import type { ApplicationCommandDescriptor } from "./command-registry.js";
import { ApplicationCommandRegistry } from "./command-registry.js";
import { ApplicationCommandStore } from "./command-store.js";

const context: TenantContext = {
  userId: "approval-command-user",
  organizationId: "approval-command-org",
  membershipId: "approval-command-member",
  role: "owner",
};

const command = {
  schemaVersion: "massion.application.v1" as const,
  commandId: "approval-decide-command-0001",
  correlationId: "approval-decide-correlation-0001",
  operation: "approval.decide",
  payload: {},
};

const validPayload = {
  approvalId: "approval-decide-0001",
  expectedApprovalRevision: 7,
  vote: "approve" as const,
  reason: "검토를 완료했습니다",
};

function registration(dependencies: Parameters<typeof registerApplicationApprovalCommands>[1]) {
  const descriptors = new Map<string, ApplicationCommandDescriptor>();
  registerApplicationApprovalCommands(
    {
      register: (descriptor: ApplicationCommandDescriptor) => descriptors.set(descriptor.operation, descriptor),
    } as never,
    dependencies,
  );
  const descriptor = descriptors.get("approval.decide");
  if (!descriptor) throw new Error("approval.decide descriptor가 없습니다");
  return descriptor;
}

function run(
  approvalId = validPayload.approvalId,
  status: "ready" | "awaiting-approval" | "running" | "completed" = "awaiting-approval",
) {
  return {
    runId: "approval-run-0001",
    organizationId: context.organizationId,
    commandId: "approval-run-start-command-0001",
    correlationId: "approval-run-start-correlation-0001",
    request: {},
    stage: status === "completed" ? ("terminal" as const) : ("delivery" as const),
    status,
    ...(status === "ready" ? { resumeInput: { approvalId } } : approvalId === "" ? {} : { approvalId }),
    leaseGeneration: status === "awaiting-approval" ? 1 : 2,
  };
}

function scheduler() {
  const scheduled: Array<() => Promise<void>> = [];
  return {
    scheduled,
    schedule(_context: TenantContext, continuation: () => Promise<void>) {
      scheduled.push(continuation);
    },
  };
}

describe("Application approval commands", () => {
  it("payload의 정확한 네 필드와 타입·길이를 강제한다", () => {
    const descriptor = registration({ approvals: { vote: vi.fn() } } as never);

    expect(descriptor.validate(validPayload)).toEqual(validPayload);
    expect(() => descriptor.validate({ ...validPayload, extra: true })).toThrow("알 수 없는 필드");
    for (const field of Object.keys(validPayload)) {
      // computed key 삭제 대신 해당 필드만 제외한 객체를 새로 만듭니다.
      const missing = Object.fromEntries(Object.entries(validPayload).filter(([key]) => key !== field));
      expect(() => descriptor.validate(missing)).toThrow("정확히 네 필드");
    }
    expect(() => descriptor.validate({ ...validPayload, approvalId: "short" })).toThrow("approvalId");
    expect(() => descriptor.validate({ ...validPayload, approvalId: "a".repeat(129) })).toThrow("approvalId");
    expect(() => descriptor.validate({ ...validPayload, expectedApprovalRevision: 0 })).toThrow(
      "expectedApprovalRevision",
    );
    expect(() => descriptor.validate({ ...validPayload, expectedApprovalRevision: 1.5 })).toThrow(
      "expectedApprovalRevision",
    );
    expect(() => descriptor.validate({ ...validPayload, vote: "later" })).toThrow("vote");
    expect(() => descriptor.validate({ ...validPayload, reason: " " })).toThrow("reason");
    expect(() => descriptor.validate({ ...validPayload, reason: "검토\0완료" })).toThrow("reason");
    expect(() => descriptor.validate({ ...validPayload, reason: "가".repeat(1_366) })).toThrow("reason");
  });

  it("vote 뒤 ApplicationRun 재개 입력을 영속한 다음 background 복구를 예약하고 succeeded를 반환한다", async () => {
    let releasePrepare: () => void = () => undefined;
    const prepareCompletion = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const background = scheduler();
    const vote = vi.fn().mockResolvedValue({
      approval_id: validPayload.approvalId,
      status: "approved",
      revision: 8,
    });
    const prepareApprovalResume = vi.fn().mockImplementation(async () => {
      await prepareCompletion;
      return run(validPayload.approvalId, "ready");
    });
    const recover = vi.fn().mockResolvedValue(run("", "completed"));
    const descriptor = registration({
      approvals: { vote },
      runs: {
        findByApproval: vi.fn().mockResolvedValue({
          kind: "active",
          approvalId: validPayload.approvalId,
          run: run(),
        }),
        prepareApprovalResume,
      },
      coordinator: { recover },
      schedule: background.schedule,
    } as never);

    const handled = descriptor.handle(context, command, descriptor.validate(validPayload));
    await vi.waitFor(() => expect(prepareApprovalResume).toHaveBeenCalledOnce());
    const beforePrepared = await Promise.race([
      handled.then((value) => ({ state: "settled" as const, value })),
      new Promise<{ readonly state: "pending" }>((resolve) => {
        setTimeout(() => resolve({ state: "pending" }), 100);
      }),
    ]);
    releasePrepare();
    const result = await handled;

    expect(beforePrepared).toEqual({ state: "pending" });
    expect(result).toMatchObject({ outcome: "succeeded" });
    expect(background.scheduled).toHaveLength(1);
    expect(recover).not.toHaveBeenCalled();
    await background.scheduled[0]?.();
    expect(recover).toHaveBeenCalledWith(context, "approval-run-0001");
  });

  it.each([
    ["approved", "approve"],
    ["rejected", "reject"],
  ] as const)("%s 결정은 연결된 ApplicationRun의 재개 입력을 먼저 영속한다", async (status, voteValue) => {
    const background = scheduler();
    const vote = vi.fn().mockResolvedValue({
      approval_id: validPayload.approvalId,
      status,
      revision: 8,
    });
    const findByApproval = vi.fn().mockResolvedValue({
      kind: "active",
      approvalId: validPayload.approvalId,
      run: run(),
    });
    const prepareApprovalResume = vi.fn().mockResolvedValue(run(validPayload.approvalId, "ready"));
    const recover = vi.fn().mockResolvedValue(run("", "completed"));
    const runtimeResume = vi.fn();
    const descriptor = registration({
      approvals: { vote },
      runs: { findByApproval, prepareApprovalResume },
      coordinator: { recover },
      runtime: { resume: runtimeResume },
      schedule: background.schedule,
    } as never);
    const input = { ...validPayload, vote: voteValue, reason: `${status} 사유` };

    await expect(descriptor.handle(context, command, descriptor.validate(input))).resolves.toMatchObject({
      outcome: "succeeded",
      resource: { type: "Approval", id: validPayload.approvalId, revision: 8 },
      data: { approvalId: validPayload.approvalId, status, revision: 8 },
    });
    expect(vote).toHaveBeenCalledWith(context, {
      commandId: command.commandId,
      approvalId: validPayload.approvalId,
      expectedRevision: 7,
      vote: voteValue,
      reason: `${status} 사유`,
    });
    expect(background.scheduled).toHaveLength(1);
    expect(findByApproval).toHaveBeenCalledWith(context, validPayload.approvalId);
    expect(prepareApprovalResume).toHaveBeenCalledWith(context, "approval-run-0001", validPayload.approvalId);
    expect(recover).not.toHaveBeenCalled();
    await background.scheduled[0]?.();
    expect(recover).toHaveBeenCalledWith(context, "approval-run-0001");
    expect(runtimeResume).not.toHaveBeenCalled();
  });

  it("runtime-subscription은 성공 응답 전에 execution ID로 Runtime 재개를 완료한다", async () => {
    const background = scheduler();
    let releaseResume: () => void = () => undefined;
    const runtimeResume = vi.fn().mockImplementation(
      async () =>
        await new Promise<{ executionId: string; status: string }>((resolve) => {
          releaseResume = () => resolve({ executionId: "execution-review-0001", status: "succeeded" });
        }),
    );
    const findByApproval = vi.fn();
    const recover = vi.fn();
    const descriptor = registration({
      approvals: {
        vote: vi.fn().mockResolvedValue({
          approval_id: validPayload.approvalId,
          execution_id: "execution-review-0001",
          resume_target: "runtime-subscription",
          status: "rejected",
          revision: 8,
        }),
      },
      runs: { findByApproval, prepareApprovalResume: vi.fn() },
      coordinator: { recover },
      runtime: { resume: runtimeResume },
      schedule: background.schedule,
    } as never);

    const handled = descriptor.handle(context, command, descriptor.validate({ ...validPayload, vote: "reject" }));
    await vi.waitFor(() => expect(runtimeResume).toHaveBeenCalledOnce());
    const beforeResume = await Promise.race([
      handled.then(() => "settled" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 100)),
    ]);
    releaseResume();
    await handled;

    expect(beforeResume).toBe("pending");
    expect(background.scheduled).toHaveLength(0);
    expect(runtimeResume).toHaveBeenCalledWith(context, "execution-review-0001", {
      approvalId: validPayload.approvalId,
    });
    expect(findByApproval).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });

  it("stale revision은 vote 단계에서 끝내고 어떤 재개도 호출하지 않는다", async () => {
    const findByApproval = vi.fn();
    const recover = vi.fn();
    const runtimeResume = vi.fn();
    const schedule = vi.fn();
    const descriptor = registration({
      approvals: { vote: vi.fn().mockRejectedValue(new Error("Approval revision 충돌입니다")) },
      runs: { findByApproval, prepareApprovalResume: vi.fn() },
      coordinator: { recover },
      runtime: { resume: runtimeResume },
      schedule,
    } as never);

    await expect(descriptor.handle(context, command, descriptor.validate(validPayload))).rejects.toThrow(
      "revision 충돌",
    );
    expect(findByApproval).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(runtimeResume).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("vote 결과의 Approval ID가 요청과 다르면 연결 조회 전에 실패 폐쇄한다", async () => {
    const findByApproval = vi.fn();
    const recover = vi.fn();
    const schedule = vi.fn();
    const descriptor = registration({
      approvals: {
        vote: vi.fn().mockResolvedValue({
          approval_id: "approval-unexpected-0001",
          status: "approved",
          revision: 8,
        }),
      },
      runs: { findByApproval, prepareApprovalResume: vi.fn() },
      coordinator: { recover },
      schedule,
    } as never);

    await expect(descriptor.handle(context, command, descriptor.validate(validPayload))).rejects.toThrow(
      "Approval 결과",
    );
    expect(findByApproval).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "알 수 없는 재개 대상",
      voted: { resume_target: "unknown-target", execution_id: "execution-malformed-0001" },
      message: "재개 대상",
    },
    {
      name: "실행 ID 없는 runtime-subscription",
      voted: { resume_target: "runtime-subscription" },
      message: "구성되지 않았습니다",
    },
  ])("terminal Approval의 $name 계보는 실패 폐쇄한다", async ({ voted, message }) => {
    const schedule = vi.fn();
    const runtimeResume = vi.fn();
    const descriptor = registration({
      approvals: {
        vote: vi.fn().mockResolvedValue({
          approval_id: validPayload.approvalId,
          status: "approved",
          revision: 8,
          ...voted,
        }),
      },
      runs: { findByApproval: vi.fn(), prepareApprovalResume: vi.fn() },
      coordinator: { recover: vi.fn() },
      runtime: { resume: runtimeResume },
      schedule,
    } as never);

    await expect(descriptor.handle(context, command, descriptor.validate(validPayload))).rejects.toThrow(message);
    expect(runtimeResume).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("이미 consumed인 Approval은 실행 대상 조회와 재개를 반복하지 않는다", async () => {
    const findByApproval = vi.fn();
    const schedule = vi.fn();
    const descriptor = registration({
      approvals: {
        vote: vi.fn().mockResolvedValue({
          approval_id: validPayload.approvalId,
          status: "consumed",
          revision: 9,
        }),
      },
      runs: { findByApproval, prepareApprovalResume: vi.fn() },
      coordinator: { recover: vi.fn() },
      schedule,
    } as never);

    await expect(descriptor.handle(context, command, descriptor.validate(validPayload))).resolves.toMatchObject({
      outcome: "succeeded",
      data: { status: "consumed" },
    });
    expect(findByApproval).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("다른 tenant·다른 approval 연결은 실패 폐쇄하고 이미 재개된 같은 연결은 성공으로 복구한다", async () => {
    const background = scheduler();
    const prepareApprovalResume = vi.fn();
    const recover = vi.fn();
    const voted = {
      approval_id: validPayload.approvalId,
      status: "approved",
      revision: 8,
    };
    const findByApproval = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "active",
        approvalId: validPayload.approvalId,
        run: { ...run(), organizationId: "other-organization" },
      })
      .mockResolvedValueOnce({ kind: "active", approvalId: "another-approval-0001", run: run() })
      .mockResolvedValueOnce({
        kind: "historical",
        approvalId: validPayload.approvalId,
        run: run("", "completed"),
      });
    const descriptor = registration({
      approvals: { vote: vi.fn().mockResolvedValue(voted) },
      runs: { findByApproval, prepareApprovalResume },
      coordinator: { recover },
      schedule: background.schedule,
    } as never);
    const value = descriptor.validate(validPayload);

    await expect(descriptor.handle(context, command, value)).rejects.toThrow("조직");
    await expect(descriptor.handle(context, command, value)).rejects.toThrow("Approval 연결");
    await expect(descriptor.handle(context, command, value)).resolves.toMatchObject({ outcome: "succeeded" });
    expect(background.scheduled).toHaveLength(0);
    expect(prepareApprovalResume).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });

  it("연결되지 않은 일반 Governance approval은 ApplicationRun 없이 성공한다", async () => {
    const background = scheduler();
    const recover = vi.fn();
    const descriptor = registration({
      approvals: {
        vote: vi.fn().mockResolvedValue({
          approval_id: validPayload.approvalId,
          status: "approved",
          revision: 8,
        }),
      },
      runs: { findByApproval: vi.fn().mockResolvedValue(undefined), prepareApprovalResume: vi.fn() },
      coordinator: { recover },
      schedule: background.schedule,
    } as never);

    await expect(descriptor.handle(context, command, descriptor.validate(validPayload))).resolves.toMatchObject({
      outcome: "succeeded",
    });
    expect(background.scheduled).toHaveLength(0);
    expect(recover).not.toHaveBeenCalled();
  });

  it("성공한 ApplicationRun 결정 command replay는 vote와 background 재개를 중복 예약하지 않는다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "approval-replay@example.com", displayName: "Owner" });
    const tenant = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const vote = vi.fn().mockResolvedValue({
      approval_id: validPayload.approvalId,
      status: "approved",
      revision: 8,
    });
    const findByApproval = vi.fn().mockResolvedValue({
      kind: "active",
      approvalId: validPayload.approvalId,
      run: {
        ...run(),
        organizationId: tenant.organizationId,
      },
    });
    const prepareApprovalResume = vi.fn().mockResolvedValue({
      ...run(validPayload.approvalId, "ready"),
      organizationId: tenant.organizationId,
    });
    const recover = vi.fn().mockResolvedValue(run("", "completed"));
    const background = scheduler();
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    registerApplicationApprovalCommands(registry, {
      approvals: { vote },
      runs: { findByApproval, prepareApprovalResume },
      coordinator: { recover },
      schedule: background.schedule,
    } as never);
    const input = { ...command, payload: validPayload };

    await expect(registry.dispatch(tenant, ["approval:write"], input)).resolves.toMatchObject({ outcome: "succeeded" });
    await expect(registry.dispatch(tenant, ["approval:write"], input)).resolves.toMatchObject({ outcome: "succeeded" });

    expect(vote).toHaveBeenCalledTimes(1);
    expect(background.scheduled).toHaveLength(1);
    expect(findByApproval).toHaveBeenCalledTimes(1);
    expect(prepareApprovalResume).toHaveBeenCalledTimes(1);
    expect(recover).not.toHaveBeenCalled();
    await background.scheduled[0]?.();
    expect(recover).toHaveBeenCalledTimes(1);
    await expect(
      registry.dispatch(tenant, ["approval:write"], {
        ...input,
        payload: { ...validPayload, approvalId: "approval-different-0001" },
      }),
    ).rejects.toThrow("다른 Application command payload");
  });

  it("성공한 runtime-subscription 명령 replay는 Runtime을 중복 재개하지 않는다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identities = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identities.registerPersonalUser({ email: "runtime-replay@example.com", displayName: "Owner" });
    const tenant = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const runtimeResume = vi.fn().mockResolvedValue({ executionId: "execution-review-0001", status: "succeeded" });
    const background = scheduler();
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    registerApplicationApprovalCommands(registry, {
      approvals: {
        vote: vi.fn().mockResolvedValue({
          approval_id: validPayload.approvalId,
          execution_id: "execution-review-0001",
          resume_target: "runtime-subscription",
          status: "approved",
          revision: 8,
        }),
      },
      runs: { findByApproval: vi.fn(), prepareApprovalResume: vi.fn() },
      coordinator: { recover: vi.fn() },
      runtime: { resume: runtimeResume },
      schedule: background.schedule,
    } as never);
    const input = { ...command, commandId: "approval-runtime-replay-command-0001", payload: validPayload };

    await expect(registry.dispatch(tenant, ["approval:write"], input)).resolves.toMatchObject({ outcome: "succeeded" });
    await expect(registry.dispatch(tenant, ["approval:write"], input)).resolves.toMatchObject({ outcome: "succeeded" });
    expect(background.scheduled).toHaveLength(0);
    expect(runtimeResume).toHaveBeenCalledTimes(1);
  });
});
