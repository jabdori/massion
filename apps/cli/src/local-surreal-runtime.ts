import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const LOCAL_SURREAL_VERSION = "3.2.1";
const MAXIMUM_RUNTIME_BYTES = 1024 * 1024 * 1024;
const VERSION = /(?:^|[^0-9])(?:surreal(?:db)?\s+)?v?(3\.2\.1)(?=$|[^0-9A-Za-z.+-])/iu;

export interface LocalSurrealRuntime {
  readonly version: typeof LOCAL_SURREAL_VERSION;
  readonly platform: "darwin-arm64" | "darwin-amd64" | "linux-arm64" | "linux-amd64";
  readonly binaryPath: string;
  readonly dataDirectory: string;
}

export interface LocalSurrealRuntimeAttestation {
  readonly executable: string;
  readonly digest: string;
  readonly version: typeof LOCAL_SURREAL_VERSION;
}

export interface LocalSurrealRuntimeDependencies {
  readonly runVersion?: (
    executable: string,
    arguments_: readonly string[],
    environment: Readonly<Record<string, string>>,
  ) => Promise<{ readonly stdout: string }>;
}

export interface LocalSurrealRuntimeState {
  readonly pid: number;
  readonly endpoint: string;
  readonly executable: string;
  readonly startedAt: string;
}

interface LocalSurrealRuntimeProcess {
  readonly pid?: number | undefined;
  unref(): void;
}

export interface LocalSurrealRuntimeManagerDependencies {
  readonly runtime: Pick<LocalSurrealRuntime, "binaryPath" | "dataDirectory">;
  readonly credential: { readonly user: string; readonly password: string };
  readonly port: number;
  readonly attest: () => Promise<LocalSurrealRuntimeAttestation>;
  readonly prepareDataDirectory: () => Promise<void>;
  readonly readState: () => Promise<LocalSurrealRuntimeState | undefined>;
  readonly writeState: (state: LocalSurrealRuntimeState) => Promise<void>;
  readonly removeState: () => Promise<void>;
  readonly spawn: (
    command: string,
    arguments_: readonly string[],
    options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
  ) => LocalSurrealRuntimeProcess;
  readonly processExists: (pid: number) => boolean;
  readonly processCommand: (pid: number) => Promise<string>;
  readonly ready: (endpoint: string) => Promise<boolean>;
  readonly provision: (endpoint: string) => Promise<void>;
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  readonly wait: (milliseconds: number) => Promise<void>;
}

const START_ATTEMPTS = 120;
const START_INTERVAL_MS = 250;

function runtimePlatform(input: {
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
}): LocalSurrealRuntime["platform"] {
  const operatingSystem = input.platform === "darwin" ? "darwin" : input.platform === "linux" ? "linux" : undefined;
  const architecture = input.architecture === "arm64" ? "arm64" : input.architecture === "x64" ? "amd64" : undefined;
  if (!operatingSystem || !architecture)
    throw new Error("현재 운영체제 또는 CPU architecture는 local SurrealDB runtime을 지원하지 않습니다");
  return `${operatingSystem}-${architecture}`;
}

/** macOS의 시스템 경로 별칭만 허용하고, 그 밖의 상위 symlink는 runtime 경계 밖으로 봅니다. */
function expectedCanonicalPath(path: string): string {
  const resolved = resolve(path);
  if (process.platform !== "darwin") return resolved;
  for (const alias of ["/var", "/tmp"]) {
    if (resolved === alias || resolved.startsWith(`${alias}${sep}`)) return resolve("/private", resolved.slice(1));
  }
  return resolved;
}

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export function resolveLocalSurrealRuntime(
  input: {
    readonly home?: string;
    readonly xdgDataHome?: string;
    readonly platform?: NodeJS.Platform;
    readonly architecture?: string;
  } = {},
): LocalSurrealRuntime {
  const home = resolve(input.home ?? homedir());
  const dataHome = resolve(input.xdgDataHome ?? process.env.XDG_DATA_HOME ?? join(home, ".local", "share"));
  const massionData = join(dataHome, "massion");
  const platform = runtimePlatform({
    platform: input.platform ?? process.platform,
    architecture: input.architecture ?? process.arch,
  });
  return {
    version: LOCAL_SURREAL_VERSION,
    platform,
    binaryPath: join(massionData, "runtime", "surrealdb", LOCAL_SURREAL_VERSION, platform, "surreal"),
    dataDirectory: join(massionData, "surrealdb", "3", "database"),
  };
}

async function secureRuntimeRoot(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("local SurrealDB runtime root는 절대 경로여야 합니다");
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("local SurrealDB runtime root는 symlink가 아닌 directory여야 합니다");
  }
  if ((metadata.mode & 0o077) !== 0) throw new Error("local SurrealDB runtime root는 owner-only여야 합니다");
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("local SurrealDB runtime root는 현재 사용자 소유여야 합니다");
  }
  const canonical = await realpath(path);
  if (canonical !== expectedCanonicalPath(path)) {
    throw new Error("local SurrealDB runtime root에 symlink 경로를 사용할 수 없습니다");
  }
  return canonical;
}

async function executableFile(path: string, root: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("local SurrealDB 실행 파일은 절대 경로여야 합니다");
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("local SurrealDB 실행 파일은 symlink가 아닌 regular file이어야 합니다");
  }
  if ((metadata.mode & 0o111) === 0) throw new Error("local SurrealDB 실행 파일에 실행 권한이 필요합니다");
  if (metadata.size <= 0 || metadata.size > MAXIMUM_RUNTIME_BYTES) {
    throw new Error("local SurrealDB 실행 파일 크기가 유효하지 않습니다");
  }
  const canonical = await realpath(path);
  if (canonical !== expectedCanonicalPath(path) || !within(root, canonical)) {
    throw new Error("local SurrealDB 실행 파일에 symlink 또는 runtime 밖 경로를 사용할 수 없습니다");
  }
  return canonical;
}

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function defaultRunVersion(
  executable: string,
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<{ readonly stdout: string }> {
  const result = await executeFile(executable, [...arguments_], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    env: { ...environment },
  });
  return { stdout: result.stdout };
}

function version(output: string): typeof LOCAL_SURREAL_VERSION {
  if (Buffer.byteLength(output, "utf8") > 64 * 1024)
    throw new Error("local SurrealDB version 출력 상한을 초과했습니다");
  if (!VERSION.test(output.trim())) throw new Error("local SurrealDB version 3.2.1을 확인할 수 없습니다");
  return LOCAL_SURREAL_VERSION;
}

export async function attestLocalSurrealRuntime(
  input: { readonly executable: string; readonly expectedDigest: string; readonly runtimeRoot: string },
  dependencies: LocalSurrealRuntimeDependencies = {},
): Promise<LocalSurrealRuntimeAttestation> {
  if (!/^[a-f0-9]{64}$/u.test(input.expectedDigest))
    throw new Error("local SurrealDB SHA-256 digest가 유효하지 않습니다");
  const root = await secureRuntimeRoot(input.runtimeRoot);
  const executable = await executableFile(input.executable, root);
  const beforeDigest = await digest(executable);
  if (beforeDigest !== input.expectedDigest) throw new Error("local SurrealDB 실행 파일 digest가 예상과 다릅니다");
  const environment = { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } as const;
  let output: { readonly stdout: string };
  try {
    output = await (dependencies.runVersion ?? defaultRunVersion)(executable, ["version"], environment);
  } catch {
    throw new Error("local SurrealDB version 확인을 완료하지 못했습니다");
  }
  const afterDigest = await digest(executable);
  if (afterDigest !== beforeDigest) throw new Error("local SurrealDB 실행 파일이 version 확인 중 변경됐습니다");
  return { executable, digest: afterDigest, version: version(output.stdout) };
}

function endpoint(port: number): string {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new Error("local SurrealDB port가 유효하지 않습니다");
  return `http://127.0.0.1:${String(port)}`;
}

function startArguments(dataDirectory: string, port: number): readonly string[] {
  if (!isAbsolute(dataDirectory)) throw new Error("local SurrealDB data directory는 절대 경로여야 합니다");
  return [
    "start",
    "--bind",
    `127.0.0.1:${String(port)}`,
    "--no-banner",
    `rocksdb://${resolve(dataDirectory)}?sync=every`,
  ];
}

function credentialEnvironment(credential: LocalSurrealRuntimeManagerDependencies["credential"]): NodeJS.ProcessEnv {
  if (!credential.user || !credential.password) throw new Error("local SurrealDB credential이 유효하지 않습니다");
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    SURREAL_USER: credential.user,
    SURREAL_PASS: credential.password,
    SURREAL_LOG: "warn",
  };
}

export async function provisionLocalSurrealDatabase(input: {
  readonly endpoint: string;
  readonly credential: LocalSurrealRuntimeManagerDependencies["credential"];
  readonly fetcher?: typeof fetch;
}): Promise<void> {
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/")
    throw new Error("local SurrealDB sidecar endpoint가 유효하지 않습니다");
  if (!input.credential.user || !input.credential.password)
    throw new Error("local SurrealDB credential이 유효하지 않습니다");
  endpoint.pathname = "/sql";
  endpoint.search = "";
  endpoint.hash = "";
  const authorization = Buffer.from(`${input.credential.user}:${input.credential.password}`).toString("base64");
  const response = await (input.fetcher ?? fetch)(endpoint.toString(), {
    method: "POST",
    headers: {
      authorization: `Basic ${authorization}`,
      accept: "application/json",
      "content-type": "text/plain",
    },
    body: "DEFINE NAMESPACE IF NOT EXISTS massion; USE NS massion; DEFINE DATABASE IF NOT EXISTS massion;",
    signal: AbortSignal.timeout(3_000),
  }).catch(() => undefined);
  const results: unknown = await response?.json().catch(() => undefined);
  if (
    !response?.ok ||
    !Array.isArray(results) ||
    results.length !== 3 ||
    !results.every(
      (result: unknown) =>
        result !== null && typeof result === "object" && "status" in result && result.status === "OK",
    )
  )
    throw new Error("local SurrealDB namespace/database 준비에 실패했습니다");
}

export class LocalSurrealRuntimeManager {
  readonly #dependencies: LocalSurrealRuntimeManagerDependencies;

  public constructor(dependencies: LocalSurrealRuntimeManagerDependencies) {
    this.#dependencies = dependencies;
  }

  async #owned(state: LocalSurrealRuntimeState, executable: string): Promise<boolean> {
    if (state.executable !== executable || !this.#dependencies.processExists(state.pid)) return false;
    const command = await this.#dependencies.processCommand(state.pid).catch(() => "");
    return command === `${executable} start` || command.startsWith(`${executable} start `);
  }

  public async start(): Promise<{
    readonly status: "started" | "already-running";
    readonly pid: number;
    readonly endpoint: string;
  }> {
    const attested = await this.#dependencies.attest();
    const sidecarEndpoint = endpoint(this.#dependencies.port);
    const existing = await this.#dependencies.readState();
    if (existing) {
      const ownedExisting = existing.endpoint === sidecarEndpoint && (await this.#owned(existing, attested.executable));
      if (ownedExisting) {
        for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
          if (await this.#dependencies.ready(existing.endpoint)) {
            await this.#dependencies.provision(existing.endpoint);
            return { status: "already-running", pid: existing.pid, endpoint: existing.endpoint };
          }
          if (!this.#dependencies.processExists(existing.pid)) break;
          await this.#dependencies.wait(START_INTERVAL_MS);
        }
        if (this.#dependencies.processExists(existing.pid)) {
          if (!(await this.#owned(existing, attested.executable))) {
            throw new Error("기록된 local SurrealDB PID가 다른 process이므로 덮어쓰지 않습니다");
          }
          this.#dependencies.signal(existing.pid, "SIGTERM");
          await this.#dependencies.removeState();
          throw new Error("기존 local SurrealDB sidecar의 준비 시간이 초과했습니다");
        }
      }
      if (this.#dependencies.processExists(existing.pid)) {
        throw new Error("기록된 local SurrealDB PID가 다른 process이므로 덮어쓰지 않습니다");
      }
      await this.#dependencies.removeState();
    }

    await this.#dependencies.prepareDataDirectory();
    const child = this.#dependencies.spawn(
      attested.executable,
      startArguments(this.#dependencies.runtime.dataDirectory, this.#dependencies.port),
      {
        cwd: this.#dependencies.runtime.dataDirectory,
        env: credentialEnvironment(this.#dependencies.credential),
      },
    );
    child.unref();
    if (!child.pid) throw new Error("local SurrealDB sidecar PID를 받지 못했습니다");
    const state: LocalSurrealRuntimeState = {
      pid: child.pid,
      endpoint: sidecarEndpoint,
      executable: attested.executable,
      startedAt: new Date().toISOString(),
    };
    try {
      await this.#dependencies.writeState(state);
    } catch (error) {
      if (this.#dependencies.processExists(child.pid) && (await this.#owned(state, attested.executable))) {
        this.#dependencies.signal(child.pid, "SIGTERM");
      }
      await this.#dependencies.removeState().catch(() => undefined);
      throw error;
    }
    for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
      if (await this.#dependencies.ready(sidecarEndpoint)) {
        await this.#dependencies.provision(sidecarEndpoint);
        return { status: "started", pid: child.pid, endpoint: sidecarEndpoint };
      }
      if (!this.#dependencies.processExists(child.pid)) break;
      await this.#dependencies.wait(START_INTERVAL_MS);
    }
    if (this.#dependencies.processExists(child.pid) && (await this.#owned(state, attested.executable))) {
      this.#dependencies.signal(child.pid, "SIGTERM");
    }
    await this.#dependencies.removeState();
    throw new Error("local SurrealDB sidecar가 준비되지 않았습니다");
  }

  public async stop(): Promise<{ readonly status: "stopped" | "already-stopped"; readonly pid?: number }> {
    const existing = await this.#dependencies.readState();
    if (!existing) return { status: "already-stopped" };
    if (!this.#dependencies.processExists(existing.pid)) {
      await this.#dependencies.removeState();
      return { status: "already-stopped", pid: existing.pid };
    }

    const expectedExecutable = (await this.#dependencies.attest()).executable;
    if (existing.endpoint !== endpoint(this.#dependencies.port) || !(await this.#owned(existing, expectedExecutable))) {
      throw new Error("기록된 local SurrealDB PID가 다른 process이므로 종료하지 않습니다");
    }
    this.#dependencies.signal(existing.pid, "SIGTERM");
    for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
      if (!this.#dependencies.processExists(existing.pid)) {
        await this.#dependencies.removeState();
        return { status: "stopped", pid: existing.pid };
      }
      await this.#dependencies.wait(START_INTERVAL_MS);
    }
    throw new Error("local SurrealDB sidecar 정상 종료 시간을 초과했습니다");
  }
}
