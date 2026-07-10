import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export interface ConfinedFile {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly rootRealPath: string;
}

export function normalizeRepositoryPath(input: string): string {
  if (!input || input.includes("\0")) throw new Error("Repository path가 비었거나 NUL을 포함합니다");
  const slashPath = input.replaceAll("\\", "/");
  if (path.posix.isAbsolute(slashPath) || /^[a-zA-Z]:\//u.test(slashPath)) {
    throw new Error("Repository path는 상대 경로여야 합니다");
  }
  const normalized = path.posix.normalize(slashPath);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Repository path가 root 밖을 가리킵니다");
  }
  return normalized;
}

export async function resolveConfinedFile(root: string, input: string): Promise<ConfinedFile> {
  const relativePath = normalizeRepositoryPath(input);
  const rootRealPath = await realpath(root);
  const candidate = path.resolve(rootRealPath, ...relativePath.split("/"));
  const candidateStat = await lstat(candidate);
  if (candidateStat.isSymbolicLink()) throw new Error(`Repository symlink는 허용되지 않습니다: ${relativePath}`);
  if (!candidateStat.isFile()) throw new Error(`Repository regular file이 아닙니다: ${relativePath}`);
  const candidateRealPath = await realpath(candidate);
  const prefix = `${rootRealPath}${path.sep}`;
  if (!candidateRealPath.startsWith(prefix)) throw new Error(`Repository file이 root 밖을 가리킵니다: ${relativePath}`);
  return { relativePath, absolutePath: candidateRealPath, rootRealPath };
}
