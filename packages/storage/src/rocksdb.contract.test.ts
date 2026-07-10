import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

describe("embedded RocksDB contract", () => {
  it("별도 프로세스로 재시작해 선언 version을 복구한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-rocksdb-"));
    temporaryDirectories.push(root);
    const probe = new URL("../test/rocksdb-probe.mjs", import.meta.url);
    const probePath = fileURLToPath(probe);

    await execFileAsync(process.execPath, [probePath, "write", root], { timeout: 30_000 });
    const { stdout } = await execFileAsync(process.execPath, [probePath, "read", root], { timeout: 30_000 });

    expect(JSON.parse(stdout)).toEqual([{ durable: true }]);
  }, 70_000);
});
