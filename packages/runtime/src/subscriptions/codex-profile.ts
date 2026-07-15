import { randomUUID } from "node:crypto";
import { chmod, lstat, open, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export const CODEX_FILE_CREDENTIAL_STORE_CONFIG = 'cli_auth_credentials_store = "file"\n';
const CODEX_FILE_CREDENTIAL_STORE_OVERRIDE = 'cli_auth_credentials_store = "file"';

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

async function ownerOnlyDirectory(profileRoot: string): Promise<string> {
  if (!isAbsolute(profileRoot)) throw new Error("관리 Codex profile 경로는 절대 경로여야 합니다");
  const resolved = resolve(profileRoot);
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("관리 Codex profile directory가 안전하지 않습니다");
  }
  if ((metadata.mode & 0o077) !== 0) throw new Error("관리 Codex profile directory는 owner-only여야 합니다");
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("관리 Codex profile directory는 현재 사용자 소유여야 합니다");
  }
  // macOS의 /var → /private/var 같은 상위 경로 별칭은 허용하되,
  // 최종 profile directory 자체의 심볼릭 링크는 위 lstat 검사로 거부합니다.
  return await realpath(resolved);
}

async function existingSafePrivateFile(path: string, label: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`${label}가 안전하지 않습니다`);
    }
    if ((metadata.mode & 0o777) !== 0o600) {
      throw new Error(`${label}는 owner-only 0600 파일이어야 합니다`);
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error(`${label}는 현재 사용자 소유여야 합니다`);
    }
    if (metadata.nlink !== 1) {
      throw new Error(`${label}에 hard link를 사용할 수 없습니다`);
    }
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function ensureManagedCodexConfig(root: string): Promise<void> {
  const config = join(root, "config.toml");
  if (await existingSafePrivateFile(config, "관리 Codex profile config")) return;
  const temporary = join(root, `.massion-codex-config-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(CODEX_FILE_CREDENTIAL_STORE_CONFIG, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, config);
    await chmod(config, 0o600);
    if (!(await existingSafePrivateFile(config, "관리 Codex profile config"))) {
      throw new Error("관리 Codex profile config를 만들지 못했습니다");
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function codexFileCredentialStoreArguments(arguments_: readonly string[]): readonly string[] {
  if (arguments_.some((value) => typeof value !== "string" || /[\0\r\n]/u.test(value))) {
    throw new Error("Codex runtime argument가 유효하지 않습니다");
  }
  return [...arguments_, "--config", CODEX_FILE_CREDENTIAL_STORE_OVERRIDE];
}

export async function ensureManagedCodexProfile(profileRoot: string): Promise<void> {
  const root = await ownerOnlyDirectory(profileRoot);
  await ensureManagedCodexConfig(root);
}

/**
 * 자격 증명 내용은 읽지 않고 파일 메타데이터만 검사합니다.
 * `missing`은 로그인으로 복구할 수 있는 상태이고, 나머지 안전성 위반은 실패 폐쇄합니다.
 */
export async function managedCodexCredentialState(profileRoot: string): Promise<"missing" | "present"> {
  const root = await ownerOnlyDirectory(profileRoot);
  await ensureManagedCodexConfig(root);
  return (await existingSafePrivateFile(join(root, "auth.json"), "관리 Codex profile auth")) ? "present" : "missing";
}
