import assert from "node:assert/strict";
import { test } from "node:test";

import { PUBLIC_RELEASE_COMMANDS, releaseVerificationEnvironment } from "./verify-release.mjs";

test("개인용 release는 제품 명령만 공개한다", () => {
  assert.deepEqual(PUBLIC_RELEASE_COMMANDS, ["massion", "massion-connector"]);
});

test("release 검증은 application과 SurrealDB sidecar를 서로 다른 port로 격리한다", () => {
  const environment = releaseVerificationEnvironment({
    home: "/tmp/massion-release/home",
    prefix: "/tmp/massion-release/prefix",
    localPort: 20_123,
    environment: { PATH: "/usr/bin" },
  });

  assert.equal(environment.MASSION_LOCAL_PORT, "20123");
  assert.equal(environment.MASSION_SURREAL_PORT, "20122");
  assert.equal(environment.PATH, "/tmp/massion-release/prefix/bin:/usr/bin");
});
