import type { TenantContext } from "@massion/identity";
import { describe, expect, it, vi } from "vitest";

import { createOfficialExtensionConnectorInvoker } from "./extension-adapter.js";

describe("공식 Extension connector adapter", () => {
  it("tenant context와 고정 package identity로 Extension Gateway만 호출한다", async () => {
    const context: TenantContext = {
      userId: "user-12345678",
      organizationId: "organization-12345678",
      membershipId: "membership-12345678",
      role: "owner",
    };
    const invoke = vi.fn(async () => ({ operation: "work.create" }));
    const adapter = createOfficialExtensionConnectorInvoker({ invoke });
    await expect(adapter.invoke(context, "github", "surfaceConnectors:github", { event: "issues" })).resolves.toEqual({
      operation: "work.create",
    });
    expect(invoke).toHaveBeenCalledWith(context, {
      packageName: "@massion-ext/github",
      contribution: "surfaceConnectors:github",
      payload: { event: "issues" },
      timeoutMs: 2_000,
    });
  });
});
