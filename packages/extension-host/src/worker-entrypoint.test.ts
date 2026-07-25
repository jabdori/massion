import { realpathSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { resolveWorkerEntrypoint } from "./worker-entrypoint.js";

describe("Extension worker entrypoint", () => {
  it("승인된 Extension worker는 OS sandbox 없이 일반 Node process로 시작한다", () => {
    const root = realpathSync(process.cwd());
    expect(resolveWorkerEntrypoint(root, "src/worker-entrypoint.test.ts")).toBe(
      `${root}/src/worker-entrypoint.test.ts`,
    );
  });
});
