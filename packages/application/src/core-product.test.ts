import { describe, expect, it } from "vitest";

import { createCoreProductExecutors } from "./core-product.js";

describe("Core product composition", () => {
  it("Core Office의 여섯 단계를 실제 전용 adapter로 빠짐없이 조립한다", () => {
    const executors = createCoreProductExecutors({
      graph: {},
      works: {},
      runner: {},
      runtimeExecutions: {},
      strategy: {},
      briefs: {},
      assurance: {},
      assuranceBindings: {},
      assuranceChecks: {},
      records: {},
      recordDocuments: {},
      software: {},
    } as never);
    expect(Object.keys(executors)).toEqual([
      "intake",
      "context-strategy",
      "evidence",
      "delivery",
      "assurance",
      "records",
    ]);
    expect(Object.values(executors).every((executor) => typeof executor.execute === "function")).toBe(true);
  });
});
