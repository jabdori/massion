import { createHash } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attestLocalSurrealRuntime,
  provisionLocalSurrealDatabase,
  resolveLocalSurrealRuntime,
} from "./local-surreal-runtime.js";

describe("개인용 SurrealDB local runtime", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
  });

  it("XDG data home 아래에 3.2.1 binary와 major별 database 경로를 분리한다", () => {
    const runtime = resolveLocalSurrealRuntime({
      home: "/Users/massion",
      xdgDataHome: "/Users/massion/.local/share",
      platform: "darwin",
      architecture: "arm64",
    });

    expect(runtime.binaryPath).toBe("/Users/massion/.local/share/massion/runtime/surrealdb/3.2.1/darwin-arm64/surreal");
    expect(runtime.dataDirectory).toBe("/Users/massion/.local/share/massion/surrealdb/3/database");
  });

  it("인증된 loopback SQL endpoint에서 Massion namespace와 database를 idempotent하게 준비한다", async () => {
    const password = "local-secret-must-not-appear-in-url";
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json([{ status: "OK" }, { status: "OK" }, { status: "OK" }]),
    );

    await expect(
      provisionLocalSurrealDatabase({
        endpoint: "http://127.0.0.1:17431",
        credential: { user: "massion", password },
        fetcher,
      }),
    ).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "http://127.0.0.1:17431/sql",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("DEFINE NAMESPACE IF NOT EXISTS massion"),
      }),
    );
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain(password);
  });

  it("절대 regular executable의 SHA-256과 정확한 surreal version 3.2.1을 증명한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-surreal-runtime-"));
    roots.push(root);
    const executable = join(root, "surreal");
    const contents = "#!/bin/sh\nexit 0\n";
    await writeFile(executable, contents, { mode: 0o700 });
    const canonicalExecutable = await realpath(executable);
    const expectedDigest = createHash("sha256").update(contents).digest("hex");
    const runVersion = vi.fn(async () => ({ stdout: "surreal 3.2.1 for macos on aarch64\n" }));

    await expect(
      attestLocalSurrealRuntime({ executable, expectedDigest, runtimeRoot: root }, { runVersion }),
    ).resolves.toEqual({
      executable: canonicalExecutable,
      digest: expectedDigest,
      version: "3.2.1",
    });
    expect(runVersion).toHaveBeenCalledWith(canonicalExecutable, ["version"], {
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    });
  });

  it("symlink·digest 불일치·3.2.1이 아닌 version을 fail-closed로 거부한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-surreal-runtime-invalid-"));
    roots.push(root);
    const executable = join(root, "surreal");
    const link = join(root, "surreal-link");
    const contents = "#!/bin/sh\nexit 0\n";
    await writeFile(executable, contents, { mode: 0o700 });
    await symlink(executable, link);
    const expectedDigest = createHash("sha256").update(contents).digest("hex");
    const runVersion = async () => ({ stdout: "surreal 3.2.1 for macos on aarch64\n" });

    await expect(
      attestLocalSurrealRuntime({ executable: "surreal", expectedDigest, runtimeRoot: root }, { runVersion }),
    ).rejects.toThrow(/절대 경로/u);
    await expect(
      attestLocalSurrealRuntime({ executable: link, expectedDigest, runtimeRoot: root }, { runVersion }),
    ).rejects.toThrow(/symlink|regular file/u);
    await expect(
      attestLocalSurrealRuntime({ executable, expectedDigest: "a".repeat(64), runtimeRoot: root }, { runVersion }),
    ).rejects.toThrow(/digest/u);
    await expect(
      attestLocalSurrealRuntime(
        { executable, expectedDigest, runtimeRoot: root },
        { runVersion: async () => ({ stdout: "3.2.1-beta.1" }) },
      ),
    ).rejects.toThrow(/version|3\.2\.1/u);
  });

  it("현재 사용자만 쓸 수 있는 runtime root 안의 executable만 증명한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-surreal-runtime-root-"));
    roots.push(root);
    const executable = join(root, "surreal");
    const contents = "#!/bin/sh\nexit 0\n";
    await writeFile(executable, contents, { mode: 0o700 });
    const expectedDigest = createHash("sha256").update(contents).digest("hex");
    await chmod(root, 0o755);

    await expect(
      attestLocalSurrealRuntime(
        { executable, expectedDigest, runtimeRoot: root },
        { runVersion: async () => ({ stdout: "surreal 3.2.1" }) },
      ),
    ).rejects.toThrow(/owner-only/u);
  });

  it("version 확인 중 실행 파일이 바뀌면 증명을 중단한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-local-surreal-runtime-change-"));
    roots.push(root);
    const executable = join(root, "surreal");
    const contents = "#!/bin/sh\nexit 0\n";
    await writeFile(executable, contents, { mode: 0o700 });
    const expectedDigest = createHash("sha256").update(contents).digest("hex");

    await expect(
      attestLocalSurrealRuntime(
        { executable, expectedDigest, runtimeRoot: root },
        {
          runVersion: async () => {
            await writeFile(executable, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
            return { stdout: "surreal 3.2.1" };
          },
        },
      ),
    ).rejects.toThrow(/변경/u);
  });
});
