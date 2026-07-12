import { describe, expect, it, vi } from "vitest";

import type { TenantContext } from "@massion/identity";

import { ServerConnectorStartupRecoveryService } from "./server-connector-startup-recovery.js";

const owner: TenantContext = {
  organizationId: "organization-12345678",
  userId: "user-12345678",
  membershipId: "membership-12345678",
  role: "owner",
};

describe("서버 Connector 시작 복구", () => {
  it("재시작 뒤 offline 서버 Connector를 소유자 문맥으로 다시 건강 증명한다", async () => {
    const query = vi.fn().mockResolvedValue([
      [
        {
          organization_id: owner.organizationId,
          owner_user_id: owner.userId,
          connector_id: "server-codex-12345678",
        },
        {
          organization_id: owner.organizationId,
          owner_user_id: owner.userId,
          connector_id: "server-claude-12345678",
        },
      ],
    ]);
    const resolveTenantContext = vi.fn().mockResolvedValue(owner);
    const attestHealth = vi.fn().mockResolvedValue({ status: "ready" });
    const transitions: unknown[] = [];
    const service = new ServerConnectorStartupRecoveryService(
      { query } as never,
      { resolveTenantContext } as never,
      { attestHealth } as never,
      {
        bootId: "boot-12345678",
        maximumConcurrency: 2,
        onTransition: (transition) => {
          transitions.push(transition);
        },
      },
    );

    await service.start();

    expect(service.ready()).toBe(true);
    expect(resolveTenantContext).toHaveBeenCalledTimes(2);
    expect(attestHealth).toHaveBeenCalledTimes(2);
    for (const call of attestHealth.mock.calls) {
      expect(call[0]).toEqual(owner);
      expect(call[1]).toMatchObject({
        commandId: expect.stringMatching(/^startup-boot-12345678-[a-f0-9]{32}$/u),
        connectorId: expect.stringMatching(/^server-/u),
      });
    }
    expect(new Set(attestHealth.mock.calls.map((call) => call[1].commandId)).size).toBe(2);
    expect(transitions).toEqual([{ attempted: 2, restored: 2, unavailable: 0 }]);
  });

  it("로그아웃·삭제된 소유자는 해당 Connector만 offline으로 보존하고 안전한 집계만 보고한다", async () => {
    const query = vi.fn().mockResolvedValue([
      [
        {
          organization_id: owner.organizationId,
          owner_user_id: owner.userId,
          connector_id: "server-ready-12345678",
        },
        {
          organization_id: "organization-private-value",
          owner_user_id: "removed-user-private-value",
          connector_id: "server-private-value",
        },
      ],
    ]);
    const resolveTenantContext = vi
      .fn()
      .mockResolvedValueOnce(owner)
      .mockRejectedValueOnce(new Error("private@example.com Bearer raw-secret"));
    const attestHealth = vi.fn().mockResolvedValueOnce({ status: "ready" });
    const errors: unknown[] = [];
    const transitions: unknown[] = [];
    const service = new ServerConnectorStartupRecoveryService(
      { query } as never,
      { resolveTenantContext } as never,
      { attestHealth } as never,
      {
        bootId: "boot-safe-12345678",
        onUnavailable: (failure) => {
          errors.push(failure);
        },
        onTransition: (transition) => {
          transitions.push(transition);
        },
      },
    );

    await service.start();

    expect(service.ready()).toBe(true);
    expect(attestHealth).toHaveBeenCalledTimes(1);
    expect(transitions).toEqual([{ attempted: 2, restored: 1, unavailable: 1 }]);
    expect(errors).toEqual([{ category: "owner-context-unavailable" }]);
    expect(JSON.stringify([errors, transitions])).not.toMatch(/private|Bearer|secret|@/u);
  });

  it("같은 복구 인스턴스의 중복 시작과 잘못된 동시성 설정을 거부한다", async () => {
    expect(
      () =>
        new ServerConnectorStartupRecoveryService({ query: vi.fn() } as never, {} as never, {} as never, {
          maximumConcurrency: 0,
        }),
    ).toThrow("동시성");

    const service = new ServerConnectorStartupRecoveryService(
      { query: vi.fn().mockResolvedValue([[]]) } as never,
      { resolveTenantContext: vi.fn() } as never,
      { attestHealth: vi.fn() } as never,
      { bootId: "boot-empty-12345678" },
    );
    await service.start();
    await expect(service.start()).rejects.toThrow("이미 시작");
    await expect(service.close()).resolves.toBeUndefined();
    expect(service.ready()).toBe(false);
  });
});
