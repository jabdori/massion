import { createHash } from "node:crypto";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { RepositoryScanner } from "./scanner.js";

describe("Repository scanner", () => {
  it("ignore와 include를 적용하고 text file의 deterministic manifest를 만든다", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "massion-scan-"));
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, ".gitignore"), "ignored.ts\n");
    await writeFile(path.join(root, ".massionignore"), "private/**\n");
    await writeFile(path.join(root, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(path.join(root, "ignored.ts"), "ignored\n");
    await writeFile(path.join(root, "node_modules", "dependency.ts"), "dependency\n");
    const scanner = new RepositoryScanner();

    const first = await scanner.scan(root, { include: ["**/*.ts"], exclude: [], maxFileBytes: 1_024 });
    const second = await scanner.scan(root, { include: ["**/*.ts"], exclude: [], maxFileBytes: 1_024 });

    expect(first.files.map((file) => file.relativePath)).toEqual(["src/index.ts"]);
    expect(first.files[0]).toMatchObject({ language: "typescript", size: 24, status: "indexed" });
    expect(first.manifestChecksum).toBe(second.manifestChecksum);
    expect(first.rootRealPathHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("binary·oversized·invalid UTF-8과 symlink를 content 없이 제외한다", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "massion-scan-exclude-"));
    const outside = await mkdtemp(path.join(tmpdir(), "massion-scan-outside-"));
    await writeFile(path.join(root, "binary.ts"), Buffer.from([0, 1, 2, 3]));
    await writeFile(path.join(root, "large.ts"), "x".repeat(30));
    await writeFile(path.join(root, "invalid.ts"), Buffer.from([0xc3, 0x28]));
    await writeFile(path.join(outside, "outside.ts"), "outside\n");
    await symlink(path.join(outside, "outside.ts"), path.join(root, "linked.ts"));
    const scanner = new RepositoryScanner();

    const result = await scanner.scan(root, { include: ["**/*.ts"], exclude: [], maxFileBytes: 20 });

    expect(result.files).toEqual([]);
    expect(result.excluded.map((file) => [file.relativePath, file.reason])).toEqual([
      ["binary.ts", "binary"],
      ["invalid.ts", "invalid_utf8"],
      ["large.ts", "oversized"],
      ["linked.ts", "symlink"],
    ]);
    expect(result.excluded.every((file) => !("content" in file))).toBe(true);
  });

  it("source credential을 같은 byte 길이로 redaction하고 원문 대신 hash와 reason만 남긴다", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "massion-scan-secret-"));
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const original = `export const apiKey = "${secret}";\n`;
    await writeFile(path.join(root, "secret.ts"), original);
    const scanner = new RepositoryScanner();

    const scan = await scanner.scan(root, { include: ["**/*.ts"], exclude: [], maxFileBytes: 1_024 });
    const file = scan.files[0];

    expect(file?.content).not.toContain(secret);
    expect(Buffer.byteLength(file?.content ?? "")).toBe(Buffer.byteLength(original));
    expect(file?.redactions).toEqual([
      expect.objectContaining({
        reason: "provider_token",
        contentHash: createHash("sha256").update(secret).digest("hex"),
      }),
    ]);
    expect(JSON.stringify(scan)).not.toContain(secret);
  });
});
