import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CliConfigStore, resolveCliConfigPath } from "./config.js";

describe("mass CLI config", () => {
  const roots: string[] = [];
  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
  });

  it("XDG와 macOS 표준 경로를 결정한다", () => {
    expect(resolveCliConfigPath({ platform: "linux", home: "/home/test", xdgConfigHome: "/config" })).toBe(
      "/config/massion/config.json",
    );
    expect(resolveCliConfigPath({ platform: "darwin", home: "/Users/test" })).toBe(
      "/Users/test/Library/Application Support/Massion/config.json",
    );
  });

  it("0600 atomic config에 endpoint·token reference·selected profile만 저장한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-cli-config-"));
    roots.push(root);
    const path = join(root, "config.json");
    const store = new CliConfigStore(path);
    await store.save({
      schemaVersion: "massion.cli.config.v1",
      selectedProfile: "local",
      profiles: { local: { endpoint: "http://127.0.0.1:7331", tokenReference: "keychain:massion/local" } },
    });
    await expect(store.load()).resolves.toMatchObject({ selectedProfile: "local" });
    const { stat } = await import("node:fs/promises");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("symlink와 group/world writable config를 거부한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-cli-config-"));
    roots.push(root);
    const target = join(root, "target.json");
    const link = join(root, "link.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, link);
    await expect(new CliConfigStore(link).load()).rejects.toThrow("symlink");
    await chmod(target, 0o644);
    await expect(new CliConfigStore(target).load()).rejects.toThrow("0600");
  });
});
