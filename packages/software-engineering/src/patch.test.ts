import { describe, expect, it } from "vitest";

import { validateUnifiedPatch } from "./patch.js";

describe("Git unified patch 검증", () => {
  const safePatch = `diff --git a/src/value.js b/src/value.js
--- a/src/value.js
+++ b/src/value.js
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`;

  it("허용 path의 text patch를 정규화하고 SHA-256 provenance를 만든다", () => {
    const validated = validateUnifiedPatch(safePatch, { allowedPaths: ["src"] });
    expect(validated.paths).toEqual(["src/value.js"]);
    expect(validated.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(validated.text).toBe(safePatch);
  });

  it.each([
    {
      name: "traversal",
      patch: safePatch.replaceAll("src/value.js", "../../outside"),
      error: "안전한 repository 상대 경로",
    },
    {
      name: "absolute header",
      patch: safePatch.replace("--- a/src/value.js", "--- /etc/passwd"),
      error: "patch header",
    },
    {
      name: ".git metadata",
      patch: safePatch.replaceAll("src/value.js", ".git/config"),
      error: ".git",
    },
    {
      name: "outside allowed path",
      patch: safePatch.replaceAll("src/value.js", "docs/value.js"),
      error: "허용 경로 밖",
    },
    {
      name: "binary",
      patch: "diff --git a/src/image.png b/src/image.png\nGIT binary patch\nliteral 1\nAcmZQz\n",
      error: "binary",
    },
    {
      name: "symlink",
      patch:
        "diff --git a/src/link b/src/link\nnew file mode 120000\n--- /dev/null\n+++ b/src/link\n@@ -0,0 +1 @@\n+target\n",
      error: "symlink",
    },
    {
      name: "submodule",
      patch:
        "diff --git a/src/submodule b/src/submodule\nindex 1111111..2222222 160000\n--- a/src/submodule\n+++ b/src/submodule\n@@ -1 +1 @@\n-Subproject commit 1111111\n+Subproject commit 2222222\n",
      error: "submodule",
    },
  ])("$name patch를 거부한다", ({ patch, error }) => {
    expect(() => validateUnifiedPatch(patch, { allowedPaths: ["src"] })).toThrow(error);
  });

  it("여러 file section과 rename 양쪽 path를 모두 검증한다", () => {
    const patch = `diff --git a/src/old name.js b/src/new name.js
similarity index 100%
rename from src/old name.js
rename to src/new name.js
diff --git a/src/value.js b/src/value.js
--- a/src/value.js
+++ b/src/value.js
@@ -1 +1 @@
-old
+new
`;
    expect(validateUnifiedPatch(patch, { allowedPaths: ["src"] }).paths).toEqual([
      "src/new name.js",
      "src/old name.js",
      "src/value.js",
    ]);
  });
});
