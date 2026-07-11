import { randomUUID } from "node:crypto";

import { createDatabase } from "@massion/storage";
import { describe, expect, it } from "vitest";

import { ExtensionCrashSupervisor } from "./extension-supervision.js";
import { OperationQueue } from "./operation-queue.js";

const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;

describe("operations remote contract", () => {
  remoteTest(
    "실제 SurrealDB 3.2.x에서 동시 lease·재연결·crash circuit 계보를 보존한다",
    async () => {
      const databaseName = `operations_${randomUUID().replaceAll("-", "")}`;
      const sqlUrl = (remoteUrl ?? "")
        .replace(/^ws:/u, "http:")
        .replace(/^wss:/u, "https:")
        .replace(/\/rpc$/u, "/sql");
      const provisioned = await fetch(sqlUrl, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from("root:root").toString("base64")}`,
          accept: "application/json",
          "content-type": "text/plain",
        },
        body: `DEFINE NAMESPACE IF NOT EXISTS massion; USE NS massion; DEFINE DATABASE IF NOT EXISTS ${databaseName};`,
      });
      if (!provisioned.ok) throw new Error(`SurrealDB 원격 준비 실패: ${String(provisioned.status)}`);
      const config = {
        url: remoteUrl ?? "",
        namespace: "massion",
        database: databaseName,
        authentication: { username: "root", password: "root" },
      };
      let actionId = "";
      await using database = await createDatabase(config);
      expect(await database.version()).toMatch(/^surrealdb-3\.2\./u);
      const queue = await OperationQueue.create(database, { leaseMs: 1_000 });
      actionId = (await queue.enqueue({ dedupeKey: "remote:action", kind: "extension-restart", payload: {} })).actionId;
      const claims = await Promise.all([queue.claim("remote-a"), queue.claim("remote-b")]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const supervisor = await ExtensionCrashSupervisor.create(database, queue, {
        windowMs: 60_000,
        maximumRestarts: 0,
        baseBackoffMs: 100,
        maximumBackoffMs: 1_000,
      });
      await expect(
        supervisor.recordCrash({
          crashId: "remote-crash",
          organizationId: "organization",
          installationId: "installation",
          versionId: "version-2",
          policyAllowsRollback: false,
          previousVersionHealthy: false,
          previousVersionRecalled: false,
          permissionIncrease: false,
        }),
      ).resolves.toMatchObject({ circuit: "open", action: "review" });
      await database.close();

      await using reconnected = await createDatabase(config);
      const recovered = await OperationQueue.create(reconnected, { leaseMs: 1_000 });
      await expect(recovered.get(actionId)).resolves.toMatchObject({ state: "leased", attempts: 1 });
    },
    30_000,
  );
});
