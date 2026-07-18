import assert from "node:assert/strict";
import { test } from "node:test";

import { PUBLIC_RELEASE_COMMANDS } from "./verify-release.mjs";

test("개인용 release는 제품 명령만 공개한다", () => {
  assert.deepEqual(PUBLIC_RELEASE_COMMANDS, ["massion", "massion-connector"]);
});
