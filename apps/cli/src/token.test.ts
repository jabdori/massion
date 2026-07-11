import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveTokenReference } from "./token.js";

describe("CLI token reference", () => {
  it("token 원문 대신 environment reference를 해석한다", async () => {
    await expect(resolveTokenReference("env:MASSION_TOKEN", { MASSION_TOKEN: "mat_secret" })).resolves.toBe(
      "mat_secret",
    );
  });

  it("0600 file만 읽고 symlink를 거부한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-token-"));
    const file = join(root, "token");
    const link = join(root, "link");
    await writeFile(file, "mat_file\n", { mode: 0o600 });
    await symlink(file, link);
    await expect(resolveTokenReference(`file:${file}`)).resolves.toBe("mat_file");
    await expect(resolveTokenReference(`file:${link}`)).rejects.toThrow("symlink");
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
});
