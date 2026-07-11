import type { TenantContext } from "@massion/identity";
import { describe, expect, it } from "vitest";

import { ApplicationRunRecovery } from "./run-recovery.js";

const context: TenantContext = {
  userId: "recovery-user",
  organizationId: "recovery-organization",
  membershipId: "recovery-membership",
  role: "owner",
};

describe("ApplicationRunRecovery", () => {
  it("recoverable run을 순서대로 재개하고 개별 blocked가 다른 run을 막지 않는다", async () => {
    const calls: string[] = [];
    const recovery = new ApplicationRunRecovery(
      {
        listRecoverable: async () => [{ runId: "run-1" }, { runId: "run-2" }],
      },
      {
        async recover(_context, runId) {
          calls.push(runId);
          if (runId === "run-2") throw new Error("blocked run");
          return { status: "completed" };
        },
      },
    );
    expect(await recovery.scan(context)).toEqual({ recovered: 1, blocked: 1 });
    expect(calls).toEqual(["run-1", "run-2"]);
  });
});
