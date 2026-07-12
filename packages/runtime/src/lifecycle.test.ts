import { describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@massion/identity";

import { DirectExecutionLifecycle } from "./lifecycle.js";

const context: TenantContext = {
  userId: "user-1",
  organizationId: "organization-1",
  membershipId: "membership-1",
  role: "owner",
};

describe("직접 Agent 실행 수명주기", () => {
  it("재시작 복구는 영속 복구 정본에 위임한다", async () => {
    const recover = vi.fn(async () => ({ executionId: "execution-1", status: "interrupted" as const }));
    const lifecycle = new DirectExecutionLifecycle({ recover });

    await expect(lifecycle.recover(context, "execution-1")).resolves.toEqual({
      executionId: "execution-1",
      status: "interrupted",
    });
    expect(recover).toHaveBeenCalledWith(context, "execution-1");
  });

  it("checkpoint가 없는 직접 실행의 중단과 재개는 지원한다고 가장하지 않는다", async () => {
    const lifecycle = new DirectExecutionLifecycle({ recover: vi.fn() });

    await expect(lifecycle.suspend(context, "execution-1")).rejects.toThrow("checkpoint 중단을 지원하지");
    await expect(lifecycle.resume(context, "execution-1", { answer: true })).rejects.toThrow(
      "checkpoint 재개를 지원하지",
    );
  });
});
