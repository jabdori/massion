import { describe, expect, it, vi } from "vitest";

import { AutonomyTransitionCoordinator } from "./autonomy-transition-coordinator.js";

describe("AutonomyTransitionCoordinator", () => {
  const context = { organizationId: "org-autonomy", userId: "owner-autonomy" } as never;

  it("전체 권한 진입 시 연결된 구독 실행과 기존 승인을 정리한다", async () => {
    const autonomy = {
      get: vi.fn().mockResolvedValue({ mode: "review", revision: 1 }),
      set: vi.fn().mockResolvedValue({ mode: "full-access", revision: 2 }),
    };
    const approvals = {
      listPending: vi
        .fn()
        .mockResolvedValue([{ approval_id: "approval-transition-0001", execution_id: "execution-transition-0001" }]),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = { cancel: vi.fn().mockResolvedValue(undefined), cancelOrganization: vi.fn() };
    const coordinator = new AutonomyTransitionCoordinator(
      autonomy as never,
      approvals as never,
      { findByApproval: vi.fn(), claim: vi.fn() } as never,
      { reevaluateAwaitingApproval: vi.fn() } as never,
      runtime as never,
      { listActiveByAutonomy: vi.fn() } as never,
      { get: vi.fn(), activate: vi.fn() } as never,
    );

    await expect(coordinator.set(context, { mode: "full-access", expectedRevision: 1 })).resolves.toMatchObject({
      mode: "full-access",
      revision: 2,
      runtimePermissionStatus: "full-access",
    });
    expect(runtime.cancel).toHaveBeenCalledWith(context, "execution-transition-0001", "autonomy_changed");
    expect(approvals.cancel).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        approvalId: "approval-transition-0001",
        commandId: "autonomy:2:approval:approval-transition-0001:cancel",
      }),
    );
  });

  it("전체 권한 해제 회수가 실패하면 긴급 정지와 제한 상태를 남긴다", async () => {
    const emergency = { get: vi.fn().mockResolvedValue(undefined), activate: vi.fn().mockResolvedValue(undefined) };
    const coordinator = new AutonomyTransitionCoordinator(
      {
        get: vi.fn().mockResolvedValue({ mode: "full-access", revision: 3 }),
        set: vi.fn().mockResolvedValue({ mode: "review", revision: 4 }),
      } as never,
      { listPending: vi.fn().mockResolvedValue([]), cancel: vi.fn() } as never,
      { findByApproval: vi.fn(), claim: vi.fn() } as never,
      { reevaluateAwaitingApproval: vi.fn() } as never,
      { cancel: vi.fn(), cancelOrganization: vi.fn().mockRejectedValue(new Error("connector cancel failed")) } as never,
      { listActiveByAutonomy: vi.fn() } as never,
      emergency as never,
    );

    await expect(coordinator.set(context, { mode: "review", expectedRevision: 3 })).resolves.toMatchObject({
      mode: "review",
      runtimePermissionStatus: "limited",
      limitedReason: "connector cancel failed",
    });
    expect(emergency.activate).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ commandId: "autonomy-revoke:4" }),
    );
  });
});
