import { lstat, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  existingSubscriptionProfileRoot,
  forgetSubscriptionProfileRoot,
  prepareSubscriptionProfileRoot,
} from "./subscription-profile.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("서버 구독 profile lifecycle", () => {
  it("계정 profile의 로그인 자료를 owner-only 관리 경계 안에서 삭제하고 재시도를 멱등 처리한다", async () => {
    const rootPath = join(tmpdir(), `massion-profile-root-${crypto.randomUUID()}`);
    roots.push(rootPath);
    await mkdir(rootPath, { recursive: true, mode: 0o700 });
    const root = await realpath(rootPath);
    const profile = await prepareSubscriptionProfileRoot(root, "organization-1", "account-1");
    await writeFile(join(profile, "auth.json"), "private-login-token", { mode: 0o600 });

    await expect(existingSubscriptionProfileRoot(root, "organization-1", "account-1")).resolves.toBe(profile);
    await expect(forgetSubscriptionProfileRoot(root, "organization-1", "account-1")).resolves.toBe(true);
    await expect(lstat(profile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(forgetSubscriptionProfileRoot(root, "organization-1", "account-1")).resolves.toBe(false);
  });

  it("profile 경로가 symlink로 바뀌면 대상 바깥을 삭제하지 않고 실패 폐쇄한다", async () => {
    const rootPath = join(tmpdir(), `massion-profile-symlink-${crypto.randomUUID()}`);
    const outsidePath = join(tmpdir(), `massion-profile-outside-${crypto.randomUUID()}`);
    roots.push(rootPath, outsidePath);
    await Promise.all([
      mkdir(rootPath, { recursive: true, mode: 0o700 }),
      mkdir(outsidePath, { recursive: true, mode: 0o700 }),
    ]);
    const [root, outside] = await Promise.all([realpath(rootPath), realpath(outsidePath)]);
    const profile = await prepareSubscriptionProfileRoot(root, "organization-2", "account-2");
    await rm(profile, { recursive: true, force: true });
    await symlink(outside, profile, "dir");

    await expect(forgetSubscriptionProfileRoot(root, "organization-2", "account-2")).rejects.toThrow(/symlink|안전/u);
    await expect(lstat(outside)).resolves.toMatchObject({});
  });
});
