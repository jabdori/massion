import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadDatabaseProvisionConfig,
  loadServerConfig,
  parseDatabaseProvisionConfig,
  parseServerConfig,
} from "./config.js";

const key = Buffer.alloc(32, 7).toString("base64url");
const credentialKey = Buffer.alloc(32, 8).toString("base64url");

describe("server configuration", () => {
  it("개인 local mode는 loopback과 owner-only key로 구성한다", () => {
    expect(parseServerConfig({ MASSION_TOKEN_KEY: key, MASSION_CREDENTIAL_KEY: credentialKey })).toMatchObject({
      mode: "local",
      database: { url: "rocksdb:///data/massion.db", namespace: "massion", database: "massion" },
      server: { host: "127.0.0.1", port: 3141 },
      registry: { host: "127.0.0.1", port: 3142, publicBaseUrl: "http://127.0.0.1:3142" },
      credentialKey: Buffer.alloc(32, 8),
      software: { workspaceRoot: "/var/lib/massion/workspaces", executables: { node: process.execPath } },
    });
  });

  it("Software Delivery executable allowlist는 절대 경로 JSON만 허용한다", () => {
    const base = { MASSION_TOKEN_KEY: key, MASSION_CREDENTIAL_KEY: credentialKey };
    expect(() => parseServerConfig({ ...base, MASSION_SOFTWARE_EXECUTABLES: '{"node":"node"}' })).toThrow("절대 경로");
    expect(
      parseServerConfig({
        ...base,
        MASSION_SOFTWARE_EXECUTABLES: JSON.stringify({ node: process.execPath }),
        MASSION_SOFTWARE_ENVIRONMENT_ALLOWLIST: "CI,NODE_ENV",
      }).software,
    ).toMatchObject({ executables: { node: process.execPath }, environmentAllowlist: ["CI", "NODE_ENV"] });
  });

  it("접근 token과 provider credential은 서로 다른 암호화 key를 요구한다", () => {
    expect(() => parseServerConfig({ MASSION_TOKEN_KEY: key, MASSION_CREDENTIAL_KEY: key })).toThrow("서로 다른 key");
  });

  it("team mode는 원격 DB·비loopback bind·trusted TLS proxy를 모두 요구한다", () => {
    expect(() =>
      parseServerConfig({ MASSION_MODE: "team", MASSION_TOKEN_KEY: key, MASSION_DATABASE_URL: "ws://db:8000/rpc" }),
    ).toThrow("trusted proxy");
    expect(
      parseServerConfig({
        MASSION_MODE: "team",
        MASSION_TOKEN_KEY: key,
        MASSION_CREDENTIAL_KEY: credentialKey,
        MASSION_REGISTRY_KEY: key,
        MASSION_REGISTRY_PUBLIC_URL: "https://massion.example.com",
        MASSION_DATABASE_URL: "ws://db:8000/rpc",
        MASSION_DATABASE_USER: "massion_runtime",
        MASSION_DATABASE_PASSWORD: "runtime-password",
        MASSION_HTTP_HOST: "0.0.0.0",
        MASSION_TRUSTED_PROXIES: "172.20.0.10,::ffff:172.20.0.10",
      }),
    ).toMatchObject({
      mode: "team",
      server: { host: "0.0.0.0", trustedProxyAddresses: ["172.20.0.10", "::ffff:172.20.0.10"] },
    });
  });

  it("team API는 runtime DB 계정만 받고 owner provisioning 계정을 받지 않는다", () => {
    const environment = {
      MASSION_MODE: "team",
      MASSION_TOKEN_KEY: key,
      MASSION_CREDENTIAL_KEY: credentialKey,
      MASSION_REGISTRY_KEY: key,
      MASSION_REGISTRY_PUBLIC_URL: "https://massion.example.com",
      MASSION_DATABASE_URL: "ws://db:8000/rpc",
      MASSION_DATABASE_USER: "massion_runtime",
      MASSION_DATABASE_PASSWORD: "runtime-password",
      MASSION_HTTP_HOST: "0.0.0.0",
      MASSION_TRUSTED_PROXIES: "127.0.0.1",
    };
    expect(parseServerConfig(environment).database.authentication).toEqual({
      username: "massion_runtime",
      password: "runtime-password",
      scope: "database",
    });
    expect(() =>
      parseServerConfig({
        ...environment,
        MASSION_DATABASE_PROVISION_USER: "root",
        MASSION_DATABASE_PROVISION_PASSWORD: "owner-password",
      }),
    ).toThrow("provisioning credential");
  });

  it("별도 provisioning은 owner와 runtime 계정을 분리하고 같은 비밀을 거부한다", () => {
    const environment = {
      MASSION_DATABASE_URL: "ws://db:8000/rpc",
      MASSION_DATABASE_NAMESPACE: "massion",
      MASSION_DATABASE_NAME: "massion",
      MASSION_DATABASE_PROVISION_USER: "root",
      MASSION_DATABASE_PROVISION_PASSWORD: "owner-password",
      MASSION_DATABASE_USER: "massion_runtime",
      MASSION_DATABASE_PASSWORD: "runtime-password",
    };
    expect(parseDatabaseProvisionConfig(environment)).toMatchObject({
      owner: { username: "root", password: "owner-password" },
      runtime: { username: "massion_runtime", password: "runtime-password" },
    });
    expect(() => parseDatabaseProvisionConfig({ ...environment, MASSION_DATABASE_PASSWORD: "owner-password" })).toThrow(
      "서로 다른 password",
    );
  });

  it("짧거나 잘못 인코딩된 key와 team embedded DB를 거부한다", () => {
    expect(() => parseServerConfig({ MASSION_TOKEN_KEY: "short" })).toThrow("32 byte");
    expect(() =>
      parseServerConfig({
        MASSION_MODE: "team",
        MASSION_TOKEN_KEY: key,
        MASSION_REGISTRY_KEY: key,
        MASSION_REGISTRY_PUBLIC_URL: "https://massion.example.com",
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
      const credentialPath = join(directory, "credential-key");
      await writeFile(credentialPath, credentialKey, { mode: 0o600 });
      await expect(
        loadServerConfig({ MASSION_TOKEN_KEY_FILE: path, MASSION_CREDENTIAL_KEY_FILE: credentialPath }),
      ).resolves.toMatchObject({
        tokenKey: { key: Buffer.alloc(32, 7) },
        credentialKey: Buffer.alloc(32, 8),
      });
      await expect(
        loadServerConfig({
          MASSION_TOKEN_KEY: key,
          MASSION_TOKEN_KEY_FILE: path,
          MASSION_CREDENTIAL_KEY: credentialKey,
        }),
      ).rejects.toThrow("동시에");
      await chmod(path, 0o644);
      await expect(
        loadServerConfig({ MASSION_TOKEN_KEY_FILE: path, MASSION_CREDENTIAL_KEY_FILE: credentialPath }),
      ).rejects.toThrow("owner-only");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("provisioning secret file 두 개를 owner-only로 읽는다", async () => {
    const directory = await mkdtemp(join(tmpdir(), "massion-provision-config-"));
    const ownerPath = join(directory, "owner-password");
    const runtimePath = join(directory, "runtime-password");
    try {
      await writeFile(ownerPath, "owner-password", { mode: 0o600 });
      await writeFile(runtimePath, "runtime-password", { mode: 0o600 });
      await expect(
        loadDatabaseProvisionConfig({
          MASSION_DATABASE_URL: "ws://db:8000/rpc",
          MASSION_DATABASE_PROVISION_USER: "root",
          MASSION_DATABASE_PROVISION_PASSWORD_FILE: ownerPath,
          MASSION_DATABASE_USER: "massion_runtime",
          MASSION_DATABASE_PASSWORD_FILE: runtimePath,
        }),
      ).resolves.toMatchObject({
        owner: { username: "root", password: "owner-password" },
        runtime: { username: "massion_runtime", password: "runtime-password" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
