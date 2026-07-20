import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CliConfigStore } from "./config.js";
import { initializeCli, replaceCliFileToken } from "./init.js";

describe("massion init", () => {
  it("loopback bootstrap token을 별도 0600 file에 저장하고 config에는 reference만 둔다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-init-"));
    const store = new CliConfigStore(join(root, "config.json"));
    const result = await initializeCli({
      endpoint: "http://127.0.0.1:7331",
      email: "owner@example.com",
      displayName: "Owner",
      profile: "local",
      config: store,
      bootstrap: async () => ({ access: { token: "mat_bootstrap", tokenId: "token-1" } }),
    });
    expect(result).toMatchObject({ profile: "local", tokenId: "token-1" });
    const config = await store.load();
    expect(JSON.stringify(config)).not.toContain("mat_bootstrap");
    const tokenPath = config.profiles.local?.tokenReference.slice(5);
    if (!tokenPath) throw new Error("token path가 없습니다");
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    expect((await readFile(tokenPath, "utf8")).trim()).toBe("mat_bootstrap");
    await rm(root, { recursive: true, force: true });
  });

  it("만료된 기존 token을 같은 profile의 새 token으로 원자적으로 교체한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-init-reconnect-"));
    const store = new CliConfigStore(join(root, "config.json"));
    let issued = 0;
    const bootstrap = async () => {
      issued += 1;
      return { access: { token: `mat_token_${String(issued)}`, tokenId: `token-${String(issued)}` } };
    };
    await initializeCli({
      endpoint: "http://127.0.0.1:7331",
      email: "owner@example.com",
      displayName: "Owner",
      profile: "local",
      config: store,
      bootstrap,
    });
    await initializeCli({
      endpoint: "http://127.0.0.1:7331",
      email: "owner@example.com",
      displayName: "Owner",
      profile: "local",
      config: store,
      bootstrap,
    });
    const config = await store.load();
    const tokenPath = config.profiles.local?.tokenReference.slice(5);
    if (!tokenPath) throw new Error("token path가 없습니다");
    expect((await readFile(tokenPath, "utf8")).trim()).toBe("mat_token_2");
    await rm(root, { recursive: true, force: true });
  });

  it("기존 개인 token file reference를 0600 새 token으로 교체한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-token-refresh-"));
    const tokenPath = join(root, "local.token");
    await writeFile(tokenPath, "mat_expired\n", { mode: 0o600 });

    await replaceCliFileToken(`file:${tokenPath}`, "mat_refreshed");

    expect((await readFile(tokenPath, "utf8")).trim()).toBe("mat_refreshed");
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    await rm(root, { recursive: true, force: true });
  });
});
