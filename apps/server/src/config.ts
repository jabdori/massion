import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import type { ApplicationHttpServerOptions } from "@massion/application";
import type { DatabaseConfig } from "@massion/storage";

export interface ServerConfig {
  readonly mode: "local" | "team";
  readonly database: DatabaseConfig;
  readonly server: ApplicationHttpServerOptions & { readonly host: string; readonly port: number };
  readonly metrics: { readonly host: string; readonly port: number };
  readonly tokenKey: { readonly keyId: string; readonly key: Buffer };
  readonly registry: {
    readonly host: string;
    readonly port: number;
    readonly publicBaseUrl: string;
    readonly artifactRoot: string;
    readonly tokenKey: Buffer;
  };
  readonly shutdownTimeoutMs: number;
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

export function parseServerConfig(environment: Readonly<Record<string, string | undefined>>): ServerConfig {
  const mode = environment.MASSION_MODE ?? "local";
  if (mode !== "local" && mode !== "team") throw new Error("MASSION_MODE는 local 또는 team이어야 합니다");
  const url = environment.MASSION_DATABASE_URL ?? "rocksdb:///data/massion.db";
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
  const namespace = environment.MASSION_DATABASE_NAMESPACE ?? "massion";
  const database = environment.MASSION_DATABASE_NAME ?? "massion";
  if (![namespace, database].every((name) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name)))
    throw new Error("SurrealDB namespace 또는 database 이름이 유효하지 않습니다");
  const registryPort = integer(environment.MASSION_REGISTRY_PORT, 3142, 1, 65_535, "MASSION_REGISTRY_PORT");
  const registryHost = environment.MASSION_REGISTRY_HOST ?? (mode === "local" ? "127.0.0.1" : "0.0.0.0");
  if (mode === "local" && !new Set(["127.0.0.1", "::1", "localhost"]).has(registryHost))
    throw new Error("local mode Registry host는 loopback이어야 합니다");
  const registrySecret =
    environment.MASSION_REGISTRY_KEY ?? (mode === "local" ? environment.MASSION_TOKEN_KEY : undefined);
  if (!registrySecret) throw new Error("team mode에는 MASSION_REGISTRY_KEY 또는 secret file이 필요합니다");
  const registryKey = tokenKey(registrySecret).key;
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
      ...(username && password ? { authentication: { username, password } } : {}),
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
    tokenKey: tokenKey(environment.MASSION_TOKEN_KEY),
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
