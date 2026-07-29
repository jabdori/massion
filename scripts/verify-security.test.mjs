import assert from "node:assert/strict";
import { test } from "node:test";

import { assertDeploymentSecurity, parseAuditReport } from "./verify-security.mjs";

test("moderate·high·critical production·full advisory를 모두 거부한다", () => {
  const vulnerabilities = { info: 0, low: 1, moderate: 0, high: 0, critical: 0 };
  for (const scope of ["production", "full"]) {
    assert.doesNotThrow(() => parseAuditReport(JSON.stringify({ metadata: { vulnerabilities } }), scope));
    for (const severity of ["moderate", "high", "critical"]) {
      assert.throws(
        () =>
          parseAuditReport(
            JSON.stringify({ metadata: { vulnerabilities: { ...vulnerabilities, [severity]: 1 } } }),
            scope,
          ),
        new RegExp(`${severity} ${scope} advisory`, "u"),
      );
    }
    assert.throws(
      () =>
        parseAuditReport(
          JSON.stringify({
            metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: -1, critical: 0 } },
          }),
          scope,
        ),
      new RegExp(`high ${scope} audit 수치`, "u"),
    );
  }
});

test("손상된 production·full audit JSON에서 범위를 포함해 실패한다", () => {
  for (const scope of ["production", "full"]) {
    assert.throws(() => parseAuditReport('{"metadata":', scope), new RegExp(`${scope} audit report JSON`, "u"));
  }
});

test("registry 오류 envelope를 취약점 0으로 처리하지 않는다", () => {
  const report = {
    error: {
      code: "ERR_PNPM_AUDIT_BAD_RESPONSE",
      message: "The audit endpoint has been retired.",
    },
  };
  for (const scope of ["production", "full"]) {
    assert.throws(
      () => parseAuditReport(JSON.stringify(report), scope),
      new RegExp(`${scope} audit report 구조가 유효하지 않습니다`, "u"),
    );
  }
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
