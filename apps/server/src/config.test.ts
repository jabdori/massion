import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadServerConfig, parseServerConfig } from "./config.js";

const key = Buffer.alloc(32, 7).toString("base64url");

describe("server configuration", () => {
  it("개인 local mode는 loopback과 owner-only key로 구성한다", () => {
    expect(parseServerConfig({ MASSION_TOKEN_KEY: key })).toMatchObject({
      mode: "local",
      database: { url: "rocksdb:///data/massion.db", namespace: "massion", database: "massion" },
      server: { host: "127.0.0.1", port: 3141 },
    });
  });

  it("team mode는 원격 DB·비loopback bind·trusted TLS proxy를 모두 요구한다", () => {
    expect(() =>
      parseServerConfig({ MASSION_MODE: "team", MASSION_TOKEN_KEY: key, MASSION_DATABASE_URL: "ws://db:8000/rpc" }),
    ).toThrow("trusted proxy");
    expect(
      parseServerConfig({
        MASSION_MODE: "team",
        MASSION_TOKEN_KEY: key,
        MASSION_DATABASE_URL: "ws://db:8000/rpc",
        MASSION_HTTP_HOST: "0.0.0.0",
        MASSION_TRUSTED_PROXIES: "172.20.0.10,::ffff:172.20.0.10",
      }),
    ).toMatchObject({
      mode: "team",
      server: { host: "0.0.0.0", trustedProxyAddresses: ["172.20.0.10", "::ffff:172.20.0.10"] },
    });
  });

  it("짧거나 잘못 인코딩된 key와 team embedded DB를 거부한다", () => {
    expect(() => parseServerConfig({ MASSION_TOKEN_KEY: "short" })).toThrow("32 byte");
    expect(() =>
      parseServerConfig({
        MASSION_MODE: "team",
        MASSION_TOKEN_KEY: key,
        MASSION_DATABASE_URL: "rocksdb:///data/team.db",
        MASSION_HTTP_HOST: "0.0.0.0",
        MASSION_TRUSTED_PROXIES: "127.0.0.1",
      }),
    ).toThrow("remote SurrealDB");
  });

  it("owner-only secret file만 읽고 environment 원문과 동시 사용을 거부한다", async () => {
    const directory = await mkdtemp(join(tmpdir(), "massion-server-config-"));
    const path = join(directory, "token-key");
    try {
      await writeFile(path, key, { mode: 0o600 });
      await expect(loadServerConfig({ MASSION_TOKEN_KEY_FILE: path })).resolves.toMatchObject({
        tokenKey: { key: Buffer.alloc(32, 7) },
      });
      await expect(loadServerConfig({ MASSION_TOKEN_KEY: key, MASSION_TOKEN_KEY_FILE: path })).rejects.toThrow(
        "동시에",
      );
      await chmod(path, 0o644);
      await expect(loadServerConfig({ MASSION_TOKEN_KEY_FILE: path })).rejects.toThrow("owner-only");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
