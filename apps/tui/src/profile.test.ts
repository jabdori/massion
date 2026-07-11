import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadTuiProfile } from "./profile.js";

const roots: string[] = [];

async function fixture(): Promise<{ configPath: string; tokenPath: string }> {
  const root = join(tmpdir(), `massion-tui-profile-${crypto.randomUUID()}`);
  roots.push(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const tokenPath = join(root, "local.token");
  const configPath = join(root, "config.json");
  await writeFile(tokenPath, "token-value\n", { mode: 0o600 });
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: "massion.cli.config.v1",
      selectedProfile: "local",
      profiles: { local: { endpoint: "http://127.0.0.1:7331", tokenReference: `file:${tokenPath}` } },
    }),
    { mode: 0o600 },
  );
  return { configPath, tokenPath };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("TUI profile", () => {
  it("CLI와 같은 안전한 profile에서 endpoint와 token을 읽는다", async () => {
    const { configPath } = await fixture();
    await expect(loadTuiProfile({ configPath })).resolves.toEqual({
      name: "local",
      endpoint: "http://127.0.0.1:7331",
      token: "token-value",
    });
  });

  it("group/world 권한과 symlink config·token을 거부한다", async () => {
    const first = await fixture();
    await chmod(first.configPath, 0o644);
    await expect(loadTuiProfile({ configPath: first.configPath })).rejects.toThrow(/0600/u);

    const second = await fixture();
    const linked = `${second.configPath}.link`;
    await symlink(second.configPath, linked);
    await expect(loadTuiProfile({ configPath: linked })).rejects.toThrow(/symlink/u);

    const third = await fixture();
    await chmod(third.tokenPath, 0o644);
    await expect(loadTuiProfile({ configPath: third.configPath })).rejects.toThrow(/token.*0600/u);
  });

  it("token 원문을 config field나 endpoint credential로 받지 않는다", async () => {
    const { configPath } = await fixture();
    const value = JSON.parse(await (await import("node:fs/promises")).readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    value.token = "secret";
    await writeFile(configPath, JSON.stringify(value), { mode: 0o600 });
    await expect(loadTuiProfile({ configPath })).rejects.toThrow(/알 수 없는/u);
  });
});
