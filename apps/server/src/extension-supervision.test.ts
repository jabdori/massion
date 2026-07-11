import { createDatabase } from "@massion/storage";
import { describe, expect, it } from "vitest";

import { ExtensionCrashSupervisor } from "./extension-supervision.js";
import { OperationQueue } from "./operation-queue.js";

describe("ExtensionCrashSupervisor", () => {
  it("반복 crash에 bounded backoff 뒤 circuit를 열고 안전할 때만 rollback한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: "supervision" });
    const queue = await OperationQueue.create(database, { leaseMs: 1_000 });
    const supervisor = await ExtensionCrashSupervisor.create(database, queue, {
      windowMs: 60_000,
      maximumRestarts: 2,
      baseBackoffMs: 100,
      maximumBackoffMs: 1_000,
    });
    const common = {
      organizationId: "organization-1",
      installationId: "installation-1",
      versionId: "version-2",
      previousVersionId: "version-1",
      policyAllowsRollback: true,
      previousVersionHealthy: true,
      previousVersionRecalled: false,
      permissionIncrease: false,
    };
    await expect(supervisor.recordCrash({ ...common, crashId: "crash-1" })).resolves.toMatchObject({
      circuit: "closed",
      action: "restart",
      delayMs: 100,
    });
    await expect(supervisor.recordCrash({ ...common, crashId: "crash-2" })).resolves.toMatchObject({
      circuit: "closed",
      action: "restart",
      delayMs: 200,
    });
    await expect(supervisor.recordCrash({ ...common, crashId: "crash-3" })).resolves.toMatchObject({
      circuit: "open",
      action: "rollback",
    });
    await expect(supervisor.recordCrash({ ...common, crashId: "crash-3" })).resolves.toMatchObject({
      circuit: "open",
      action: "rollback",
      replayed: true,
    });
    await supervisor.resetCircuit("organization-1", "installation-1");
    await expect(supervisor.recordCrash({ ...common, crashId: "crash-after-reset" })).resolves.toMatchObject({
      circuit: "closed",
      action: "restart",
      failureCount: 1,
    });
  });

  it("recall 또는 권한 증가가 있으면 자동 rollback 대신 사람 검토 action을 만든다", async () => {
    await using database = await createDatabase({
      url: "mem://",
      namespace: "massion",
      database: "supervision-review",
    });
    const queue = await OperationQueue.create(database);
    const supervisor = await ExtensionCrashSupervisor.create(database, queue, {
      windowMs: 60_000,
      maximumRestarts: 0,
      baseBackoffMs: 100,
      maximumBackoffMs: 1_000,
    });
    await expect(
      supervisor.recordCrash({
        crashId: "review-crash",
        organizationId: "organization-1",
        installationId: "installation-1",
        versionId: "version-2",
        previousVersionId: "version-1",
        policyAllowsRollback: true,
        previousVersionHealthy: true,
        previousVersionRecalled: true,
        permissionIncrease: false,
      }),
    ).resolves.toMatchObject({ circuit: "open", action: "review" });
  });
});
