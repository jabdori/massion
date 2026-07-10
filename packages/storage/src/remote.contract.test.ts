import { describe, expect, it } from "vitest";

import { createDatabase } from "./database.js";

const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;

describe("remote SurrealDB contract", () => {
  remoteTest("인증된 원격 server에서 query와 transaction을 실행한다", async () => {
    await using database = await createDatabase({
      url: remoteUrl ?? "",
      namespace: "massion",
      database: "contract",
      authentication: { username: "root", password: "root" },
    });

    expect(await database.version()).toMatch(/^surrealdb-3\./);
    await database.transaction(async (transaction) => {
      await transaction.query("DEFINE TABLE IF NOT EXISTS remote_probe SCHEMAFULL;");
    });
    const [info] = await database.query<[{ tables: Record<string, unknown> }]>("INFO FOR DB;");
    expect(info.tables).toHaveProperty("remote_probe");
  });
});
