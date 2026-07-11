import { describe, expect, it } from "vitest";

import { createDatabase } from "./database.js";

const remoteUrl = process.env.SURREAL_TEST_URL;
const remoteTest = remoteUrl ? it : it.skip;

async function provision(database: string): Promise<void> {
  const sqlUrl = (remoteUrl ?? "")
    .replace(/^ws:/u, "http:")
    .replace(/^wss:/u, "https:")
    .replace(/\/rpc$/u, "/sql");
  const response = await fetch(sqlUrl, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from("root:root").toString("base64")}`,
      accept: "application/json",
      "content-type": "text/plain",
    },
    body: `DEFINE NAMESPACE IF NOT EXISTS massion; USE NS massion; DEFINE DATABASE IF NOT EXISTS ${database};`,
  });
  const results = (await response.json()) as readonly { readonly status?: unknown }[];
  if (!response.ok || results.length !== 3 || results.some((result) => result.status !== "OK"))
    throw new Error("SurrealDB 원격 계약 database 준비가 실패했습니다");
}

describe("remote SurrealDB contract", () => {
  remoteTest("인증된 원격 server에서 query와 transaction을 실행한다", async () => {
    await provision("contract");
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
