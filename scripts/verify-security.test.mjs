import assert from "node:assert/strict";
import { test } from "node:test";

import { assertAuditReport, assertDeploymentSecurity } from "./verify-security.mjs";

test("moderate·high·critical production advisory를 거부한다", () => {
  assert.doesNotThrow(() =>
    assertAuditReport({ metadata: { vulnerabilities: { info: 0, low: 1, moderate: 0, high: 0, critical: 0 } } }),
  );
  assert.throws(
    () =>
      assertAuditReport({
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0 } },
      }),
    /moderate/u,
  );
});

test("container·Registry·Kubernetes 보안 불변량을 강제한다", () => {
  assert.doesNotThrow(() =>
    assertDeploymentSecurity({
      dockerfile: "USER node\nENTRYPOINT [dumb-init]\nHEALTHCHECK x",
      compose: "read_only: true\nno-new-privileges:true\ncap_drop:\n - ALL\nMASSION_REGISTRY_KEY_FILE: x",
      kubernetes:
        "runAsNonRoot: true\nreadOnlyRootFilesystem: true\nallowPrivilegeEscalation: false\ntype: RuntimeDefault\nautomountServiceAccountToken: false",
      caddy: "@registry path /npm/*\nMASSION_REGISTRY_UPSTREAM",
    }),
  );
  assert.throws(
    () => assertDeploymentSecurity({ dockerfile: "USER root", compose: "", kubernetes: "", caddy: "" }),
    /Dockerfile/u,
  );
});
