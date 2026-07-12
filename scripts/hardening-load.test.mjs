import assert from "node:assert/strict";
import { test } from "node:test";

import { hardeningDaemonEnvironment, percentile } from "./hardening-load.mjs";

test("nearest-rank percentile을 결정론적으로 계산한다", () => {
  assert.equal(percentile([5, 1, 4, 3, 2], 0.95), 5);
  assert.equal(percentile([10, 20, 30, 40], 0.5), 20);
  assert.throws(() => percentile([], 0.95), /비어/u);
});

test("격리된 hardening daemon은 임시 Connector root를 명시한다", () => {
  const environment = hardeningDaemonEnvironment({
    directory: "/tmp/massion-hardening-test",
    httpPort: 31_001,
    metricsPort: 31_002,
    registryPort: 31_003,
    path: "/usr/bin",
  });

  assert.equal(environment.MASSION_CONNECTOR_ROOT, "/tmp/massion-hardening-test/connectors");
  assert.equal(environment.MASSION_SOFTWARE_WORKSPACE_ROOT, "/tmp/massion-hardening-test/workspaces");
  assert.equal(environment.MASSION_HTTP_PORT, "31001");
});
