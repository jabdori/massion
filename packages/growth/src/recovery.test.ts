import { afterEach, describe, expect, it } from "vitest";

import { IdentityService, OrganizationService } from "@massion/identity";
import { createDatabase, type MassionDatabase } from "@massion/storage";

import { classifyGrowthRecovery, GrowthRecoveryService } from "./recovery.js";

describe("Growth crash recovery classification", () => {
  let database: MassionDatabase | undefined;
  afterEach(async () => database?.close());

  it.each([
    [{ trigger: "claimed", leaseExpired: true }, "requeue-trigger"],
    [{ trigger: "claimed" }, "resume-reflection"],
    [{ reflection: "generating" }, "resume-reflection"],
    [{ evaluation: "evaluating" }, "resume-evaluation"],
    [{ adoption: "awaiting-review" }, "wait-for-approval"],
    [{ adoption: "applying", targetVersionExists: true }, "finish-adoption"],
    [{ adoption: "applying", targetVersionExists: false }, "retry-adoption"],
    [{ adoption: "observing" }, "resume-observation"],
    [{ revert: "reverting", targetVersionExists: true }, "finish-revert"],
    [{ terminal: true }, "unchanged"],
  ] as const)("%j 상태를 %s로 분류한다", (state, expected) => {
    expect(classifyGrowthRecovery(state)).toBe(expected);
  });

  it("저장 checksum이 달라지면 fail-closed blocked로 분류한다", () => {
    expect(classifyGrowthRecovery({ adoption: "applying", checksumMatches: false })).toBe("blocked");
  });

  it("run ID와 stage에서 파생한 command로 recovery를 멱등 기록한다", async () => {
    database = await createDatabase({ url: "mem://", namespace: "massion", database: crypto.randomUUID() });
    const identity = await IdentityService.create(database);
    const organizations = await OrganizationService.create(database);
    const owner = await identity.registerPersonalUser({ email: "recovery@example.com", displayName: "Recovery" });
    const context = await organizations.resolveTenantContext(owner.user.user_id, owner.organization.organization_id);
    const service = await GrowthRecoveryService.create(database, organizations);
    const input = {
      aggregateId: "adoption-1",
      stage: "adoption",
      state: { adoption: "applying", targetVersionExists: true },
    } as const;
    const first = await service.recover(context, input);
    await expect(service.recover(context, input)).resolves.toEqual(first);
    expect(first.action).toBe("finish-adoption");
  });
});
