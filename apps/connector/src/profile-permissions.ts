import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export class ProviderProfilePermissionError extends Error {
  public readonly code = "profile-permissions-required" as const;

  public constructor() {
    super(
      "Provider profile root는 owner-only 0700이어야 합니다. massion-connector secure-profile --profile-root <경로>를 명시적으로 실행해주세요",
    );
    this.name = "ProviderProfilePermissionError";
  }
}

export class ProviderProfileOwnershipError extends Error {
  public readonly code = "profile-ownership-invalid" as const;

  public constructor() {
    super("Provider profile root는 현재 사용자 소유여야 합니다");
    this.name = "ProviderProfileOwnershipError";
  }
}

export class ProviderProfilePathError extends Error {
  public readonly code = "profile-path-invalid" as const;

  public constructor() {
    super("Provider profile root는 절대 경로인 symlink 없는 실제 디렉터리여야 합니다");
    this.name = "ProviderProfilePathError";
  }
}

async function canonicalProfileRoot(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new ProviderProfilePathError();
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ProviderProfilePathError();
  }
  const canonical = await realpath(path);
  if (canonical !== resolve(path)) {
    throw new ProviderProfilePathError();
  }
  return canonical;
}

function assertCurrentOwner(uid: number): void {
  if (typeof process.getuid !== "function" || uid !== process.getuid()) {
    throw new ProviderProfileOwnershipError();
  }
}

async function profileHandle(path: string) {
  const canonical = await canonicalProfileRoot(path);
  const handle = await open(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory()) throw new Error("Provider profile root가 안전한 디렉터리가 아닙니다");
    assertCurrentOwner(metadata.uid);
    return { canonical, handle, mode: metadata.mode & 0o7777 };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function assertSecureProviderProfileRoot(path: string): Promise<string> {
  const opened = await profileHandle(path);
  try {
    if (opened.mode !== 0o700) {
      throw new ProviderProfilePermissionError();
    }
    return opened.canonical;
  } finally {
    await opened.handle.close();
  }
}

export async function secureProviderProfileRoot(path: string): Promise<string> {
  const opened = await profileHandle(path);
  try {
    if (opened.mode !== 0o700) await opened.handle.chmod(0o700);
    const migrated = await opened.handle.stat();
    assertCurrentOwner(migrated.uid);
    if ((migrated.mode & 0o7777) !== 0o700) {
      throw new Error("Provider profile root를 owner-only 0700으로 보호하지 못했습니다");
    }
    return opened.canonical;
  } finally {
    await opened.handle.close();
  }
}
