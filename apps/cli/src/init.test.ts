import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CliConfigStore } from "./config.js";
import { initializeCli } from "./init.js";

describe("mass init", () => {
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
});
