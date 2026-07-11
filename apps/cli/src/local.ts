import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, openSync } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface LocalPaths {
  readonly configDirectory: string;
  readonly dataDirectory: string;
  readonly stateDirectory: string;
  readonly backupDirectory: string;
  readonly tokenKey: string;
  readonly pidFile: string;
  readonly logFile: string;
  readonly databaseUrl: string;
}

interface LocalPidRecord {
  readonly schema: "massion.local-process.v1";
  readonly pid: number;
  readonly endpoint: string;
  readonly serverScript: string;
  readonly startedAt: string;
}

interface SpawnedProcess {
  readonly pid?: number | undefined;
  unref(): void;
}

interface LocalDaemonDependencies {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetcher?: typeof fetch;
  readonly processExists?: (pid: number) => boolean;
  readonly processCommand?: (pid: number) => Promise<string>;
  readonly signal?: (pid: number, signal: NodeJS.Signals) => void;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly spawnProcess?: (
    command: string,
    arguments_: readonly string[],
    options: { readonly env: NodeJS.ProcessEnv; readonly stdout: number; readonly stderr: number },
  ) => SpawnedProcess;
}

function directory(
  environment: Readonly<Record<string, string | undefined>>,
  variable: string,
  fallback: string,
): string {
  const value = environment[variable];
  return value ? resolve(value) : fallback;
}

export function resolveLocalPaths(environment: Readonly<Record<string, string | undefined>> = process.env): LocalPaths {
  const home = resolve(environment.HOME ?? homedir());
  const configDirectory = join(directory(environment, "XDG_CONFIG_HOME", join(home, ".config")), "massion");
  const dataDirectory = join(directory(environment, "XDG_DATA_HOME", join(home, ".local", "share")), "massion");
  const stateDirectory = join(directory(environment, "XDG_STATE_HOME", join(home, ".local", "state")), "massion");
  return {
    configDirectory,
    dataDirectory,
    stateDirectory,
    backupDirectory: join(dataDirectory, "backups"),
    tokenKey: join(configDirectory, "token-key"),
    pidFile: join(stateDirectory, "server.json"),
    logFile: join(stateDirectory, "server.log"),
    databaseUrl: `rocksdb://${join(dataDirectory, "massion.db")}`,
  };
}

async function ensureDirectories(paths: LocalPaths): Promise<void> {
  await Promise.all(
    [paths.configDirectory, paths.dataDirectory, paths.stateDirectory, paths.backupDirectory].map(async (path) => {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const metadata = await stat(path);
      if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0)
        throw new Error(`local directory는 owner-only여야 합니다: ${path}`);
    }),
  );
}

export async function ensureLocalTokenKey(paths: LocalPaths): Promise<string> {
  await ensureDirectories(paths);
  try {
    const metadata = await stat(paths.tokenKey);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error("local token key는 owner-only여야 합니다");
    const value = (await readFile(paths.tokenKey, "utf8")).trim();
    if (Buffer.from(value, "base64url").length !== 32) throw new Error("local token key가 유효하지 않습니다");
    return value;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const value = randomBytes(32).toString("base64url");
  try {
    await writeFile(paths.tokenKey, `${value}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    return await ensureLocalTokenKey(paths);
  }
  return value;
}

function validatePidRecord(value: unknown): LocalPidRecord {
  if (
    !value ||
    typeof value !== "object" ||
    !("schema" in value) ||
    value.schema !== "massion.local-process.v1" ||
    !("pid" in value) ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) < 1 ||
    !("endpoint" in value) ||
    typeof value.endpoint !== "string" ||
    !("serverScript" in value) ||
    typeof value.serverScript !== "string" ||
    !("startedAt" in value) ||
    typeof value.startedAt !== "string"
  )
    throw new Error("local process state가 유효하지 않습니다");
  return value as LocalPidRecord;
}

async function readPidRecord(path: string): Promise<LocalPidRecord | undefined> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
      throw new Error("local process state는 owner-only여야 합니다");
    return validatePidRecord(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writePidRecord(path: string, record: LocalPidRecord): Promise<void> {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function defaultProcessCommand(pid: number): Promise<string> {
  if (platform() === "linux") {
    return (await readFile(`/proc/${String(pid)}/cmdline`, "utf8")).replaceAll("\0", " ").trim();
  }
  const child = spawn("ps", ["-ww", "-p", String(pid), "-o", "command="], { stdio: ["ignore", "pipe", "ignore"] });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const code = await new Promise<number | null>((resolveCode) => child.once("close", resolveCode));
  if (code !== 0) throw new Error("local process command를 확인하지 못했습니다");
  return Buffer.concat(chunks).toString("utf8").trim();
}

function port(environment: Readonly<Record<string, string | undefined>>): number {
  const value = environment.MASSION_LOCAL_PORT ?? "7331";
  if (!/^[1-9][0-9]{0,4}$/u.test(value) || Number(value) > 65_535)
    throw new Error("MASSION_LOCAL_PORT가 유효하지 않습니다");
  return Number(value);
}

export class LocalDaemonManager {
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #paths: LocalPaths;
  readonly #fetcher: typeof fetch;
  readonly #processExists: (pid: number) => boolean;
  readonly #processCommand: (pid: number) => Promise<string>;
  readonly #signal: (pid: number, signal: NodeJS.Signals) => void;
  readonly #wait: (milliseconds: number) => Promise<void>;
  readonly #spawnProcess: NonNullable<LocalDaemonDependencies["spawnProcess"]>;

  constructor(dependencies: LocalDaemonDependencies = {}) {
    this.#environment = dependencies.environment ?? process.env;
    this.#paths = resolveLocalPaths(this.#environment);
    this.#fetcher = dependencies.fetcher ?? fetch;
    this.#processExists = dependencies.processExists ?? defaultProcessExists;
    this.#processCommand = dependencies.processCommand ?? defaultProcessCommand;
    this.#signal = dependencies.signal ?? ((pid, signal) => process.kill(pid, signal));
    this.#wait =
      dependencies.wait ??
      (async (milliseconds) => {
        await new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
      });
    this.#spawnProcess =
      dependencies.spawnProcess ??
      ((command, arguments_, options) => {
        const child = spawn(command, [...arguments_], {
          detached: true,
          env: options.env,
          stdio: ["ignore", options.stdout, options.stderr],
        });
        return child;
      });
  }

  #serverScript(): string {
    const value = this.#environment.MASSION_SERVER_BIN;
    if (!value || !isAbsolute(value)) throw new Error("MASSION_SERVER_BIN 절대 경로가 필요합니다");
    return resolve(value);
  }

  async #owned(record: LocalPidRecord): Promise<boolean> {
    if (!this.#processExists(record.pid)) return false;
    const command = await this.#processCommand(record.pid).catch(() => "");
    return command.includes(record.serverScript);
  }

  async #ready(endpoint: string): Promise<boolean> {
    try {
      const response = await this.#fetcher(`${endpoint}/health/ready`, { signal: AbortSignal.timeout(1_000) });
      if (!response.ok) return false;
      const body: unknown = await response.json();
      return Boolean(body && typeof body === "object" && "status" in body && body.status === "ready");
    } catch {
      return false;
    }
  }

  async initializeStateForTest(input: { readonly pid: number; readonly endpoint: string }): Promise<void> {
    await ensureDirectories(this.#paths);
    await writePidRecord(this.#paths.pidFile, {
      schema: "massion.local-process.v1",
      pid: input.pid,
      endpoint: input.endpoint,
      serverScript: this.#serverScript(),
      startedAt: new Date(0).toISOString(),
    });
  }

  async start(): Promise<{
    readonly status: "started" | "already-running";
    readonly pid: number;
    readonly endpoint: string;
  }> {
    await ensureLocalTokenKey(this.#paths);
    const existing = await readPidRecord(this.#paths.pidFile);
    if (existing) {
      if ((await this.#owned(existing)) && (await this.#ready(existing.endpoint)))
        return { status: "already-running", pid: existing.pid, endpoint: existing.endpoint };
      if (this.#processExists(existing.pid)) throw new Error("기록된 PID가 다른 process이므로 덮어쓰지 않습니다");
      await rm(this.#paths.pidFile, { force: true });
    }
    const serverScript = this.#serverScript();
    await access(serverScript, constants.R_OK);
    const localPort = port(this.#environment);
    const endpoint = `http://127.0.0.1:${String(localPort)}`;
    const logDescriptor = openSync(this.#paths.logFile, "a", 0o600);
    let child: SpawnedProcess;
    try {
      child = this.#spawnProcess(process.execPath, [serverScript], {
        env: {
          PATH: this.#environment.PATH,
          HOME: this.#environment.HOME,
          TMPDIR: this.#environment.TMPDIR,
          NODE_ENV: "production",
          MASSION_VERSION: "1.0.0",
          MASSION_MODE: "local",
          MASSION_DATABASE_URL: this.#paths.databaseUrl,
          MASSION_TOKEN_KEY_FILE: this.#paths.tokenKey,
          MASSION_HTTP_PORT: String(localPort),
          MASSION_REGISTRY_PORT: String(localPort + 1),
          MASSION_METRICS_PORT: String(localPort + 2),
        },
        stdout: logDescriptor,
        stderr: logDescriptor,
      });
      child.unref();
    } finally {
      closeSync(logDescriptor);
    }
    if (!child.pid) throw new Error("local Massion server PID를 받지 못했습니다");
    const record: LocalPidRecord = {
      schema: "massion.local-process.v1",
      pid: child.pid,
      endpoint,
      serverScript,
      startedAt: new Date().toISOString(),
    };
    await writePidRecord(this.#paths.pidFile, record);
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (await this.#ready(endpoint)) return { status: "started", pid: child.pid, endpoint };
      if (!this.#processExists(child.pid)) break;
      await this.#wait(250);
    }
    if (this.#processExists(child.pid) && (await this.#owned(record))) this.#signal(child.pid, "SIGTERM");
    await rm(this.#paths.pidFile, { force: true });
    throw new Error(`local Massion server가 준비되지 않았습니다. log: ${this.#paths.logFile}`);
  }

  async status(): Promise<{
    readonly status: "stopped" | "starting" | "ready" | "foreign";
    readonly pid?: number;
    readonly endpoint?: string;
  }> {
    const record = await readPidRecord(this.#paths.pidFile);
    if (!record || !this.#processExists(record.pid)) return { status: "stopped" };
    if (!(await this.#owned(record))) return { status: "foreign", pid: record.pid, endpoint: record.endpoint };
    return {
      status: (await this.#ready(record.endpoint)) ? "ready" : "starting",
      pid: record.pid,
      endpoint: record.endpoint,
    };
  }

  async stop(): Promise<{ readonly status: "stopped" | "already-stopped"; readonly pid?: number }> {
    const record = await readPidRecord(this.#paths.pidFile);
    if (!record) return { status: "already-stopped" };
    if (!this.#processExists(record.pid)) {
      await rm(this.#paths.pidFile, { force: true });
      return { status: "already-stopped", pid: record.pid };
    }
    if (!(await this.#owned(record))) throw new Error("기록된 PID는 Massion server가 아닙니다");
    this.#signal(record.pid, "SIGTERM");
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (!this.#processExists(record.pid)) {
        await rm(this.#paths.pidFile, { force: true });
        return { status: "stopped", pid: record.pid };
      }
      await this.#wait(250);
    }
    throw new Error("local Massion server 정상 종료 시간을 초과했습니다");
  }

  async backup(path?: string): Promise<{ readonly status: "backed-up"; readonly path: string }> {
    const destination =
      path ?? join(this.#paths.backupDirectory, `massion-${new Date().toISOString().replaceAll(/[:.]/gu, "")}.json`);
    if (!isAbsolute(destination)) throw new Error("backup path는 절대 경로여야 합니다");
    const previous = await this.status();
    if (previous.status === "foreign") throw new Error("foreign process 상태에서는 backup할 수 없습니다");
    if (previous.status === "ready" || previous.status === "starting") await this.stop();
    await ensureLocalTokenKey(this.#paths);
    try {
      const code = await new Promise<number | null>((resolveCode, reject) => {
        const child = spawn(process.execPath, [this.#serverScript(), "backup", destination], {
          env: {
            PATH: this.#environment.PATH,
            HOME: this.#environment.HOME,
            TMPDIR: this.#environment.TMPDIR,
            NODE_ENV: "production",
            MASSION_VERSION: "1.0.0",
            MASSION_MODE: "local",
            MASSION_DATABASE_URL: this.#paths.databaseUrl,
            MASSION_TOKEN_KEY_FILE: this.#paths.tokenKey,
          },
          stdio: ["ignore", "ignore", "inherit"],
        });
        child.once("error", reject);
        child.once("close", resolveCode);
      });
      if (code !== 0) throw new Error("local backup이 실패했습니다");
    } finally {
      if (previous.status === "ready" || previous.status === "starting") await this.start();
    }
    return { status: "backed-up", path: destination };
  }
}
