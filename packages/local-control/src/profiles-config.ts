import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CliProfile {
  readonly endpoint: string;
  readonly tokenReference: string;
}
export interface CliConfig {
  readonly schemaVersion: "massion.cli.config.v1";
  readonly selectedProfile: string;
  readonly profiles: Readonly<Record<string, CliProfile>>;
}

export function resolveCliConfigPath(
  input: { readonly platform?: NodeJS.Platform; readonly home?: string; readonly xdgConfigHome?: string } = {},
): string {
  const platform = input.platform ?? process.platform;
  const home = input.home ?? homedir();
  if (platform === "darwin") return join(home, "Library", "Application Support", "Massion", "config.json");
  return join(input.xdgConfigHome ?? process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "massion", "config.json");
}

function validate(config: unknown): CliConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("CLI config는 object여야 합니다");
  const value = config as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !["schemaVersion", "selectedProfile", "profiles"].includes(key)) ||
    value.schemaVersion !== "massion.cli.config.v1" ||
    typeof value.selectedProfile !== "string" ||
    !value.profiles ||
    typeof value.profiles !== "object" ||
    Array.isArray(value.profiles)
  )
    throw new Error("CLI config schema가 유효하지 않습니다");
  const profiles: Record<string, CliProfile> = {};
  for (const [name, candidate] of Object.entries(value.profiles as Record<string, unknown>)) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name) ||
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    )
      throw new Error("CLI profile이 유효하지 않습니다");
    const profile = candidate as Record<string, unknown>;
    if (
      Object.keys(profile).some((key) => !["endpoint", "tokenReference"].includes(key)) ||
      typeof profile.endpoint !== "string" ||
      typeof profile.tokenReference !== "string" ||
      !profile.tokenReference.trim()
    )
      throw new Error("CLI profile field가 유효하지 않습니다");
    const endpoint = new URL(profile.endpoint);
    if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("CLI profile endpoint가 유효하지 않습니다");
    profiles[name] = { endpoint: endpoint.toString().replace(/\/$/u, ""), tokenReference: profile.tokenReference };
  }
  if (!profiles[value.selectedProfile]) throw new Error("selected CLI profile을 찾을 수 없습니다");
  return { schemaVersion: "massion.cli.config.v1", selectedProfile: value.selectedProfile, profiles };
}

export class CliConfigStore {
  public constructor(public readonly path = resolveCliConfigPath()) {}

  public async load(): Promise<CliConfig> {
    const stat = await lstat(this.path);
    if (stat.isSymbolicLink()) throw new Error("CLI config symlink는 허용되지 않습니다");
    if (!stat.isFile()) throw new Error("CLI config는 regular file이어야 합니다");
    if ((stat.mode & 0o077) !== 0) throw new Error("CLI config mode는 0600이어야 합니다");
    return validate(JSON.parse(await readFile(this.path, "utf8")) as unknown);
  }

  public async save(config: CliConfig): Promise<void> {
    const validated = validate(config);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    try {
      await access(this.path, constants.F_OK);
      const stat = await lstat(this.path);
      if (stat.isSymbolicLink()) throw new Error("CLI config symlink는 허용되지 않습니다");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = `${this.path}.${process.pid.toString()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(validated, undefined, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
