import { timingSafeEqual } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const BOOTSTRAP_CAPABILITY_BYTES = 32;
const BOOTSTRAP_CAPABILITY_TTL_MS = 5 * 60_000;
type ApplicationBootstrapDisposalReason = "consumed" | "expired" | "closed" | "failed";

export interface BootstrapCapabilityFileOptions {
  readonly currentUid?: number;
  readonly clock?: () => number;
  readonly afterRead?: () => void | Promise<void>;
  readonly beforeCleanup?: () => void | Promise<void>;
  readonly onCleanupError?: (reason: ApplicationBootstrapDisposalReason) => void;
}

export interface FileBackedBootstrapAuthorization {
  expiresAtForDiagnostics(): number;
  claim(authorization: string | undefined): Promise<boolean>;
  consume(): Promise<void>;
  fail(): Promise<void>;
  close(): Promise<void>;
}

class FileBackedBootstrapCapability implements FileBackedBootstrapAuthorization {
  #capability: Buffer | undefined;
  readonly #expiresAt: number;
  readonly #clock: () => number;
  readonly #cleanupFile: () => Promise<void>;
  readonly #onCleanupError: ((reason: ApplicationBootstrapDisposalReason) => void) | undefined;
  #inFlight = false;
  #disposed = false;
  #cleanup: Promise<void> | undefined;
  #expiryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(input: {
    readonly capability: Buffer;
    readonly expiresAt: number;
    readonly clock: () => number;
    readonly cleanupFile: () => Promise<void>;
    readonly onCleanupError?: (reason: ApplicationBootstrapDisposalReason) => void;
  }) {
    try {
      this.#capability = Buffer.from(input.capability);
    } finally {
      input.capability.fill(0);
    }
    this.#expiresAt = input.expiresAt;
    this.#clock = input.clock;
    this.#cleanupFile = input.cleanupFile;
    this.#onCleanupError = input.onCleanupError;
    this.#scheduleExpiry();
  }

  public expiresAtForDiagnostics(): number {
    return this.#expiresAt;
  }

  public async claim(authorization: string | undefined): Promise<boolean> {
    const encoded = authorization?.match(/^MassionBootstrap ([A-Za-z0-9_-]{43})$/u)?.[1];
    const decoded = encoded === undefined ? undefined : Buffer.from(encoded, "base64url");
    const candidateValid = decoded?.length === BOOTSTRAP_CAPABILITY_BYTES && decoded.toString("base64url") === encoded;
    const candidate = candidateValid ? decoded : Buffer.alloc(BOOTSTRAP_CAPABILITY_BYTES);
    const expected = this.#capability;
    const dummy = expected === undefined ? Buffer.alloc(BOOTSTRAP_CAPABILITY_BYTES, 0xff) : undefined;
    let matches = false;
    try {
      matches = timingSafeEqual(candidate, expected ?? dummy!);
    } finally {
      candidate.fill(0);
      dummy?.fill(0);
    }
    if (this.#clock() >= this.#expiresAt) {
      await this.#dispose("expired");
      return false;
    }
    if (!candidateValid || !matches || expected === undefined || this.#disposed || this.#inFlight) return false;
    this.#inFlight = true;
    return true;
  }

  public async consume(): Promise<void> {
    if (this.#inFlight) await this.#dispose("consumed");
  }

  public async fail(): Promise<void> {
    if (this.#inFlight) await this.#dispose("failed");
  }

  public async close(): Promise<void> {
    await this.#dispose("closed");
  }

  #scheduleExpiry(): void {
    if (this.#disposed) return;
    const remaining = this.#expiresAt - this.#clock();
    if (remaining <= 0) {
      void this.#dispose("expired");
      return;
    }
    this.#expiryTimer = setTimeout(
      () => {
        this.#expiryTimer = undefined;
        if (this.#clock() >= this.#expiresAt) void this.#dispose("expired");
        else this.#scheduleExpiry();
      },
      Math.min(remaining, 2_147_483_647),
    );
    this.#expiryTimer.unref?.();
  }

  async #dispose(reason: ApplicationBootstrapDisposalReason): Promise<void> {
    if (this.#cleanup) return await this.#cleanup;
    if (this.#disposed) return;
    this.#disposed = true;
    this.#inFlight = false;
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = undefined;
    const capability = this.#capability;
    this.#capability = undefined;
    capability?.fill(0);
    this.#cleanup = this.#cleanupFile().catch(() => {
      try {
        this.#onCleanupError?.(reason);
      } catch {
        // 안전한 운영 오류 callback 자체의 실패는 외부 응답으로 전파하지 않습니다.
      }
    });
    await this.#cleanup;
  }
}

function trustError(): Error {
  return new Error("bootstrap capability 파일 신뢰 검증에 실패했습니다");
}

function sameFile(
  left: { readonly dev: number | bigint; readonly ino: number | bigint },
  right: { readonly dev: number | bigint; readonly ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertDirectoryTrust(metadata: Stats, expectedUid: number | undefined): void {
  if (!metadata.isDirectory()) throw trustError();
  if (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o700) throw trustError();
  if (expectedUid !== undefined && metadata.uid !== expectedUid) throw trustError();
}

function assertFileTrust(metadata: Stats, expectedUid: number | undefined): void {
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size !== BOOTSTRAP_CAPABILITY_BYTES) throw trustError();
  if (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600) throw trustError();
  if (expectedUid !== undefined && metadata.uid !== expectedUid) throw trustError();
}

async function openNoFollow(path: string, flags: number): Promise<FileHandle> {
  try {
    return await open(path, flags | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw trustError();
  }
}

async function sanitizeBootstrapFile(
  handle: FileHandle,
  original: { readonly dev: number | bigint; readonly ino: number | bigint },
  expectedUid: number | undefined,
  beforeCleanup: (() => void | Promise<void>) | undefined,
): Promise<void> {
  await beforeCleanup?.();
  const metadata = await handle.stat();
  if (!metadata.isFile() || !sameFile(metadata, original)) throw trustError();
  if (metadata.nlink === 0) return;
  if (metadata.nlink !== 1 || (metadata.size !== 0 && metadata.size !== BOOTSTRAP_CAPABILITY_BYTES)) throw trustError();
  if (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600) throw trustError();
  if (expectedUid !== undefined && metadata.uid !== expectedUid) throw trustError();
  if (metadata.size === 0) return;
  await handle.truncate(0);
  await handle.sync();
}

/** 검증된 file descriptor에서만 비밀을 읽어 전용 소유자에게 바로 이전합니다. */
export async function loadBootstrapCapabilityFile(
  path: string,
  options: BootstrapCapabilityFileOptions = {},
): Promise<FileBackedBootstrapAuthorization> {
  if (!isAbsolute(path)) throw trustError();
  const expectedUid = options.currentUid ?? process.getuid?.();
  const parent = resolve(dirname(path));
  let directoryHandle: FileHandle | undefined;
  let capabilityHandle: FileHandle | undefined;
  let cleanupHandle: FileHandle | undefined;
  let capability: Buffer | undefined;
  try {
    if ((await realpath(parent)) !== parent) throw trustError();
    directoryHandle = await openNoFollow(parent, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    assertDirectoryTrust(await directoryHandle.stat(), expectedUid);

    capabilityHandle = await openNoFollow(path, constants.O_RDONLY);
    const before = await capabilityHandle.stat();
    assertFileTrust(before, expectedUid);
    capability = await capabilityHandle.readFile();
    if (capability.length !== BOOTSTRAP_CAPABILITY_BYTES) throw trustError();
    await options.afterRead?.();
    const after = await capabilityHandle.stat();
    if (!sameFile(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw trustError();

    const currentHandle = await openNoFollow(path, constants.O_RDONLY);
    try {
      const current = await currentHandle.stat();
      assertFileTrust(current, expectedUid);
      if (!sameFile(before, current)) throw trustError();
    } finally {
      await currentHandle.close();
    }
    cleanupHandle = await openNoFollow(path, constants.O_RDWR);
    const cleanupMetadata = await cleanupHandle.stat();
    assertFileTrust(cleanupMetadata, expectedUid);
    if (!sameFile(before, cleanupMetadata)) throw trustError();

    const normalizedMtime = Math.floor(before.mtimeMs);
    const now = Math.floor((options.clock ?? Date.now)());
    const expiresAt = Math.min(normalizedMtime + BOOTSTRAP_CAPABILITY_TTL_MS, now + BOOTSTRAP_CAPABILITY_TTL_MS);
    if (!Number.isSafeInteger(expiresAt)) throw trustError();
    const retainedCleanupHandle = cleanupHandle;
    cleanupHandle = undefined;
    const owned = capability;
    capability = undefined;
    return new FileBackedBootstrapCapability({
      capability: owned,
      expiresAt,
      clock: options.clock ?? Date.now,
      cleanupFile: async () => {
        try {
          await sanitizeBootstrapFile(retainedCleanupHandle, before, expectedUid, options.beforeCleanup);
        } finally {
          await retainedCleanupHandle.close();
        }
      },
      ...(options.onCleanupError === undefined ? {} : { onCleanupError: options.onCleanupError }),
    });
  } catch (error) {
    capability?.fill(0);
    throw error;
  } finally {
    await capabilityHandle?.close().catch(() => undefined);
    await cleanupHandle?.close().catch(() => undefined);
    await directoryHandle?.close().catch(() => undefined);
  }
}
