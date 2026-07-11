import { randomUUID } from "node:crypto";

import { createDatabase } from "@massion/storage";
import { describe, expect, it } from "vitest";

import { provisionRemoteDatabase } from "./product.js";

const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;

describe("database provisioning remote contract", () => {
  remoteTest(
    "실제 SurrealDB 3.2.x에서 runtime password를 회전하고 IAM 변경을 거부한다",
    async () => {
      const suffix = randomUUID().replaceAll("-", "");
      const database = `provision_${suffix}`;
      const username = `runtime_${suffix}`;
      const firstPassword = 'first-password"; REMOVE DATABASE massion; --';
      const secondPassword = "second-runtime-password";
      const base = {
        url: remoteUrl ?? "",
        namespace: "massion",
        database,
        owner: { username: "root", password: "root" },
        runtime: { username, password: firstPassword },
      };

      await provisionRemoteDatabase(base);
      await using first = await createDatabase({
        url: remoteUrl ?? "",
        namespace: "massion",
        database,
        authentication: { username, password: firstPassword, scope: "database" },
      });
      await expect(first.query("RETURN 1;")).resolves.toBeDefined();
      await expect(
        first.query('DEFINE USER forbidden ON DATABASE PASSWORD "forbidden-password" ROLES VIEWER;'),
      ).rejects.toThrow();
      await first.close();

      await provisionRemoteDatabase({ ...base, runtime: { username, password: secondPassword } });
      await expect(
        createDatabase({
          url: remoteUrl ?? "",
          namespace: "massion",
          database,
          authentication: { username, password: firstPassword, scope: "database" },
        }),
      ).rejects.toThrow();
      await using rotated = await createDatabase({
        url: remoteUrl ?? "",
        namespace: "massion",
        database,
        authentication: { username, password: secondPassword, scope: "database" },
      });
      await expect(rotated.query("RETURN 1;")).resolves.toBeDefined();
    },
    30_000,
  );
});
