import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeRepositoryPath, resolveConfinedFile } from "./path.js";

describe("Repository path confinement", () => {
  it("POSIX relative path만 정규화하고 traversal·absolute·NUL을 거부한다", () => {
    expect(normalizeRepositoryPath("src/./domain/../index.ts")).toBe("src/index.ts");
    expect(normalizeRepositoryPath("src\\index.ts")).toBe("src/index.ts");
    for (const invalid of ["../secret", "/etc/passwd", "C:\\Windows\\system.ini", "a\0b", ""]) {
      expect(() => normalizeRepositoryPath(invalid)).toThrow();
    }
  });

  it("root 내부 regular file만 허용하고 root 밖 symlink를 거부한다", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "massion-path-"));
    const outside = await mkdtemp(path.join(tmpdir(), "massion-outside-"));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(path.join(outside, "secret.ts"), "export const secret = true;\n");
    await symlink(path.join(outside, "secret.ts"), path.join(root, "src", "linked.ts"));

    const resolved = await resolveConfinedFile(root, "src/index.ts");
    expect(resolved.relativePath).toBe("src/index.ts");
    expect(resolved.absolutePath).toBe(await realpath(path.join(root, "src", "index.ts")));
    await expect(resolveConfinedFile(root, "src/linked.ts")).rejects.toThrow("symlink");
    await expect(resolveConfinedFile(root, "../secret.ts")).rejects.toThrow();
  });
});
