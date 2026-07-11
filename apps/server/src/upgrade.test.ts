import { describe, expect, it, vi } from "vitest";

import { UpgradeFailure, performUpgrade } from "./upgrade.js";

describe("performUpgrade", () => {
  it("preflight→backup→migrate→readiness 순서와 성공 영수증을 고정한다", async () => {
    const calls: string[] = [];
    const receipt = await performUpgrade({
      fromVersion: "0.9.0",
      toVersion: "1.0.0",
      preflight: async () => {
        calls.push("preflight");
      },
      backup: async () => {
        calls.push("backup");
        return { path: "/backup.json", checksum: "a".repeat(64) };
      },
      migrate: async () => {
        calls.push("migrate");
        return ["0021-operations"];
      },
      readiness: async () => {
        calls.push("readiness");
        return true;
      },
      rollback: async () => {
        calls.push("rollback");
      },
    });
    expect(calls).toEqual(["preflight", "backup", "migrate", "readiness"]);
    expect(receipt).toMatchObject({
      outcome: "succeeded",
      backupPath: "/backup.json",
      migrations: ["0021-operations"],
    });
  });

  it("readiness 실패 시 rollback을 호출하고 실패 단계가 있는 영수증을 보존한다", async () => {
    const rollback = vi.fn(async () => undefined);
    const operation = performUpgrade({
      fromVersion: "0.9.0",
      toVersion: "1.0.0",
      preflight: async () => undefined,
      backup: async () => ({ path: "/backup.json", checksum: "b".repeat(64) }),
      migrate: async () => ["0021-operations"],
      readiness: async () => false,
      rollback,
    });
    const error = await operation.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UpgradeFailure);
    expect((error as UpgradeFailure).receipt).toMatchObject({ outcome: "failed", failedStage: "readiness" });
    expect(rollback).toHaveBeenCalledOnce();
  });
});
