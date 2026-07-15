import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";

import { ensureManagedCodexProfile } from "@massion/runtime";

function segment(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 1024 || /[\0\r\n]/u.test(normalized)) {
    throw new Error("구독 profile 계보 식별자가 유효하지 않습니다");
  }
  return createHash("sha256").update(normalized).digest("hex");
}

export function subscriptionProfileHandle(organizationId: string, accountId: string): string {
  return `${segment(organizationId)}/${segment(accountId)}`;
}

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** macOS의 시스템 경로 별칭만 허용하고, 그 밖의 상위 symlink는 관리 경계 밖으로 봅니다. */
function expectedCanonicalPath(path: string): string {
  const resolved = resolve(path);
  if (process.platform !== "darwin") return resolved;
  for (const alias of ["/var", "/tmp"]) {
    if (resolved === alias || resolved.startsWith(`${alias}${sep}`)) {
      return resolve("/private", resolved.slice(1));
    }
  }
  return resolved;
}

function canonicalPathMatches(path: string, canonical: string): boolean {
  return canonical === expectedCanonicalPath(path);
}

async function nearestExistingDirectory(
  path: string,
): Promise<{ readonly path: string; readonly missing: readonly string[] }> {
  let candidate = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      const metadata = await lstat(candidate);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("Connector profile directory가 안전하지 않습니다");
      }
      return { path: candidate, missing };
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw new Error("Connector profile directory의 상위 경로를 찾을 수 없습니다", { cause: error });
      }
      missing.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

async function ownerOnlyDirectory(path: string): Promise<string> {
  const resolved = resolve(path);
  const existing = await nearestExistingDirectory(resolved);
  const canonicalParent = await realpath(existing.path);
  if (!canonicalPathMatches(existing.path, canonicalParent)) {
    throw new Error("Connector profile directory의 상위 symlink 경로를 사용할 수 없습니다");
  }
  const target = resolve(canonicalParent, ...existing.missing);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const metadata = await lstat(target);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Connector profile directory가 안전하지 않습니다");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("Connector profile directory는 현재 사용자 소유여야 합니다");
  }
  const canonical = await realpath(target);
  if (canonical !== target) throw new Error("Connector profile directory의 symlink 경로를 사용할 수 없습니다");
  await chmod(canonical, 0o700);
  return canonical;
}

export async function prepareSubscriptionProfileRoot(
  configuredRoot: string,
  organizationId: string,
  accountId: string,
): Promise<string> {
  const root = await ownerOnlyDirectory(resolve(configuredRoot));
  const [organizationSegment, accountSegment] = subscriptionProfileHandle(organizationId, accountId).split("/");
  if (!organizationSegment || !accountSegment) throw new Error("구독 profile handle이 유효하지 않습니다");
  const organizationRoot = await ownerOnlyDirectory(resolve(root, organizationSegment));
  const profileRoot = await ownerOnlyDirectory(resolve(organizationRoot, accountSegment));
  if (!within(root, organizationRoot) || !within(organizationRoot, profileRoot)) {
    throw new Error("Connector profile 경로가 관리 root 밖입니다");
  }
  await ensureManagedCodexProfile(profileRoot);
  return profileRoot;
}

async function existingOwnerOnlyDirectory(path: string, label: string): Promise<string | undefined> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label}가 안전하지 않습니다`);
  if ((metadata.mode & 0o077) !== 0 || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new Error(`${label}는 현재 사용자 소유의 owner-only 디렉터리여야 합니다`);
  }
  const canonical = await realpath(path);
  if (!canonicalPathMatches(path, canonical)) throw new Error(`${label}에 symlink 경로를 사용할 수 없습니다`);
  return canonical;
}

export async function existingSubscriptionProfileRoot(
  configuredRoot: string,
  organizationId: string,
  accountId: string,
): Promise<string | undefined> {
  const root = await existingOwnerOnlyDirectory(resolve(configuredRoot), "Connector profile 관리 root");
  if (!root) return undefined;
  const [organizationSegment, accountSegment] = subscriptionProfileHandle(organizationId, accountId).split("/");
  if (!organizationSegment || !accountSegment) throw new Error("구독 profile handle이 유효하지 않습니다");
  const organizationRoot = await existingOwnerOnlyDirectory(
    resolve(root, organizationSegment),
    "Connector profile 조직 root",
  );
  if (!organizationRoot) return undefined;
  const profileRoot = await existingOwnerOnlyDirectory(
    resolve(organizationRoot, accountSegment),
    "Connector account profile",
  );
  if (!profileRoot) return undefined;
  if (!within(root, organizationRoot) || !within(organizationRoot, profileRoot)) {
    throw new Error("Connector profile 경로가 관리 root 밖입니다");
  }
  return profileRoot;
}

export async function forgetSubscriptionProfileRoot(
  configuredRoot: string,
  organizationId: string,
  accountId: string,
): Promise<boolean> {
  const profileRoot = await existingSubscriptionProfileRoot(configuredRoot, organizationId, accountId);
  if (!profileRoot) return false;
  await rm(profileRoot, { recursive: true, force: false });
  return true;
}
