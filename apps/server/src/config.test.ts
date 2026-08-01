import {
  chmod,
  link,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it, vi } from "vitest";

import {
  loadDatabaseRestoreConfig,
  loadDatabaseProvisionConfig,
  loadServerConfig,
  parseDatabaseRestoreConfig,
  parseDatabaseProvisionConfig,
  parseServerConfig,
} from "./config.js";
import { loadBootstrapCapabilityFile } from "./bootstrap-capability.js";

const key = Buffer.alloc(32, 7).toString("base64url");
const credentialKey = Buffer.alloc(32, 8).toString("base64url");

describe("server configuration", () => {
  it("개인 local mode는 loopback과 owner-only key로 구성한다", () => {
    expect(parseServerConfig({ MASSION_TOKEN_KEY: key, MASSION_CREDENTIAL_KEY: credentialKey })).toMatchObject({
      mode: "local",
      database: { url: "ws://127.0.0.1:7330", namespace: "massion", database: "massion" },
      server: { host: "127.0.0.1", port: 3141 },
      registry: { host: "127.0.0.1", port: 3142, publicBaseUrl: "http://127.0.0.1:3142" },
      credentialKey: Buffer.alloc(32, 8),
      software: { workspaceRoot: "/var/lib/massion/workspaces", executables: { node: process.execPath } },
      connectors: {
        root: "/var/lib/massion/connectors",
        executables: {},
        edgeEnabled: false,
        heartbeatMs: 30_000,
      },
    });
  });

  it("개인 local sidecar credential은 loopback 내부 root 인증으로 연결한다", () => {
    expect(
      parseServerConfig({
        MASSION_TOKEN_KEY: key,
        MASSION_CREDENTIAL_KEY: credentialKey,
        MASSION_DATABASE_USER: "massion",
        MASSION_DATABASE_PASSWORD: "local-sidecar-password",
      }).database,
    ).toMatchObject({
      url: "ws://127.0.0.1:7330",
      authentication: { username: "massion", password: "local-sidecar-password", scope: "root" },
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

  it("Connector root·실행 파일·Edge 수신·heartbeat 설정을 엄격하게 검증한다", () => {
    const base = { MASSION_TOKEN_KEY: key, MASSION_CREDENTIAL_KEY: credentialKey };
    expect(
      parseServerConfig({
        ...base,
        MASSION_CONNECTOR_ROOT: "/srv/massion/connectors",
        MASSION_CONNECTOR_EXECUTABLES: JSON.stringify({ codex: "/opt/massion/codex", claude: "/opt/massion/claude" }),
        MASSION_EDGE_CONNECTOR_ENABLED: "true",
        MASSION_CONNECTOR_HEARTBEAT_MS: "45000",
      }).connectors,
    ).toEqual({
      root: "/srv/massion/connectors",
      executables: { codex: "/opt/massion/codex", claude: "/opt/massion/claude" },
      edgeEnabled: true,
      heartbeatMs: 45_000,
    });
    expect(() => parseServerConfig({ ...base, MASSION_CONNECTOR_ROOT: "relative" })).toThrow("Connector root");
    expect(() =>
      parseServerConfig({ ...base, MASSION_CONNECTOR_EXECUTABLES: JSON.stringify({ codex: "codex" }) }),
    ).toThrow("절대 경로");
    expect(() => parseServerConfig({ ...base, MASSION_EDGE_CONNECTOR_ENABLED: "yes" })).toThrow("true 또는 false");
    expect(() => parseServerConfig({ ...base, MASSION_CONNECTOR_HEARTBEAT_MS: "999" })).toThrow("범위");
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

  it("restore는 원격 DB에서 owner 인증을 사용하고 runtime 계정과 분리한다", () => {
    expect(
      parseDatabaseRestoreConfig({
        MASSION_DATABASE_URL: "ws://db:8000/rpc",
        MASSION_DATABASE_NAMESPACE: "massion",
        MASSION_DATABASE_NAME: "massion_restore",
        MASSION_DATABASE_PROVISION_USER: "root",
        MASSION_DATABASE_PROVISION_PASSWORD: "owner-password",
        MASSION_DATABASE_USER: "massion_runtime",
        MASSION_DATABASE_PASSWORD: "runtime-password",
      }),
    ).toMatchObject({
      url: "ws://db:8000/rpc",
      namespace: "massion",
      database: "massion_restore",
      authentication: { username: "root", password: "owner-password", scope: "root" },
    });
    expect(() =>
      parseDatabaseRestoreConfig({
        MASSION_DATABASE_URL: "ws://db:8000/rpc",
        MASSION_DATABASE_NAMESPACE: "massion",
        MASSION_DATABASE_NAME: "massion_restore",
      }),
    ).toThrow("owner restore credential");
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

  it("일반 server config에는 bootstrap 비밀 byte가 아니라 전용 파일 경로만 보관된다", async () => {
    const directory = await mkdtemp(join(tmpdir(), "massion-bootstrap-config-"));
    const tokenPath = join(directory, "token-key");
    const credentialPath = join(directory, "credential-key");
    const capabilityPath = join(directory, "bootstrap-capability");
    const capability = Buffer.alloc(32, 9);
    try {
      await writeFile(tokenPath, key, { mode: 0o600 });
      await writeFile(credentialPath, credentialKey, { mode: 0o600 });
      await writeFile(capabilityPath, capability, { mode: 0o600 });

      const config = await loadServerConfig({
        MASSION_TOKEN_KEY_FILE: tokenPath,
        MASSION_CREDENTIAL_KEY_FILE: credentialPath,
        MASSION_BOOTSTRAP_CAPABILITY_FILE: capabilityPath,
      });

      expect(config.bootstrapCapabilityFile).toBe(capabilityPath);
      const serialized = JSON.stringify(config);
      expect(serialized).not.toContain('"type":"Buffer","data":[9,9,9');
      expect(serialized).not.toContain(capability.toString("base64url"));
      await expect(stat(capabilityPath)).resolves.toMatchObject({ size: 32 });
      await expect(
        loadServerConfig({
          MASSION_TOKEN_KEY: key,
          MASSION_CREDENTIAL_KEY: credentialKey,
          MASSION_BOOTSTRAP_CAPABILITY: capability.toString("base64url"),
        }),
      ).rejects.toThrow("평문");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bootstrap capability 파일은 fd로 검증하고 APFS 소수 mtime을 안전한 정수 만료 시각으로 정규화한다", async () => {
    const directory = await mkdtemp(join(tmpdir(), "massion-bootstrap-fd-"));
    const capabilityPath = join(await realpath(directory), "instance.cap");
    const bytes = Buffer.alloc(32, 21);
    try {
      await chmod(directory, 0o700);
      await writeFile(capabilityPath, bytes, { mode: 0o600, flag: "wx" });
      const fractionalSeconds = Date.now() / 1_000 - 0.123_456;
      await utimes(capabilityPath, fractionalSeconds, fractionalSeconds);

      const owner = await loadBootstrapCapabilityFile(capabilityPath);
      expect(JSON.stringify(owner)).toBe("{}");
      expect(owner.expiresAtForDiagnostics()).toSatisfy(Number.isSafeInteger);
      await owner.close();
      await expect(stat(capabilityPath)).resolves.toMatchObject({ size: 0 });
    } finally {
      bytes.fill(0);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["parent-mode", "file-mode", "symlink", "hardlink", "uid", "replace-race"])(
    "bootstrap capability 파일 신뢰 위반(%s)을 fail-closed한다",
    async (violation) => {
      const directory = await mkdtemp(join(tmpdir(), "massion-bootstrap-untrusted-"));
      const canonicalDirectory = await realpath(directory);
      const capabilityPath = join(canonicalDirectory, "instance.cap");
      const replacementPath = join(canonicalDirectory, "replacement.cap");
      const bytes = Buffer.alloc(32, 22);
      try {
        await chmod(directory, 0o700);
        await writeFile(capabilityPath, bytes, { mode: 0o600, flag: "wx" });
        let options: Parameters<typeof loadBootstrapCapabilityFile>[1] = {};
        if (violation === "parent-mode") await chmod(directory, 0o755);
        if (violation === "file-mode") await chmod(capabilityPath, 0o644);
        if (violation === "symlink") {
          await rename(capabilityPath, replacementPath);
          await symlink(replacementPath, capabilityPath);
        }
        if (violation === "hardlink") await link(capabilityPath, replacementPath);
        if (violation === "uid") options = { currentUid: (process.getuid?.() ?? 1_000) + 1 };
        if (violation === "replace-race") {
          options = {
            afterRead: async () => {
              await rename(capabilityPath, replacementPath);
              await writeFile(capabilityPath, Buffer.alloc(32, 23), { mode: 0o600, flag: "wx" });
            },
          };
        }

        await expect(loadBootstrapCapabilityFile(capabilityPath, options)).rejects.toThrow("신뢰");
      } finally {
        bytes.fill(0);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["replacement", "symlink", "hardlink"] as const)(
    "bootstrap cleanup의 %s barrier race가 다른 파일을 변경하거나 삭제하지 않는다",
    async (race) => {
      const directory = await mkdtemp(join(tmpdir(), "massion-bootstrap-cleanup-race-"));
      const canonicalDirectory = await realpath(directory);
      const capabilityPath = join(canonicalDirectory, "instance.cap");
      const movedPath = join(canonicalDirectory, "moved.cap");
      const targetPath = join(canonicalDirectory, "target.cap");
      const cleanupError = vi.fn();
      let enteredCleanup: (() => void) | undefined;
      const entered = new Promise<void>((resolve) => {
        enteredCleanup = resolve;
      });
      let releaseCleanup: (() => void) | undefined;
      const release = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      try {
        await chmod(directory, 0o700);
        await writeFile(capabilityPath, Buffer.alloc(32, 24), { mode: 0o600, flag: "wx" });
        const owner = await loadBootstrapCapabilityFile(capabilityPath, {
          onCleanupError: cleanupError,
          beforeCleanup: async () => {
            enteredCleanup?.();
            await release;
          },
        });

        const closing = owner.close();
        const reached = await Promise.race([entered.then(() => true), delay(100).then(() => false)]);
        if (!reached) {
          await closing;
          expect(reached).toBe(true);
          return;
        }
        if (race === "replacement") {
          await rename(capabilityPath, movedPath);
          await writeFile(capabilityPath, Buffer.alloc(32, 25), { mode: 0o600, flag: "wx" });
        } else if (race === "symlink") {
          await rename(capabilityPath, movedPath);
          await writeFile(targetPath, Buffer.alloc(32, 26), { mode: 0o600, flag: "wx" });
          await symlink(targetPath, capabilityPath);
        } else {
          await link(capabilityPath, movedPath);
        }
        releaseCleanup?.();
        await closing;

        if (race === "hardlink") {
          expect(await readFile(capabilityPath)).toEqual(Buffer.alloc(32, 24));
          expect(await readFile(movedPath)).toEqual(Buffer.alloc(32, 24));
          expect(cleanupError).toHaveBeenCalledWith("closed");
        } else {
          expect(await readFile(capabilityPath)).toEqual(Buffer.alloc(32, race === "replacement" ? 25 : 26));
          await expect(stat(movedPath)).resolves.toMatchObject({ size: 0 });
          expect(cleanupError).not.toHaveBeenCalled();
        }
      } finally {
        releaseCleanup?.();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

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

  it("restore는 provisioning owner secret file을 읽고 runtime secret을 요구하지 않는다", async () => {
    const directory = await mkdtemp(join(tmpdir(), "massion-restore-config-"));
    const ownerPath = join(directory, "owner-password");
    try {
      await writeFile(ownerPath, "owner-password", { mode: 0o600 });
      await expect(
        loadDatabaseRestoreConfig({
          MASSION_DATABASE_URL: "ws://db:8000/rpc",
          MASSION_DATABASE_PROVISION_USER: "root",
          MASSION_DATABASE_PROVISION_PASSWORD_FILE: ownerPath,
          MASSION_DATABASE_NAME: "massion_restore",
        }),
      ).resolves.toMatchObject({
        authentication: { username: "root", password: "owner-password", scope: "root" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
