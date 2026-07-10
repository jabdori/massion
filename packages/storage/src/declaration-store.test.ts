import { describe, expect, it } from "vitest";

import { createDatabase } from "./database.js";
import { DeclarationStore } from "./declaration-store.js";

describe("선언 파일 version 저장", () => {
  it("처음 적용한 선언을 revision 1로 저장한다", async () => {
    await using db = await createDatabase({ url: "mem://", namespace: "massion", database: "declaration_first" });
    const store = await DeclarationStore.create(db);

    const result = await store.apply("project-a", { agents: [{ name: "representative" }] });

    expect(result.created).toBe(true);
    expect(result.declaration.revision).toBe(1);
    expect(result.declaration.project_id).toBe("project-a");
  });

  it("key 순서만 다른 동일 선언은 새 revision을 만들지 않는다", async () => {
    await using db = await createDatabase({ url: "mem://", namespace: "massion", database: "declaration_same" });
    const store = await DeclarationStore.create(db);
    await store.apply("project-a", { policy: { mode: "review", enabled: true }, name: "A" });

    const result = await store.apply("project-a", { name: "A", policy: { enabled: true, mode: "review" } });

    expect(result.created).toBe(false);
    expect(result.declaration.revision).toBe(1);
    expect(await store.list("project-a")).toHaveLength(1);
  });

  it("변경된 선언을 다음 revision으로 append한다", async () => {
    await using db = await createDatabase({ url: "mem://", namespace: "massion", database: "declaration_changed" });
    const store = await DeclarationStore.create(db);
    await store.apply("project-a", { name: "A" });

    const result = await store.apply("project-a", { name: "B" });

    expect(result.created).toBe(true);
    expect(result.declaration.revision).toBe(2);
    expect((await store.list("project-a")).map((item) => item.revision)).toEqual([1, 2]);
  });
});
