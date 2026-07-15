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

test("registry 오류 envelope를 취약점 0으로 처리하지 않는다", () => {
  assert.throws(
    () =>
      assertAuditReport({
        error: {
          code: "ERR_PNPM_AUDIT_BAD_RESPONSE",
          message: "The audit endpoint has been retired.",
        },
      }),
    /구조가 유효하지 않습니다/u,
  );
});

test("container·Registry·Kubernetes 보안 불변량을 강제한다", () => {
  assert.doesNotThrow(() =>
    assertDeploymentSecurity({
      dockerfile: "USER node\nENTRYPOINT [dumb-init]\nHEALTHCHECK x",
      compose:
        "read_only: true\nno-new-privileges:true\ncap_drop:\n - ALL\nMASSION_REGISTRY_KEY_FILE: x\ndatabase-provision:\nMASSION_DATABASE_PROVISION_PASSWORD_FILE: x\nMASSION_DATABASE_USER: massion_runtime",
      kubernetes:
        "runAsNonRoot: true\nreadOnlyRootFilesystem: true\nallowPrivilegeEscalation: false\ntype: RuntimeDefault\nautomountServiceAccountToken: false\nname: provision-database\nname: provision-secrets\nname: app-secrets\nname: tls-secrets",
      caddy: "@registry path /npm/*\nMASSION_REGISTRY_UPSTREAM",
    }),
  );
  assert.throws(
    () => assertDeploymentSecurity({ dockerfile: "USER root", compose: "", kubernetes: "", caddy: "" }),
    /Dockerfile/u,
  );
});
