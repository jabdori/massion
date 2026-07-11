import type { TenantContext } from "@massion/identity";
import { describe, expect, it } from "vitest";

import { ExtensionBootstrap, decideExtensionBootstrap } from "./bootstrap.js";

const context: TenantContext = {
  userId: "user-1",
  organizationId: "organization-1",
  membershipId: "membership-1",
  role: "owner",
};

describe("ExtensionBootstrap", () => {
  it("compliance 뒤 recovery를 수행한 경우에만 gateway를 활성화한다", async () => {
    const order: string[] = [];
    const bootstrap = new ExtensionBootstrap(
      { assertCompliant: async () => void order.push("compliance") },
      { scan: async () => (order.push("recovery"), []) },
      { recoverActive: async () => (order.push("workers"), { recovered: 2, blocked: 0 }) },
    );
    expect(await bootstrap.start(context)).toEqual({ action: "activate", recoveryActions: 0, recoveredWorkers: 2 });
    expect(order).toEqual(["compliance", "recovery", "workers"]);
  });

  it("compliance 실패 시 recovery와 gateway activation을 수행하지 않는다", async () => {
    let recovered = false;
    const bootstrap = new ExtensionBootstrap(
      { assertCompliant: async () => Promise.reject(new Error("corrupt restore")) },
      { scan: async () => ((recovered = true), []) },
      { recoverActive: async () => ({ recovered: 0, blocked: 0 }) },
    );
    await expect(bootstrap.start(context)).rejects.toThrow("corrupt restore");
    expect(recovered).toBe(false);
    expect(() => decideExtensionBootstrap({ compliant: false })).toThrow("준수");
  });

  it("active worker를 모두 복원하지 못하면 gateway activation을 차단한다", async () => {
    const bootstrap = new ExtensionBootstrap(
      { assertCompliant: async () => undefined },
      { scan: async () => [] },
      { recoverActive: async () => ({ recovered: 1, blocked: 1 }) },
    );

    await expect(bootstrap.start(context)).rejects.toThrow("active Extension worker 복원");
  });
});
