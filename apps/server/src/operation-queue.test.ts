import { createDatabase } from "@massion/storage";
import { describe, expect, it } from "vitest";

import { OperationQueue } from "./operation-queue.js";

describe("OperationQueue", () => {
  it("dedupe enqueue와 동시 lease 하나만 허용하고 완료를 멱등 처리한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: "queue-lease" });
    const queue = await OperationQueue.create(database, { leaseMs: 1_000 });
    const first = await queue.enqueue({ dedupeKey: "restart:crash-1", kind: "extension-restart", payload: { id: 1 } });
    const replay = await queue.enqueue({ dedupeKey: "restart:crash-1", kind: "extension-restart", payload: { id: 1 } });
    expect(replay.actionId).toBe(first.actionId);
    const claims = await Promise.all([queue.claim("worker-a"), queue.claim("worker-b")]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claimed = claims.find(Boolean);
    if (!claimed) throw new Error("claim이 없습니다");
    if (!claimed.leaseOwner) throw new Error("claim owner가 없습니다");
    await queue.complete(claimed.actionId, claimed.leaseGeneration, claimed.leaseOwner);
    await queue.complete(claimed.actionId, claimed.leaseGeneration, claimed.leaseOwner);
    await expect(queue.get(claimed.actionId)).resolves.toMatchObject({ state: "succeeded" });
  });

  it("실패를 bounded retry 뒤 terminal failed로 전이한다", async () => {
    await using database = await createDatabase({ url: "mem://", namespace: "massion", database: "queue-retry" });
    const queue = await OperationQueue.create(database, { leaseMs: 1_000 });
    const action = await queue.enqueue({
      dedupeKey: "restart:crash-2",
      kind: "extension-restart",
      payload: {},
      maxAttempts: 2,
    });
    const first = await queue.claim("worker");
    if (!first) throw new Error("첫 claim이 없습니다");
    await queue.fail(first.actionId, first.leaseGeneration, "worker", "worker-crash", 0);
    const second = await queue.claim("worker");
    if (!second) throw new Error("두 번째 claim이 없습니다");
    await queue.fail(second.actionId, second.leaseGeneration, "worker", "worker-crash", 0);
    await expect(queue.get(action.actionId)).resolves.toMatchObject({ state: "failed", attempts: 2 });
  });
});
