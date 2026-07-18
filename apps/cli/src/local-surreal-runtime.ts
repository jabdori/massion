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
