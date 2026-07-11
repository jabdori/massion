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
    );
    expect(await bootstrap.start(context)).toEqual({ action: "activate", recoveryActions: 0 });
    expect(order).toEqual(["compliance", "recovery"]);
  });

  it("compliance 실패 시 recovery와 gateway activation을 수행하지 않는다", async () => {
    let recovered = false;
    const bootstrap = new ExtensionBootstrap(
      { assertCompliant: async () => Promise.reject(new Error("corrupt restore")) },
      { scan: async () => ((recovered = true), []) },
    );
    await expect(bootstrap.start(context)).rejects.toThrow("corrupt restore");
    expect(recovered).toBe(false);
    expect(() => decideExtensionBootstrap({ compliant: false })).toThrow("준수");
  });
});
