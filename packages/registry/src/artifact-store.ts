import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { assertDigest } from "./contracts.js";

export interface ArtifactStore {
  put(digest: string, body: Buffer): Promise<void>;
  get(digest: string): Promise<Buffer>;
}

export class FileArtifactStore implements ArtifactStore {
  private readonly root: string;

  public constructor(root: string) {
    this.root = resolve(root);
  }

  public async put(digest: string, body: Buffer): Promise<void> {
    assertDigest(digest, "artifact");
    if (body.length === 0 || body.length > 32 * 1024 * 1024) throw new Error("artifact byte 상한을 초과했습니다");
    const actual = createHash("sha256").update(body).digest("hex");
    if (actual !== digest) throw new Error("artifact body가 digest와 일치하지 않습니다");
    const target = this.path(digest);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try {
      const existing = await readFile(target);
      if (!existing.equals(body)) throw new Error("같은 digest에 다른 artifact를 덮어쓸 수 없습니다");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      try {
        const existing = await readFile(target);
        if (existing.equals(body)) return;
      } catch {
        // 원래 rename 오류를 반환합니다.
      }
      throw error;
    }
  }

  public async get(digest: string): Promise<Buffer> {
    assertDigest(digest, "artifact");
    const body = await readFile(this.path(digest));
    if (createHash("sha256").update(body).digest("hex") !== digest) throw new Error("저장된 artifact integrity가 손상됐습니다");
    return body;
  }

  private path(digest: string): string {
    const target = resolve(this.root, digest.slice(0, 2), digest.slice(2, 4), `${digest}.tgz`);
    if (!target.startsWith(`${this.root}${sep}`)) throw new Error("artifact path가 root를 벗어났습니다");
    return target;
  }
}
