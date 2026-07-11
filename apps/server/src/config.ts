import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type { ApplicationHttpServerOptions } from "@massion/application";
import type { DatabaseConfig } from "@massion/storage";

export interface ServerConfig {
  readonly mode: "local" | "team";
  readonly database: DatabaseConfig;
  readonly server: ApplicationHttpServerOptions & { readonly host: string; readonly port: number };
  readonly metrics: { readonly host: string; readonly port: number };
  readonly tokenKey: { readonly keyId: string; readonly key: Buffer };
  readonly credentialKey: Buffer;
  readonly software: {
    readonly workspaceRoot: string;
    readonly executables: Readonly<Record<string, string>>;
    readonly environmentAllowlist: readonly string[];
  };
  readonly registry: {
    readonly host: string;
    readonly port: number;
    readonly publicBaseUrl: string;
    readonly artifactRoot: string;
    readonly tokenKey: Buffer;
  };
  readonly shutdownTimeoutMs: number;
}

export interface DatabaseProvisionConfig {
  readonly url: string;
  readonly namespace: string;
  readonly database: string;
  readonly owner: { readonly username: string; readonly password: string };
  readonly runtime: { readonly username: string; readonly password: string };
}

const DATABASE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

function databaseLocation(environment: Readonly<Record<string, string | undefined>>): {
  readonly url: string;
  readonly namespace: string;
  readonly database: string;
} {
  const url = environment.MASSION_DATABASE_URL ?? "rocksdb:///data/massion.db";
  const namespace = environment.MASSION_DATABASE_NAMESPACE ?? "massion";
  const database = environment.MASSION_DATABASE_NAME ?? "massion";
  if (![namespace, database].every((name) => DATABASE_IDENTIFIER.test(name)))
    throw new Error("SurrealDB namespace 또는 database 이름이 유효하지 않습니다");
  return { url, namespace, database };
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${label} 정수가 유효하지 않습니다`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(`${label} 범위가 유효하지 않습니다`);
  return parsed;
}

function tokenKey(value: string | undefined): { readonly keyId: string; readonly key: Buffer } {
  if (!value) throw new Error("MASSION_TOKEN_KEY 또는 secret file이 필요합니다");
  const key = Buffer.from(value, "base64url");
  if (key.length < 32) throw new Error("Massion token key는 base64url 32 byte 이상이어야 합니다");
  return { keyId: `key-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`, key };
}

function credentialKey(value: string | undefined): Buffer {
  if (!value) throw new Error("MASSION_CREDENTIAL_KEY 또는 secret file이 필요합니다");
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32) throw new Error("Massion credential key는 base64url 32 byte여야 합니다");
  return key;
}

function proxies(value: string | undefined): readonly string[] {
  if (!value) return [];
  const result = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (result.length > 32 || result.some((item) => item.length > 64 || /[\s/]/u.test(item)))
    throw new Error("MASSION_TRUSTED_PROXIES가 유효하지 않습니다");
  return [...new Set(result)];
}

function softwareExecutables(value: string | undefined): Readonly<Record<string, string>> {
  if (!value) return { node: process.execPath };
  if (value.length > 16_384) throw new Error("Software Delivery executable allowlist JSON이 너무 큽니다");
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Software Delivery executable allowlist JSON이 유효하지 않습니다");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
    throw new Error("Software Delivery executable allowlist는 object여야 합니다");
  const entries = Object.entries(decoded as Record<string, unknown>);
  if (
    entries.length === 0 ||
    entries.length > 32 ||
    entries.some(
      ([name, path]) =>
        !/^[a-z][a-z0-9._-]*$/u.test(name) || typeof path !== "string" || !isAbsolute(path) || path.length > 4096,
    )
  )
    throw new Error("Software Delivery executable allowlist에는 안전한 이름과 절대 경로가 필요합니다");
  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
}

function softwareEnvironmentAllowlist(value: string | undefined): readonly string[] {
  const names = (value ?? "CI,NODE_ENV")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length > 64 || names.some((name) => !/^[A-Z_][A-Z0-9_]*$/u.test(name)))
    throw new Error("Software Delivery environment allowlist가 유효하지 않습니다");
  return [...new Set(names)];
}

export function parseServerConfig(environment: Readonly<Record<string, string | undefined>>): ServerConfig {
  const mode = environment.MASSION_MODE ?? "local";
  if (mode !== "local" && mode !== "team") throw new Error("MASSION_MODE는 local 또는 team이어야 합니다");
  const { url, namespace, database } = databaseLocation(environment);
  const protocol = new URL(url).protocol;
  if (mode === "team" && !new Set(["ws:", "wss:", "http:", "https:"]).has(protocol))
    throw new Error("team mode에는 remote SurrealDB URL이 필요합니다");
  const host = environment.MASSION_HTTP_HOST ?? (mode === "local" ? "127.0.0.1" : "0.0.0.0");
  const trustedProxyAddresses = proxies(environment.MASSION_TRUSTED_PROXIES);
  if (mode === "local" && !new Set(["127.0.0.1", "::1", "localhost"]).has(host))
    throw new Error("local mode HTTP host는 loopback이어야 합니다");
  if (mode === "team" && trustedProxyAddresses.length === 0)
    throw new Error("team mode에는 trusted proxy allowlist가 필요합니다");
  const username = environment.MASSION_DATABASE_USER;
  const password = environment.MASSION_DATABASE_PASSWORD;
  if ((username === undefined) !== (password === undefined))
    throw new Error("SurrealDB username과 password는 함께 구성해야 합니다");
  if (username && !DATABASE_IDENTIFIER.test(username)) throw new Error("SurrealDB username이 유효하지 않습니다");
  if (mode === "team" && (!username || !password)) throw new Error("team mode에는 runtime SurrealDB 계정이 필요합니다");
  if (environment.MASSION_DATABASE_PROVISION_USER || environment.MASSION_DATABASE_PROVISION_PASSWORD)
    throw new Error("API server에는 provisioning credential을 구성할 수 없습니다");
  const registryPort = integer(environment.MASSION_REGISTRY_PORT, 3142, 1, 65_535, "MASSION_REGISTRY_PORT");
  const registryHost = environment.MASSION_REGISTRY_HOST ?? (mode === "local" ? "127.0.0.1" : "0.0.0.0");
  if (mode === "local" && !new Set(["127.0.0.1", "::1", "localhost"]).has(registryHost))
    throw new Error("local mode Registry host는 loopback이어야 합니다");
  const registrySecret =
    environment.MASSION_REGISTRY_KEY ?? (mode === "local" ? environment.MASSION_TOKEN_KEY : undefined);
  if (!registrySecret) throw new Error("team mode에는 MASSION_REGISTRY_KEY 또는 secret file이 필요합니다");
  const registryKey = tokenKey(registrySecret).key;
  const parsedTokenKey = tokenKey(environment.MASSION_TOKEN_KEY);
  const parsedCredentialKey = credentialKey(environment.MASSION_CREDENTIAL_KEY);
  if (parsedTokenKey.key.equals(parsedCredentialKey))
    throw new Error("접근 token과 provider credential에는 서로 다른 key가 필요합니다");
  const softwareWorkspaceRoot = environment.MASSION_SOFTWARE_WORKSPACE_ROOT ?? "/var/lib/massion/workspaces";
  if (!isAbsolute(softwareWorkspaceRoot)) throw new Error("Software Delivery workspace root는 절대 경로여야 합니다");
  const publicBaseUrl = environment.MASSION_REGISTRY_PUBLIC_URL ?? `http://${registryHost}:${String(registryPort)}`;
  const parsedPublicUrl = new URL(publicBaseUrl);
  const publicLoopback = new Set(["127.0.0.1", "::1", "localhost"]).has(parsedPublicUrl.hostname);
  if (
    parsedPublicUrl.protocol !== "https:" &&
    !(mode === "local" && publicLoopback && parsedPublicUrl.protocol === "http:")
  )
    throw new Error("Registry public URL은 team HTTPS 또는 local loopback HTTP여야 합니다");
  return {
    mode,
    database: {
      url,
      namespace,
      database,
      ...(username && password ? { authentication: { username, password, scope: "database" as const } } : {}),
    },
    server: {
      host,
      port: integer(environment.MASSION_HTTP_PORT, 3141, 1, 65_535, "MASSION_HTTP_PORT"),
      ...(trustedProxyAddresses.length === 0 ? {} : { trustedProxyAddresses }),
    },
    metrics: {
      host: environment.MASSION_METRICS_HOST ?? (mode === "local" ? "127.0.0.1" : "0.0.0.0"),
      port: integer(environment.MASSION_METRICS_PORT, 9464, 1, 65_535, "MASSION_METRICS_PORT"),
    },
    tokenKey: parsedTokenKey,
    credentialKey: parsedCredentialKey,
    software: {
      workspaceRoot: softwareWorkspaceRoot,
      executables: softwareExecutables(environment.MASSION_SOFTWARE_EXECUTABLES),
      environmentAllowlist: softwareEnvironmentAllowlist(environment.MASSION_SOFTWARE_ENVIRONMENT_ALLOWLIST),
    },
    registry: {
      host: registryHost,
      port: registryPort,
      publicBaseUrl,
      artifactRoot: environment.MASSION_REGISTRY_ARTIFACT_ROOT ?? "/var/lib/massion/registry",
      tokenKey: registryKey,
    },
    shutdownTimeoutMs: integer(environment.MASSION_SHUTDOWN_TIMEOUT_MS, 30_000, 1_000, 300_000, "shutdown timeout"),
  };
}

export function parseDatabaseProvisionConfig(
  environment: Readonly<Record<string, string | undefined>>,
): DatabaseProvisionConfig {
  const location = databaseLocation(environment);
  if (!new Set(["ws:", "wss:", "http:", "https:"]).has(new URL(location.url).protocol))
    throw new Error("database provisioning에는 remote SurrealDB URL이 필요합니다");
  const owner = {
    username: environment.MASSION_DATABASE_PROVISION_USER ?? "",
    password: environment.MASSION_DATABASE_PROVISION_PASSWORD ?? "",
  };
  const runtime = {
    username: environment.MASSION_DATABASE_USER ?? "",
    password: environment.MASSION_DATABASE_PASSWORD ?? "",
  };
  if (!owner.username || !owner.password || !runtime.username || !runtime.password)
    throw new Error("database provisioning에는 owner와 runtime 계정이 모두 필요합니다");
  if (![owner.username, runtime.username].every((username) => DATABASE_IDENTIFIER.test(username)))
    throw new Error("SurrealDB username이 유효하지 않습니다");
  if (owner.username === runtime.username) throw new Error("owner와 runtime은 서로 다른 username이어야 합니다");
  if (owner.password === runtime.password) throw new Error("owner와 runtime은 서로 다른 password여야 합니다");
  return { ...location, owner, runtime };
}

async function secretFile(path: string): Promise<string> {
  const metadata = await stat(path);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
    throw new Error("secret file은 owner-only regular file이어야 합니다");
  if (metadata.size < 1 || metadata.size > 4096) throw new Error("secret file byte 길이가 유효하지 않습니다");
  return (await readFile(path, "utf8")).trim();
}

export async function loadServerConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ServerConfig> {
  const resolved = { ...environment };
  const references = [
    ["MASSION_TOKEN_KEY", "MASSION_TOKEN_KEY_FILE"],
    ["MASSION_CREDENTIAL_KEY", "MASSION_CREDENTIAL_KEY_FILE"],
    ["MASSION_DATABASE_PASSWORD", "MASSION_DATABASE_PASSWORD_FILE"],
    ["MASSION_REGISTRY_KEY", "MASSION_REGISTRY_KEY_FILE"],
  ] as const;
  for (const [valueName, fileName] of references) {
    const value = environment[valueName];
    const path = environment[fileName];
    if (value && path) throw new Error(`${valueName}과 ${fileName}은 동시에 사용할 수 없습니다`);
    if (path) resolved[valueName] = await secretFile(path);
    resolved[fileName] = undefined;
  }
  return parseServerConfig(resolved);
}

export async function loadDatabaseProvisionConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<DatabaseProvisionConfig> {
  const resolved = { ...environment };
  const references = [
    ["MASSION_DATABASE_PROVISION_PASSWORD", "MASSION_DATABASE_PROVISION_PASSWORD_FILE"],
    ["MASSION_DATABASE_PASSWORD", "MASSION_DATABASE_PASSWORD_FILE"],
  ] as const;
  for (const [valueName, fileName] of references) {
    const value = environment[valueName];
    const path = environment[fileName];
    if (value && path) throw new Error(`${valueName}과 ${fileName}은 동시에 사용할 수 없습니다`);
    if (path) resolved[valueName] = await secretFile(path);
    resolved[fileName] = undefined;
  }
  return parseDatabaseProvisionConfig(resolved);
}
