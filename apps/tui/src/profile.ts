import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export interface TuiProfile {
  readonly name: string;
  readonly endpoint: string;
  readonly token: string;
}

export function resolveTuiConfigPath(
  input: { readonly home?: string; readonly platform?: NodeJS.Platform } = {},
): string {
  const home = input.home ?? homedir();
  const platform = input.platform ?? process.platform;
  if (platform === "darwin") return join(home, "Library", "Application Support", "Massion", "config.json");
  return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "massion", "config.json");
}

async function secureFile(path: string, label: string): Promise<string> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} symlink는 허용되지 않습니다`);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error(`${label}은 0600 regular file이어야 합니다`);
  return await readFile(path, "utf8");
}

async function token(reference: string, environment: NodeJS.ProcessEnv): Promise<string> {
  if (reference.startsWith("file:")) {
    const value = (await secureFile(reference.slice(5), "token reference file")).trim();
    if (!value) throw new Error("token reference file이 비어 있습니다");
    return value;
  }
  if (reference.startsWith("env:")) {
    const name = reference.slice(4);
    const value = environment[name];
    if (!/^[A-Z][A-Z0-9_]{1,127}$/u.test(name) || !value) throw new Error("token 환경 변수 참조가 유효하지 않습니다");
    return value;
  }
  if (reference.startsWith("keychain:")) {
    const [service, account] = reference.slice(9).split("/", 2);
    if (process.platform !== "darwin" || !service || !account)
      throw new Error("macOS keychain token reference가 유효하지 않습니다");
    const result = await executeFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      { encoding: "utf8", maxBuffer: 64 * 1024 },
    );
    const value = result.stdout.trim();
    if (!value) throw new Error("macOS keychain token을 찾을 수 없습니다");
    return value;
  }
  throw new Error("지원하지 않는 token reference입니다");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}은 object여야 합니다`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label}에 알 수 없는 필드가 있습니다: ${unknown}`);
}

export async function loadTuiProfile(
  input: {
    readonly configPath?: string;
    readonly profile?: string;
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
): Promise<TuiProfile> {
  const source = await secureFile(input.configPath ?? resolveTuiConfigPath(), "TUI config");
  const config = record(JSON.parse(source) as unknown, "TUI config");
  exact(config, ["schemaVersion", "selectedProfile", "profiles"], "TUI config");
  if (config.schemaVersion !== "massion.cli.config.v1" || typeof config.selectedProfile !== "string")
    throw new Error("TUI config schema가 유효하지 않습니다");
  const profiles = record(config.profiles, "profiles");
  const name = input.profile ?? config.selectedProfile;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name)) throw new Error("TUI profile 이름이 유효하지 않습니다");
  const profile = record(profiles[name], "TUI profile");
  exact(profile, ["endpoint", "tokenReference"], "TUI profile");
  if (typeof profile.endpoint !== "string" || typeof profile.tokenReference !== "string")
    throw new Error("TUI profile field가 유효하지 않습니다");
  const endpoint = new URL(profile.endpoint);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("TUI profile endpoint가 유효하지 않습니다");
  if (endpoint.protocol === "http:" && !["127.0.0.1", "::1", "localhost"].includes(endpoint.hostname))
    throw new Error("loopback 밖 TUI endpoint에는 HTTPS가 필요합니다");
  return {
    name,
    endpoint: endpoint.toString().replace(/\/$/u, ""),
    token: await token(profile.tokenReference, input.environment ?? process.env),
  };
}
