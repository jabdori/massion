import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveLocalPaths, resolveLocalSurrealRuntime } from "@massion/local-control/daemon";

import { prepareDesktopRuntimeEnvironment } from "./runtime-staging.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function fixture(content = "bundled-surreal-runtime") {
  const root = await mkdtemp(join(tmpdir(), "massion-desktop-runtime-"));
  roots.push(root);
  const source = join(root, "bundle", "surreal");
  await mkdir(dirname(source), { recursive: true });
  await writeFile(source, content, { mode: 0o700 });
  await chmod(source, 0o700);
  const digest = createHash("sha256").update(content).digest("hex");
  const xdgDataHome = join(root, "data");
  return {
    root,
    source,
    digest,
    xdgDataHome,
    environment: {
      HOME: root,
      XDG_DATA_HOME: xdgDataHome,
      MASSION_SURREAL_BINARY: source,
      MASSION_SURREAL_SHA256: digest,
    },
  };
}

describe("bundled SurrealDB runtime staging", () => {
  it("digest를 단일 pass로 검증하고 per-user runtime 경로에 owner-only로 원자 배치한다", async () => {
    const value = await fixture();
    const expected = resolveLocalSurrealRuntime({ home: value.root, xdgDataHome: value.xdgDataHome }).binaryPath;

    const environment = await prepareDesktopRuntimeEnvironment(value.environment);

    expect(environment.MASSION_SURREAL_BINARY).toBe(expected);
    expect(await readFile(expected, "utf8")).toBe("bundled-surreal-runtime");
    const metadata = await lstat(expected);
    expect(metadata.isFile()).toBe(true);
    expect(metadata.isSymbolicLink()).toBe(false);
    expect(metadata.mode & 0o777).toBe(0o500);
    await expect(prepareDesktopRuntimeEnvironment(environment)).resolves.toMatchObject({
      MASSION_SURREAL_BINARY: expected,
      MASSION_SURREAL_SHA256: value.digest,
    });
  });

  it("staging 전에 이전 v1 epoch의 config·data·state를 함께 초기화한다", async () => {
    const value = await fixture();
    const paths = resolveLocalPaths(value.environment);
    await Promise.all(
      [paths.configDirectory, paths.dataDirectory, paths.stateDirectory].map(async (directory) => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(join(directory, ".massion-data-epoch"), "obsolete\n", { mode: 0o600 });
        await writeFile(join(directory, "stale"), "stale", { mode: 0o600 });
      }),
    );

    await prepareDesktopRuntimeEnvironment(value.environment);

    await Promise.all(
      [paths.configDirectory, paths.dataDirectory, paths.stateDirectory].map(async (directory) => {
        await expect(stat(join(directory, "stale"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(join(directory, ".massion-data-epoch"), "utf8")).resolves.toBe(
          "massion-v1-data-epoch-1\n",
        );
      }),
    );
  });

  it("digest 불일치와 symlink source를 거부하고 실행 파일을 남기지 않는다", async () => {
    const value = await fixture();
    const expected = resolveLocalSurrealRuntime({ home: value.root, xdgDataHome: value.xdgDataHome }).binaryPath;

    await expect(
      prepareDesktopRuntimeEnvironment({ ...value.environment, MASSION_SURREAL_SHA256: "0".repeat(64) }),
    ).rejects.toThrow("digest");
    await expect(lstat(expected)).rejects.toMatchObject({ code: "ENOENT" });

    const symlinkPath = join(value.root, "bundle", "surreal-link");
    await symlink(value.source, symlinkPath);
    await expect(
      prepareDesktopRuntimeEnvironment({ ...value.environment, MASSION_SURREAL_BINARY: symlinkPath }),
    ).rejects.toThrow("symlink");

    const hardlink = join(value.root, "bundle", "surreal-hardlink");
    await link(value.source, hardlink);
    await expect(
      prepareDesktopRuntimeEnvironment({ ...value.environment, MASSION_SURREAL_BINARY: hardlink }),
    ).rejects.toThrow("hard link");
  });

  it("같은 digest의 동시 staging은 같은 실행 파일로 수렴한다", async () => {
    const value = await fixture();
    const expected = resolveLocalSurrealRuntime({ home: value.root, xdgDataHome: value.xdgDataHome }).binaryPath;

    const environments = await Promise.all([
      prepareDesktopRuntimeEnvironment(value.environment),
      prepareDesktopRuntimeEnvironment(value.environment),
      prepareDesktopRuntimeEnvironment(value.environment),
    ]);

    expect(environments.every((environment) => environment.MASSION_SURREAL_BINARY === expected)).toBe(true);
    expect(await readFile(expected, "utf8")).toBe("bundled-surreal-runtime");
  });

  it("검증 실패 시 기존 attested runtime을 보존한다", async () => {
    const value = await fixture("known-runtime");
    const expected = resolveLocalSurrealRuntime({ home: value.root, xdgDataHome: value.xdgDataHome }).binaryPath;
    await prepareDesktopRuntimeEnvironment(value.environment);
    await writeFile(value.source, "tampered-runtime", { mode: 0o700 });
    const nextDigest = createHash("sha256").update("expected-new-runtime").digest("hex");

    await expect(
      prepareDesktopRuntimeEnvironment({ ...value.environment, MASSION_SURREAL_SHA256: nextDigest }),
    ).rejects.toThrow("digest");

    expect(await readFile(expected, "utf8")).toBe("known-runtime");
  });

  it("per-user runtime root symlink를 따라 쓰지 않는다", async () => {
    const value = await fixture();
    const outside = join(value.root, "outside");
    await mkdir(outside, { mode: 0o700 });
    await mkdir(value.xdgDataHome, { recursive: true, mode: 0o700 });
    await symlink(outside, join(value.xdgDataHome, "massion-v1"));

    await expect(prepareDesktopRuntimeEnvironment(value.environment)).rejects.toThrow("symlink");
    await expect(lstat(join(outside, "runtime"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
