import assert from "node:assert/strict";
import { test } from "node:test";

import { percentile } from "./hardening-load.mjs";

test("nearest-rank percentile을 결정론적으로 계산한다", () => {
  assert.equal(percentile([5, 1, 4, 3, 2], 0.95), 5);
  assert.equal(percentile([10, 20, 30, 40], 0.5), 20);
  assert.throws(() => percentile([], 0.95), /비어/u);
});
