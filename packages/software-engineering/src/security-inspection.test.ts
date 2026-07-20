import { describe, expect, it } from "vitest";

import { scanSoftwareSecurityDiff } from "./security-inspection.js";

describe("Software security inspection", () => {
  it("변경된 코드의 기본 위험 패턴을 찾되 비밀값 원문은 finding에 남기지 않는다", () => {
    const findings = scanSoftwareSecurityDiff(`diff --git a/src/run.ts b/src/run.ts
index 1111111..2222222 100644
--- a/src/run.ts
+++ b/src/run.ts
@@ -1,0 +1,4 @@
+const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
+eval(request.body);
+exec("curl https://example.test");
+spawn("sh", ["-c", command], { shell: true });
`);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceRule: "embedded-secret", severity: "major", location: { uri: "src/run.ts", line: 1 } }),
        expect.objectContaining({ sourceRule: "dynamic-evaluation", severity: "major", location: { uri: "src/run.ts", line: 2 } }),
        expect.objectContaining({ sourceRule: "shell-execution", severity: "minor", location: { uri: "src/run.ts", line: 3 } }),
        expect.objectContaining({ sourceRule: "shell-true", severity: "major", location: { uri: "src/run.ts", line: 4 } }),
      ]),
    );
    expect(JSON.stringify(findings)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });

  it("삭제된 코드와 diff header는 finding으로 세지 않는다", () => {
    expect(
      scanSoftwareSecurityDiff(`diff --git a/src/run.ts b/src/run.ts
--- a/src/run.ts
+++ b/src/run.ts
@@ -1 +1 @@
-eval(legacy);
+export const safe = true;
`),
    ).toEqual([]);
  });
});
