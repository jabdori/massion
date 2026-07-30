import { describe, expect, it } from "vitest";

import { createDatabase, serializeSurrealDateTime } from "./database.js";

describe("SurrealDB 연결", () => {
  it("embedded memory DB에 연결하고 namespace와 database를 선택한다", async () => {
    await using db = await createDatabase({ url: "mem://", namespace: "massion", database: "test" });

    expect(await db.version()).toMatch(/^surrealdb-3\./);
    expect(await db.query<number[]>("RETURN 1 + 1;")).toEqual([2]);
  });

  it("허용하지 않은 protocol을 거부한다", async () => {
    await expect(
      createDatabase({ url: "file:///tmp/massion", namespace: "massion", database: "test" }),
    ).rejects.toThrow("지원하지 않는 SurrealDB URL: file:///tmp/massion");
  });

  it("transaction 실패 시 변경을 rollback한다", async () => {
    await using db = await createDatabase({ url: "mem://", namespace: "massion", database: "test" });
    await db.query("DEFINE TABLE rollback_probe SCHEMAFULL; DEFINE FIELD payload ON rollback_probe TYPE int;");

    await expect(
      db.transaction(async (tx) => {
        await tx.query("CREATE rollback_probe:one SET payload = 1;");
        throw new Error("rollback probe");
      }),
    ).rejects.toThrow("rollback probe");

    expect(await db.query<unknown[][]>("SELECT payload FROM rollback_probe;")).toEqual([[]]);
  });

  it("동시 transaction을 서로 독립된 session에서 commit한다", async () => {
    await using db = await createDatabase({ url: "mem://", namespace: "massion", database: "concurrent_transactions" });
    await db.query("DEFINE TABLE concurrent_probe SCHEMAFULL; DEFINE FIELD payload ON concurrent_probe TYPE int;");

    await Promise.all([
      db.transaction(async (tx) => tx.query("CREATE concurrent_probe:one SET payload = 1;")),
      db.transaction(async (tx) => tx.query("CREATE concurrent_probe:two SET payload = 2;")),
    ]);

    const [records] = await db.query<[{ payload: number }[]]>(
      "SELECT payload FROM concurrent_probe ORDER BY payload ASC;",
    );
    expect(records).toEqual([{ payload: 1 }, { payload: 2 }]);
  });

  it("SDK DateTime prototype private field로 genuine datetime만 직렬화한다", async () => {
    await using db = await createDatabase({ url: "mem://", namespace: "massion", database: "datetime_guard" });
    const canonical = "2026-07-11T06:00:00.000Z";
    const [genuine] = await db.query<[unknown]>("RETURN <datetime>$value;", { value: canonical });
    let fakeCalls = 0;
    class DateTimeMimic {
      public toCompact(): readonly [bigint, bigint] {
        fakeCalls += 1;
        return [0n, 0n];
      }

      public toISOString(): string {
        fakeCalls += 1;
        return canonical;
      }
    }
    const forged = new DateTimeMimic() as DateTimeMimic & Record<symbol, unknown>;
    forged[Symbol.for("surrealdb.Value")] = true;
    forged[Symbol.for("surrealdb.DateTime")] = true;
    const prototypeMimic = Object.create(genuine as object) as Record<string, unknown>;
    prototypeMimic.toCompact = () => {
      fakeCalls += 1;
      return [0n, 0n];
    };
    prototypeMimic.toISOString = () => {
      fakeCalls += 1;
      return canonical;
    };

    expect(serializeSurrealDateTime(genuine)).toBe(canonical);
    for (const fake of [
      { toISOString: () => canonical },
      new DateTimeMimic(),
      forged,
      prototypeMimic,
      canonical,
      new Date(canonical),
    ]) {
      expect(serializeSurrealDateTime(fake)).toBeUndefined();
    }
    expect(fakeCalls).toBe(0);
  });
});
