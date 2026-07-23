import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

import { ensureLocalDataEpoch, resolveLocalPaths, resolveLocalSurrealRuntime } from "@massion/local-control/daemon";

const MAX_RUNTIME_BYTES = 1024 * 1024 * 1024;

export async function prepareDesktopRuntimeEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<NodeJS.ProcessEnv> {
  const source = environment.MASSION_SURREAL_BINARY;
  const expectedDigest = environment.MASSION_SURREAL_SHA256;
  if (!source || !isAbsolute(source)) throw new Error("bundled SurrealDB 실행 파일 절대 경로가 필요합니다");
  if (!expectedDigest || !/^[a-f0-9]{64}$/u.test(expectedDigest)) {
    throw new Error("bundled SurrealDB digest가 유효하지 않습니다");
  }

  await ensureLocalDataEpoch(
    resolveLocalPaths({
      ...(environment.HOME === undefined ? {} : { HOME: environment.HOME }),
      ...(environment.XDG_CONFIG_HOME === undefined ? {} : { XDG_CONFIG_HOME: environment.XDG_CONFIG_HOME }),
      ...(environment.XDG_DATA_HOME === undefined ? {} : { XDG_DATA_HOME: environment.XDG_DATA_HOME }),
      ...(environment.XDG_STATE_HOME === undefined ? {} : { XDG_STATE_HOME: environment.XDG_STATE_HOME }),
    }),
  );

  const runtime = resolveLocalSurrealRuntime({
    ...(environment.HOME === undefined ? {} : { home: environment.HOME }),
    ...(environment.XDG_DATA_HOME === undefined ? {} : { xdgDataHome: environment.XDG_DATA_HOME }),
  });
  const runtimeRoot = dirname(runtime.binaryPath);
  const massionRoot = ancestor(runtimeRoot, 4);
  await secureDirectoryTree(massionRoot, runtimeRoot);

  if (resolve(source) === runtime.binaryPath) {
    await verifyExistingRuntime(runtime.binaryPath, expectedDigest);
  } else if (!(await useExistingRuntime(runtime.binaryPath, expectedDigest))) {
    await copyVerifiedRuntime(source, runtime.binaryPath, expectedDigest);
  }
  return { ...environment, MASSION_SURREAL_BINARY: runtime.binaryPath };
}

async function secureDirectoryTree(root: string, leaf: string): Promise<void> {
  await rejectSymlinkAncestors(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await verifyOwnerDirectory(root);
  let current = root;
  for (const part of relative(root, leaf).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await verifyOwnerDirectory(current);
  }
}

async function rejectSymlinkAncestors(path: string): Promise<void> {
  const root = parse(path).root;
  let current = root;
  for (const part of resolve(path).slice(root.length).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() && !allowedSystemAlias(current)) {
        throw new Error("per-user runtime 경로에 symlink를 사용할 수 없습니다");
      }
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }
}

async function verifyOwnerDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("per-user runtime root는 symlink가 아닌 directory여야 합니다");
  }
  if ((metadata.mode & 0o077) !== 0) throw new Error("per-user runtime root는 owner-only여야 합니다");
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("per-user runtime root는 현재 사용자 소유여야 합니다");
  }
  if ((await realpath(path)) !== expectedCanonicalPath(path)) {
    throw new Error("per-user runtime root에 symlink 경로를 사용할 수 없습니다");
  }
}

async function verifyExistingRuntime(path: string, expectedDigest: string): Promise<void> {
  if (!(await useExistingRuntime(path, expectedDigest))) {
    throw new Error("per-user SurrealDB digest가 예상과 다릅니다");
  }
}

async function useExistingRuntime(path: string, expectedDigest: string): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await openNoFollow(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  try {
    const metadata = await handle.stat();
    verifyRuntimeFile(metadata, "per-user", true);
    if ((await digestHandle(handle)) !== expectedDigest) return false;
    await handle.chmod(0o500);
    await handle.sync();
    return true;
  } finally {
    await handle.close();
  }
}

async function copyVerifiedRuntime(sourcePath: string, destination: string, expectedDigest: string): Promise<void> {
  const source = await openNoFollow(sourcePath, constants.O_RDONLY | constants.O_NONBLOCK);
  const temporary = `${destination}.${String(process.pid)}.${randomUUID()}.tmp`;
  let target: FileHandle | undefined;
  try {
    const metadata = await source.stat();
    verifyRuntimeFile(metadata, "bundled", false);
    target = await openNoFollow(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    verifyRuntimeFile(await target.stat(), "temporary", true, false);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await target.write(buffer, written, bytesRead - written, position + written);
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    if (hash.digest("hex") !== expectedDigest) throw new Error("bundled SurrealDB digest가 예상과 다릅니다");
    await target.chmod(0o500);
    await target.sync();
    await target.close();
    target = undefined;
    await rename(temporary, destination);
    const directory = await open(dirname(destination), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    await verifyExistingRuntime(destination, expectedDigest);
  } finally {
    await source.close();
    await target?.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}

async function digestHandle(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

async function openNoFollow(path: string, flags: number, mode?: number) {
  try {
    return await open(path, flags | (constants.O_NOFOLLOW ?? 0), mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("SurrealDB 실행 파일에 symlink를 사용할 수 없습니다");
    }
    throw error;
  }
}

function verifyRuntimeFile(
  metadata: Awaited<ReturnType<FileHandle["stat"]>>,
  label: string,
  requireOwner: boolean,
  requireContent = true,
): void {
  if (!metadata.isFile()) throw new Error(`${label} SurrealDB 실행 파일은 regular file이어야 합니다`);
  if (metadata.nlink !== 1) throw new Error(`${label} SurrealDB 실행 파일에 hard link를 사용할 수 없습니다`);
  if ((requireContent && metadata.size < 1) || metadata.size > MAX_RUNTIME_BYTES) {
    throw new Error(`${label} SurrealDB 실행 파일 크기가 유효하지 않습니다`);
  }
  if (requireOwner && typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`${label} SurrealDB 실행 파일은 현재 사용자 소유여야 합니다`);
  }
}

function ancestor(path: string, levels: number): string {
  let value = path;
  for (let index = 0; index < levels; index += 1) value = dirname(value);
  return value;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function allowedSystemAlias(path: string): boolean {
  return process.platform === "darwin" && ["/var", "/tmp"].includes(resolve(path));
}

function expectedCanonicalPath(path: string): string {
  const resolved = resolve(path);
  if (process.platform !== "darwin") return resolved;
  for (const alias of ["/var", "/tmp"]) {
    if (resolved === alias || resolved.startsWith(`${alias}${sep}`)) return resolve("/private", resolved.slice(1));
  }
  return resolved;
}
