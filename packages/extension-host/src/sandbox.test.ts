import { realpathSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { assertSandboxEligibility, nodePermissionArguments, type SandboxReceipt } from "./sandbox.js";

const receipt: SandboxReceipt = {
  backendId: "test-os-sandbox",
  backendVersion: "1.0.0",
  policyDigest: "a".repeat(64),
  processId: 1234,
  appliedAt: new Date().toISOString(),
};

describe("Extension sandbox policy", () => {
  it("built-in은 Node permission만으로 실행할 수 있다", () => {
    expect(assertSandboxEligibility("built-in", "a".repeat(64))).toBeUndefined();
  });

  it.each(["verified", "community", "untrusted-local"] as const)(
    "%s package는 실제 OS sandbox receipt가 없으면 차단한다",
    (trustLevel) => {
      expect(() => assertSandboxEligibility(trustLevel, "a".repeat(64))).toThrow("sandbox");
    },
  );

  it("backend identity·version·policy digest·process ID가 있는 receipt만 인정한다", () => {
    expect(assertSandboxEligibility("verified", "a".repeat(64), receipt)).toEqual(receipt);
    expect(() =>
      assertSandboxEligibility("verified", "a".repeat(64), { ...receipt, policyDigest: "b".repeat(64) }),
    ).toThrow("policy digest");
    expect(() => assertSandboxEligibility("verified", "a".repeat(64), { ...receipt, processId: 0 })).toThrow("process");
  });

  it("Node worker는 version directory read만 허용하고 위험 permission flag를 받지 않는다", () => {
    const root = realpathSync(process.cwd());
    const entrypoint = "src/sandbox.test.ts";
    const args = nodePermissionArguments(root, entrypoint);
    expect(args).toEqual(["--permission", `--allow-fs-read=${root}`, `${root}/${entrypoint}`]);
    expect(args.join(" ")).not.toMatch(/allow-fs-write|allow-child-process|allow-worker|allow-addons|allow-wasi/u);
  });
});
