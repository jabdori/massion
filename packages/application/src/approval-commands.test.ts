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
  status: "awaiting-approval" | "running" | "completed" = "awaiting-approval",
) {
  return {
    runId: "approval-run-0001",
    organizationId: context.organizationId,
    commandId: "approval-run-start-command-0001",
    correlationId: "approval-run-start-correlation-0001",
    request: {},
    stage: status === "completed" ? ("terminal" as const) : ("delivery" as const),
    status,
    ...(approvalId === "" ? {} : { approvalId }),
    leaseGeneration: status === "awaiting-approval" ? 1 : 2,
  };
}

describe("Application approval commands", () => {
  it("payload의 정확한 네 필드와 타입·길이를 강제한다", () => {
    const descriptor = registration({ approvals: { vote: vi.fn() } } as never);

    expect(descriptor.validate(validPayload)).toEqual(validPayload);
    expect(() => descriptor.validate({ ...validPayload, extra: true })).toThrow("알 수 없는 필드");
    for (const field of Object.keys(validPayload)) {
      const missing = { ...validPayload } as Record<string, unknown>;
      delete missing[field];
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

  it.each([
    ["approved", "approve"],
    ["rejected", "reject"],
  ] as const)("%s 결정은 연결된 ApplicationRun을 같은 결정 입력으로 재개한다", async (status, voteValue) => {
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
    const resume = vi.fn().mockResolvedValue(run("", "completed"));
    const runtimeResume = vi.fn();
    const descriptor = registration({
      approvals: { vote },
      runs: { findByApproval },
      coordinator: { resume },
      runtime: { resume: runtimeResume },
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
    expect(findByApproval).toHaveBeenCalledWith(context, validPayload.approvalId);
    expect(resume).toHaveBeenCalledWith(context, "approval-run-0001", { approvalId: validPayload.approvalId });
    expect(runtimeResume).not.toHaveBeenCalled();
  });

  it("runtime-subscription은 execution ID만 Runtime으로 재개하고 ApplicationRun으로 취급하지 않는다", async () => {
    const runtimeResume = vi.fn().mockResolvedValue({ executionId: "execution-review-0001", status: "succeeded" });
    const findByApproval = vi.fn();
    const resume = vi.fn();
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
      runs: { findByApproval },
      coordinator: { resume },
      runtime: { resume: runtimeResume },
    } as never);

    await descriptor.handle(context, command, descriptor.validate({ ...validPayload, vote: "reject" }));

    expect(runtimeResume).toHaveBeenCalledWith(context, "execution-review-0001", {
      approvalId: validPayload.approvalId,
    });
    expect(findByApproval).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it("stale revision은 vote 단계에서 끝내고 어떤 재개도 호출하지 않는다", async () => {
    const findByApproval = vi.fn();
    const resume = vi.fn();
    const runtimeResume = vi.fn();
    const descriptor = registration({
      approvals: { vote: vi.fn().mockRejectedValue(new Error("Approval revision 충돌입니다")) },
      runs: { findByApproval },
      coordinator: { resume },
      runtime: { resume: runtimeResume },
    } as never);

    await expect(descriptor.handle(context, command, descriptor.validate(validPayload))).rejects.toThrow(
      "revision 충돌",
    );
    expect(findByApproval).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(runtimeResume).not.toHaveBeenCalled();
  });

  it("vote 결과의 Approval ID가 요청과 다르면 연결 조회 전에 실패 폐쇄한다", async () => {
    const findByApproval = vi.fn();
    const resume = vi.fn();
    const descriptor = registration({
      approvals: {
        vote: vi.fn().mockResolvedValue({
          approval_id: "approval-unexpected-0001",
          status: "approved",
          revision: 8,
        }),
      },
      runs: { findByApproval },
      coordinator: { resume },
    } as never);

    await expect(descriptor.handle(context, command, descriptor.validate(validPayload))).rejects.toThrow(
      "Approval 결과",
    );
    expect(findByApproval).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it("다른 tenant·다른 approval 연결은 실패 폐쇄하고 이미 재개된 같은 연결은 성공으로 복구한다", async () => {
    const resume = vi.fn();
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
        run: run("approval-next-0001"),
      });
    const descriptor = registration({
      approvals: { vote: vi.fn().mockResolvedValue(voted) },
      runs: { findByApproval },
      coordinator: { resume },
    } as never);
    const value = descriptor.validate(validPayload);

    await expect(descriptor.handle(context, command, value)).rejects.toThrow("조직");
    await expect(descriptor.handle(context, command, value)).rejects.toThrow("Approval 연결");
    await expect(descriptor.handle(context, command, value)).resolves.toMatchObject({ outcome: "succeeded" });
    expect(resume).not.toHaveBeenCalled();
  });

  it("연결되지 않은 일반 Governance approval은 ApplicationRun 없이 성공한다", async () => {
    const resume = vi.fn();
    const descriptor = registration({
      approvals: {
        vote: vi.fn().mockResolvedValue({
          approval_id: validPayload.approvalId,
          status: "approved",
          revision: 8,
        }),
      },
      runs: { findByApproval: vi.fn().mockResolvedValue(undefined) },
      coordinator: { resume },
    } as never);

    await expect(descriptor.handle(context, command, descriptor.validate(validPayload))).resolves.toMatchObject({
      outcome: "succeeded",
    });
    expect(resume).not.toHaveBeenCalled();
  });

  it("vote 후 resume 실패를 같은 commandId로 재실행하고 이미 재개된 run을 다시 실행하지 않는다", async () => {
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
    let runStatus: "awaiting-approval" | "completed" = "awaiting-approval";
    const findByApproval = vi.fn().mockImplementation(async () => ({
      kind: runStatus === "awaiting-approval" ? "active" : "historical",
      approvalId: validPayload.approvalId,
      run: {
        ...run(runStatus === "awaiting-approval" ? validPayload.approvalId : "", runStatus),
        organizationId: tenant.organizationId,
      },
    }));
    const resume = vi.fn().mockImplementation(async () => {
      runStatus = "completed";
      throw new Error("vote 뒤 command 완료 전 crash");
    });
    const registry = new ApplicationCommandRegistry(await ApplicationCommandStore.create(database, organizations));
    registerApplicationApprovalCommands(registry, {
      approvals: { vote },
      runs: { findByApproval },
      coordinator: { resume },
    } as never);
    const input = { ...command, payload: validPayload };

    await expect(registry.dispatch(tenant, ["approval:write"], input)).rejects.toMatchObject({ category: "internal" });
    await expect(registry.dispatch(tenant, ["approval:write"], input)).resolves.toMatchObject({ outcome: "succeeded" });
    await expect(registry.dispatch(tenant, ["approval:write"], input)).resolves.toMatchObject({ outcome: "succeeded" });

    expect(vote).toHaveBeenCalledTimes(2);
    expect(findByApproval).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenCalledTimes(1);
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
      runs: { findByApproval: vi.fn() },
      coordinator: { resume: vi.fn() },
      runtime: { resume: runtimeResume },
    } as never);
    const input = { ...command, commandId: "approval-runtime-replay-command-0001", payload: validPayload };

    await expect(registry.dispatch(tenant, ["approval:write"], input)).resolves.toMatchObject({ outcome: "succeeded" });
    await expect(registry.dispatch(tenant, ["approval:write"], input)).resolves.toMatchObject({ outcome: "succeeded" });
    expect(runtimeResume).toHaveBeenCalledTimes(1);
  });
});
