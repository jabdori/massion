import { execFile } from "node:child_process";
import { mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { diffManifests, RepositoryRevisionCollector } from "./revision.js";
import { RepositoryScanner } from "./scanner.js";

const execute = promisify(execFile);
const options = { include: ["**/*.ts"], exclude: [], maxFileBytes: 10_000 } as const;
const temporaryRoots: string[] = [];

async function createTemporaryRoot(parent: string, prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(parent, prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function nonGitTemporaryParent(): Promise<string> {
  let candidate = await realpath(tmpdir());
  while (true) {
    let stdout: string;
    try {
      ({ stdout } = await execute("git", ["-C", candidate, "rev-parse", "--show-toplevel"]));
    } catch {
      return candidate;
    }
    const topLevel = await realpath(stdout.trim());
    const parent = path.dirname(topLevel);
    if (parent === topLevel) throw new Error("non-Git fixture 상위 임시 경로를 찾을 수 없습니다");
    candidate = await realpath(parent);
  }
}

describe("Repository revision capture", () => {
  it("Git clean commit과 working tree dirty fingerprint를 구분한다", async () => {
    const root = await createTemporaryRoot(tmpdir(), "massion-git-");
    await execute("git", ["init", "-q"], { cwd: root });
    await execute("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execute("git", ["config", "user.name", "Massion Test"], { cwd: root });
    await writeFile(path.join(root, "index.ts"), "export const value = 1;\n");
    await execute("git", ["add", "index.ts"], { cwd: root });
    await execute("git", ["commit", "-qm", "initial"], { cwd: root });
    const collector = new RepositoryRevisionCollector(new RepositoryScanner());

    const clean = await collector.capture(root, options);
    await writeFile(path.join(root, "index.ts"), "export const value = 2;\n");
    const dirty = await collector.capture(root, options);

    expect(clean).toMatchObject({ providerKind: "git", dirty: false });
    expect(clean.providerRevision).toMatch(/^[a-f0-9]{40}$/u);
    expect(clean.revision).toBe(clean.providerRevision);
    expect(dirty).toMatchObject({ providerKind: "git", dirty: true });
    expect(dirty.dirtyFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(dirty.revision).toBe(`${dirty.providerRevision}:dirty:${dirty.dirtyFingerprint}`);
    expect(dirty.manifestChecksum).not.toBe(clean.manifestChecksum);
  });

  it("non-Git snapshot revision은 manifest가 같으면 안정적이고 변경되면 달라진다", async () => {
    const root = await createTemporaryRoot(await nonGitTemporaryParent(), "massion-filesystem-");
    await writeFile(path.join(root, "index.ts"), "export const value = 1;\n");
    const collector = new RepositoryRevisionCollector(new RepositoryScanner());
    const first = await collector.capture(root, options);
    const repeated = await collector.capture(root, options);
    await writeFile(path.join(root, "index.ts"), "export const value = 3;\n");
    const changed = await collector.capture(root, options);

    expect(first).toMatchObject({ providerKind: "filesystem", dirty: false });
    expect(repeated.revision).toBe(first.revision);
    expect(changed.revision).not.toBe(first.revision);
  });

  it("Git repository로 감지된 뒤 HEAD 수집 실패를 filesystem snapshot으로 숨기지 않는다", async () => {
    const root = await createTemporaryRoot(tmpdir(), "massion-empty-git-");
    await execute("git", ["init", "-q"], { cwd: root });
    await writeFile(path.join(root, "index.ts"), "export const value = 1;\n");
    const collector = new RepositoryRevisionCollector(new RepositoryScanner());

    await expect(collector.capture(root, options)).rejects.toThrow();
  });

  it("manifest 차이에서 create·modify·delete와 content-hash rename을 결정론적으로 찾는다", async () => {
    const root = await createTemporaryRoot(tmpdir(), "massion-diff-");
    await writeFile(path.join(root, "keep.ts"), "keep\n");
    await writeFile(path.join(root, "modify.ts"), "before\n");
    await writeFile(path.join(root, "delete.ts"), "delete\n");
    await writeFile(path.join(root, "old-name.ts"), "rename\n");
    const scanner = new RepositoryScanner();
    const before = await scanner.scan(root, options);
    await writeFile(path.join(root, "modify.ts"), "after\n");
    await rm(path.join(root, "delete.ts"));
    await rename(path.join(root, "old-name.ts"), path.join(root, "new-name.ts"));
    await writeFile(path.join(root, "create.ts"), "create\n");
    const after = await scanner.scan(root, options);

    expect(diffManifests(before.files, after.files)).toEqual({
      created: ["create.ts"],
      modified: ["modify.ts"],
      deleted: ["delete.ts"],
      renamed: [{ previousPath: "old-name.ts", relativePath: "new-name.ts" }],
    });
  });
});
