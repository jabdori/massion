import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, openSync } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  attestLocalSurrealRuntime,
  LocalSurrealRuntimeManager,
  resolveLocalSurrealRuntime,
  type LocalSurrealRuntimeState,
} from "./local-surreal-runtime.js";

export interface LocalPaths {
  readonly configDirectory: string;
  readonly dataDirectory: string;
  readonly stateDirectory: string;
  readonly backupDirectory: string;
  readonly softwareWorkspaceDirectory: string;
  readonly connectorDirectory: string;
  readonly tokenKey: string;
  readonly credentialKey: string;
  readonly databasePassword: string;
  readonly pidFile: string;
  readonly logFile: string;
  readonly surrealPidFile: string;
  readonly surrealLogFile: string;
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

interface LocalSurrealRuntimeController {
  start(): Promise<{
    readonly status: "started" | "already-running";
    readonly pid: number;
    readonly endpoint: string;
  }>;
  stop(): Promise<{ readonly status: "stopped" | "already-stopped"; readonly pid?: number }>;
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
    options: {
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly stdout: number;
      readonly stderr: number;
    },
  ) => SpawnedProcess;
  readonly surrealRuntime?: LocalSurrealRuntimeController;
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
    softwareWorkspaceDirectory: join(dataDirectory, "workspaces"),
    connectorDirectory: join(dataDirectory, "connectors"),
    tokenKey: join(configDirectory, "token-key"),
    credentialKey: join(configDirectory, "credential-key"),
    databasePassword: join(configDirectory, "database-password"),
    pidFile: join(stateDirectory, "server.json"),
    logFile: join(stateDirectory, "server.log"),
    surrealPidFile: join(stateDirectory, "surrealdb.json"),
    surrealLogFile: join(stateDirectory, "surrealdb.log"),
  };
}

async function ensureDirectories(paths: LocalPaths): Promise<void> {
  await Promise.all(
    [
      paths.configDirectory,
      paths.dataDirectory,
      paths.stateDirectory,
      paths.backupDirectory,
      paths.softwareWorkspaceDirectory,
      paths.connectorDirectory,
    ].map(async (path) => {
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

export async function ensureLocalCredentialKey(paths: LocalPaths): Promise<string> {
  await ensureDirectories(paths);
  try {
    const metadata = await stat(paths.credentialKey);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
      throw new Error("local credential key는 owner-only여야 합니다");
    const value = (await readFile(paths.credentialKey, "utf8")).trim();
    if (Buffer.from(value, "base64url").length !== 32) throw new Error("local credential key가 유효하지 않습니다");
    return value;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const value = randomBytes(32).toString("base64url");
  try {
    await writeFile(paths.credentialKey, `${value}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    return await ensureLocalCredentialKey(paths);
  }
  return value;
}

export async function ensureLocalDatabasePassword(paths: LocalPaths): Promise<string> {
  await ensureDirectories(paths);
  try {
    const metadata = await stat(paths.databasePassword);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
      throw new Error("local SurrealDB password는 owner-only여야 합니다");
    const value = (await readFile(paths.databasePassword, "utf8")).trim();
    if (Buffer.from(value, "base64url").length !== 32) throw new Error("local SurrealDB password가 유효하지 않습니다");
    return value;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const value = randomBytes(32).toString("base64url");
  try {
    await writeFile(paths.databasePassword, `${value}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    return await ensureLocalDatabasePassword(paths);
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

interface LocalSurrealPidRecord extends LocalSurrealRuntimeState {
  readonly schema: "massion.local-surrealdb.v1";
}

function validateSurrealPidRecord(value: unknown): LocalSurrealRuntimeState {
  if (
    !value ||
    typeof value !== "object" ||
    !("schema" in value) ||
    value.schema !== "massion.local-surrealdb.v1" ||
    !("pid" in value) ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) < 1 ||
    !("endpoint" in value) ||
    typeof value.endpoint !== "string" ||
    !("executable" in value) ||
    typeof value.executable !== "string" ||
    !isAbsolute(value.executable) ||
    !("startedAt" in value) ||
    typeof value.startedAt !== "string"
  )
    throw new Error("local SurrealDB process state가 유효하지 않습니다");
  return value as LocalSurrealPidRecord;
}

async function readSurrealPidRecord(path: string): Promise<LocalSurrealRuntimeState | undefined> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
      throw new Error("local SurrealDB process state는 owner-only여야 합니다");
    return validateSurrealPidRecord(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeSurrealPidRecord(path: string, state: LocalSurrealRuntimeState): Promise<void> {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  const record: LocalSurrealPidRecord = { schema: "massion.local-surrealdb.v1", ...state };
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

function surrealPort(environment: Readonly<Record<string, string | undefined>>): number {
  const value = environment.MASSION_SURREAL_PORT ?? "7330";
  if (!/^[1-9][0-9]{0,4}$/u.test(value) || Number(value) > 65_535)
    throw new Error("MASSION_SURREAL_PORT가 유효하지 않습니다");
  return Number(value);
}

function applicationDatabaseEndpoint(sidecarEndpoint: string): string {
  const endpoint = new URL(sidecarEndpoint);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/")
    throw new Error("local SurrealDB sidecar endpoint가 유효하지 않습니다");
  endpoint.protocol = "ws:";
  return endpoint.toString().replace(/\/$/u, "");
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
  #surrealRuntime: LocalSurrealRuntimeController | undefined;

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
          cwd: options.cwd,
          env: options.env,
          stdio: ["ignore", options.stdout, options.stderr],
        });
        return child;
      });
    this.#surrealRuntime = dependencies.surrealRuntime;
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

  #serverEnvironment(databaseEndpoint: string): NodeJS.ProcessEnv {
    return {
      PATH: this.#environment.PATH,
      HOME: this.#environment.HOME,
      TMPDIR: this.#environment.TMPDIR,
      NODE_ENV: "production",
      MASSION_VERSION: "1.0.0",
      MASSION_MODE: "local",
      MASSION_DATABASE_URL: applicationDatabaseEndpoint(databaseEndpoint),
      MASSION_DATABASE_USER: "massion",
      MASSION_DATABASE_PASSWORD_FILE: this.#paths.databasePassword,
      ...(this.#environment.MASSION_WEB_ROOT === undefined
        ? {}
        : { MASSION_WEB_ROOT: this.#environment.MASSION_WEB_ROOT }),
      MASSION_TOKEN_KEY_FILE: this.#paths.tokenKey,
      MASSION_CREDENTIAL_KEY_FILE: this.#paths.credentialKey,
      MASSION_SOFTWARE_WORKSPACE_ROOT: this.#paths.softwareWorkspaceDirectory,
      MASSION_CONNECTOR_ROOT: this.#paths.connectorDirectory,
      MASSION_EDGE_CONNECTOR_ENABLED: this.#environment.MASSION_EDGE_CONNECTOR_ENABLED ?? "false",
      MASSION_CONNECTOR_HEARTBEAT_MS: this.#environment.MASSION_CONNECTOR_HEARTBEAT_MS ?? "30000",
      MASSION_HTTP_PORT: String(port(this.#environment)),
      MASSION_REGISTRY_PORT: String(port(this.#environment) + 1),
      MASSION_METRICS_PORT: String(port(this.#environment) + 2),
    };
  }

  async #localSurrealRuntime(): Promise<LocalSurrealRuntimeController> {
    if (this.#surrealRuntime) return this.#surrealRuntime;
    const binary = this.#environment.MASSION_SURREAL_BINARY;
    const expectedDigest = this.#environment.MASSION_SURREAL_SHA256;
    if (!binary || !expectedDigest)
      throw new Error("Massion native SurrealDB runtime이 준비되지 않았습니다. 설치를 다시 실행해 주세요");
    if (!isAbsolute(binary)) throw new Error("MASSION_SURREAL_BINARY 절대 경로가 필요합니다");
    const runtime = resolveLocalSurrealRuntime({
      ...(this.#environment.HOME === undefined ? {} : { home: this.#environment.HOME }),
      ...(this.#environment.XDG_DATA_HOME === undefined ? {} : { xdgDataHome: this.#environment.XDG_DATA_HOME }),
    });
    const executable = resolve(binary);
    if (executable !== runtime.binaryPath)
      throw new Error("Massion native SurrealDB runtime 경로가 현재 사용자 data directory와 일치하지 않습니다");
    const sidecarPort = surrealPort(this.#environment);
    if (sidecarPort === port(this.#environment))
      throw new Error("MASSION_SURREAL_PORT와 MASSION_LOCAL_PORT는 달라야 합니다");
    const password = await ensureLocalDatabasePassword(this.#paths);
    const manager = new LocalSurrealRuntimeManager({
      runtime,
      credential: { user: "massion", password },
      port: sidecarPort,
      attest: async () =>
        await attestLocalSurrealRuntime({
          executable,
          expectedDigest,
          runtimeRoot: dirname(executable),
        }),
      prepareDataDirectory: async () => {
        await mkdir(runtime.dataDirectory, { recursive: true, mode: 0o700 });
        const metadata = await stat(runtime.dataDirectory);
        if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0)
          throw new Error("local SurrealDB data directory는 owner-only여야 합니다");
      },
      readState: async () => await readSurrealPidRecord(this.#paths.surrealPidFile),
      writeState: async (state) => await writeSurrealPidRecord(this.#paths.surrealPidFile, state),
      removeState: async () => await rm(this.#paths.surrealPidFile, { force: true }),
      spawn: (command, arguments_, options) => {
        const logDescriptor = openSync(this.#paths.surrealLogFile, "a", 0o600);
        try {
          return spawn(command, [...arguments_], {
            detached: true,
            cwd: options.cwd,
            env: options.env,
            stdio: ["ignore", logDescriptor, logDescriptor],
          });
        } finally {
          closeSync(logDescriptor);
        }
      },
      processExists: this.#processExists,
      processCommand: this.#processCommand,
      ready: async (endpoint) => {
        try {
          return (await this.#fetcher(`${endpoint}/health`, { signal: AbortSignal.timeout(1_000) })).ok;
        } catch {
          return false;
        }
      },
      signal: this.#signal,
      wait: this.#wait,
    });
    this.#surrealRuntime = manager;
    return manager;
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
    await Promise.all([
      ensureLocalTokenKey(this.#paths),
      ensureLocalCredentialKey(this.#paths),
      ensureLocalDatabasePassword(this.#paths),
    ]);
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
    const surrealRuntime = await this.#localSurrealRuntime();
    const database = await surrealRuntime.start();
    const startedSidecar = database.status === "started";
    let child: SpawnedProcess | undefined;
    let record: LocalPidRecord | undefined;
    try {
      const logDescriptor = openSync(this.#paths.logFile, "a", 0o600);
      try {
        child = this.#spawnProcess(process.execPath, [serverScript], {
          cwd: this.#paths.dataDirectory,
          env: this.#serverEnvironment(database.endpoint),
          stdout: logDescriptor,
          stderr: logDescriptor,
        });
        child.unref();
      } finally {
        closeSync(logDescriptor);
      }
      if (!child.pid) throw new Error("local Massion server PID를 받지 못했습니다");
      record = {
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
      throw new Error(`local Massion server가 준비되지 않았습니다. log: ${this.#paths.logFile}`);
    } catch (error) {
      if (record && this.#processExists(record.pid) && (await this.#owned(record))) this.#signal(record.pid, "SIGTERM");
      await rm(this.#paths.pidFile, { force: true });
      if (startedSidecar) await surrealRuntime.stop().catch(() => undefined);
      throw error;
    }
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
    if (record && this.#processExists(record.pid) && !(await this.#owned(record)))
      throw new Error("기록된 PID는 Massion server가 아닙니다");
    const surrealRuntime = await this.#localSurrealRuntime();
    if (!record) {
      await surrealRuntime.stop();
      return { status: "already-stopped" };
    }
    if (!this.#processExists(record.pid)) {
      await rm(this.#paths.pidFile, { force: true });
      await surrealRuntime.stop();
      return { status: "already-stopped", pid: record.pid };
    }
    this.#signal(record.pid, "SIGTERM");
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (!this.#processExists(record.pid)) {
        await rm(this.#paths.pidFile, { force: true });
        await surrealRuntime.stop();
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
    await Promise.all([
      ensureLocalTokenKey(this.#paths),
      ensureLocalCredentialKey(this.#paths),
      ensureLocalDatabasePassword(this.#paths),
    ]);
    const surrealRuntime = await this.#localSurrealRuntime();
    const database = await surrealRuntime.start();
    const startedSidecar = database.status === "started";
    try {
      const code = await new Promise<number | null>((resolveCode, reject) => {
        const child = spawn(process.execPath, [this.#serverScript(), "backup", destination], {
          cwd: this.#paths.dataDirectory,
          env: this.#serverEnvironment(database.endpoint),
          stdio: ["ignore", "ignore", "inherit"],
        });
        child.once("error", reject);
        child.once("close", resolveCode);
      });
      if (code !== 0) throw new Error("local backup이 실패했습니다");
    } finally {
      if (previous.status === "ready" || previous.status === "starting") await this.start();
      else if (startedSidecar) await surrealRuntime.stop();
    }
    return { status: "backed-up", path: destination };
  }
}
