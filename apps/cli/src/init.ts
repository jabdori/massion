import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { CliConfigStore } from "./config.js";

export async function replaceCliFileToken(reference: string, token: string): Promise<void> {
  if (!reference.startsWith("file:")) throw new Error("개인 token 교체에는 file reference가 필요합니다");
  const tokenPath = reference.slice(5);
  if (!tokenPath || !token.trim()) throw new Error("개인 token file 교체 입력이 유효하지 않습니다");
  try {
    const existing = await lstat(tokenPath);
    if (existing.isSymbolicLink() || !existing.isFile() || (existing.mode & 0o077) !== 0)
      throw new Error("token file은 symlink가 아닌 0600 regular file이어야 합니다");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const temporaryTokenPath = `${tokenPath}.${process.pid.toString()}.tmp`;
  await rm(temporaryTokenPath, { force: true });
  const handle = await open(temporaryTokenPath, "wx", 0o600);
  try {
    await handle.writeFile(`${token}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryTokenPath, tokenPath);
    await chmod(tokenPath, 0o600);
  } catch (error) {
    await rm(temporaryTokenPath, { force: true });
    throw error;
  }
}

export async function initializeCli(input: {
  readonly endpoint: string;
  readonly email: string;
  readonly displayName: string;
  readonly profile: string;
  readonly config: CliConfigStore;
  readonly bootstrap: (
    endpoint: string,
    input: { readonly commandId: string; readonly email: string; readonly displayName: string },
  ) => Promise<unknown>;
}): Promise<{ readonly profile: string; readonly endpoint: string; readonly tokenId: string }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.profile))
    throw new Error("CLI profile 이름이 유효하지 않습니다");
  const response = await input.bootstrap(input.endpoint, {
    commandId: randomUUID(),
    email: input.email,
    displayName: input.displayName,
  });
  const access = response && typeof response === "object" ? (response as { access?: unknown }).access : undefined;
  const token = access && typeof access === "object" ? (access as { token?: unknown }).token : undefined;
  const tokenId = access && typeof access === "object" ? (access as { tokenId?: unknown }).tokenId : undefined;
  if (typeof token !== "string" || typeof tokenId !== "string")
    throw new Error("bootstrap 응답에 일회성 token이 없습니다");
  const tokenDirectory = join(dirname(input.config.path), "tokens");
  await mkdir(tokenDirectory, { recursive: true, mode: 0o700 });
  await chmod(tokenDirectory, 0o700);
  const tokenPath = join(tokenDirectory, `${input.profile}.token`);
  await replaceCliFileToken(`file:${tokenPath}`, token);
  await input.config.save({
    schemaVersion: "massion.cli.config.v1",
    selectedProfile: input.profile,
    profiles: { [input.profile]: { endpoint: input.endpoint, tokenReference: `file:${tokenPath}` } },
  });
  return { profile: input.profile, endpoint: input.endpoint, tokenId };
}
