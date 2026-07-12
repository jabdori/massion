import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

export type ExternalEdgeProviderId = "google-gemini-cli-enterprise" | "github-copilot" | "xai-grok-build";

export interface EdgeRuntimeArtifact {
  readonly executable: string;
  readonly digest: string;
  readonly version: string;
}

export interface EdgeRuntimeArtifactDependencies {
  readonly runVersion?: (
    executable: string,
    arguments_: readonly string[],
    environment: Readonly<Record<string, string>>,
  ) => Promise<{ readonly stdout: string }>;
}

const executeFile = promisify(execFile);
const MAXIMUM_RUNTIME_BYTES = 1024 * 1024 * 1024;
const VERSION = /(?:^|[^0-9])v?([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)(?:$|[^0-9A-Za-z.+-])/u;

function versionArguments(providerId: string): readonly string[] {
  if (providerId === "google-gemini-cli-enterprise") return ["--version"];
  if (providerId === "github-copilot" || providerId === "xai-grok-build") return ["version"];
  throw new Error("지원하지 않는 Edge Provider 실행 파일입니다");
}

async function runtimeFile(executable: string): Promise<string> {
  if (!isAbsolute(executable)) throw new Error("Edge Provider 실행 파일은 절대 경로여야 합니다");
  const metadata = await lstat(executable);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Edge Provider 실행 파일은 symlink가 아닌 regular file이어야 합니다");
  }
  if ((metadata.mode & 0o111) === 0) throw new Error("Edge Provider 실행 파일에 실행 권한이 필요합니다");
  if (metadata.size <= 0 || metadata.size > MAXIMUM_RUNTIME_BYTES) {
    throw new Error("Edge Provider 실행 파일 크기가 유효하지 않습니다");
  }
  const canonical = await realpath(executable);
  if (canonical !== resolve(executable)) throw new Error("Edge Provider 실행 파일에 symlink 경로를 사용할 수 없습니다");
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

function runtimeVersion(output: string): string {
  if (Buffer.byteLength(output, "utf8") > 64 * 1024) throw new Error("Edge Provider version 출력 상한을 초과했습니다");
  const match = VERSION.exec(output.trim());
  if (!match?.[1]) throw new Error("Edge Provider version을 확인할 수 없습니다");
  return match[1];
}

export async function attestEdgeRuntimeArtifact(
  input: { readonly providerId: string; readonly executable: string },
  dependencies: EdgeRuntimeArtifactDependencies = {},
): Promise<EdgeRuntimeArtifact> {
  const arguments_ = versionArguments(input.providerId);
  const executable = await runtimeFile(input.executable);
  const environment = { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } as const;
  let output: { readonly stdout: string };
  try {
    output = await (dependencies.runVersion ?? defaultRunVersion)(executable, arguments_, environment);
  } catch {
    throw new Error("Edge Provider version 확인을 완료하지 못했습니다");
  }
  return {
    executable,
    digest: await digest(executable),
    version: runtimeVersion(output.stdout),
  };
}

export async function assertEdgeRuntimeArtifact(
  providerId: string,
  expected: EdgeRuntimeArtifact,
  dependencies: EdgeRuntimeArtifactDependencies = {},
): Promise<EdgeRuntimeArtifact> {
  const current = await attestEdgeRuntimeArtifact({ providerId, executable: expected.executable }, dependencies);
  if (
    current.executable !== expected.executable ||
    current.digest !== expected.digest ||
    current.version !== expected.version
  ) {
    throw new Error("Edge Provider 실행 파일 digest 또는 version이 등록 뒤 변경됐습니다");
  }
  return current;
}
