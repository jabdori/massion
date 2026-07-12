import { chmod, mkdir, stat, symlink } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertSecureProviderProfileRoot,
  ProviderProfileOwnershipError,
  ProviderProfilePathError,
  ProviderProfilePermissionError,
  secureProviderProfileRoot,
} from "./profile-permissions.js";
import { fixtureDirectory } from "./test-fixtures.js";

describe("Provider profile 디렉터리 권한", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
  });

  it("현재 사용자 소유의 owner-only 0700 디렉터리만 실행 profile로 허용한다", async () => {
    const fixture = await fixtureDirectory("massion-profile-permission-safe-");
    cleanups.push(fixture.cleanup);
    const profileRoot = join(fixture.path, "profile");
    await mkdir(profileRoot, { mode: 0o700 });

    await expect(assertSecureProviderProfileRoot(profileRoot)).resolves.toBe(profileRoot);

    await chmod(profileRoot, 0o755);
    await expect(assertSecureProviderProfileRoot(profileRoot)).rejects.toMatchObject({
      name: "ProviderProfilePermissionError",
      code: "profile-permissions-required",
    });
    expect(new ProviderProfilePermissionError()).toBeInstanceOf(Error);
    expect((await stat(profileRoot)).mode & 0o777).toBe(0o755);

    await chmod(profileRoot, 0o2700);
    await expect(assertSecureProviderProfileRoot(profileRoot)).rejects.toThrow(/0700|secure-profile/u);
  });

  it("secure-profile 명령용 migration은 현재 사용자 소유를 확인한 뒤에만 0700으로 바꾼다", async () => {
    const fixture = await fixtureDirectory("massion-profile-permission-migration-");
    cleanups.push(fixture.cleanup);
    const profileRoot = join(fixture.path, "profile");
    await mkdir(profileRoot, { mode: 0o755 });

    await expect(secureProviderProfileRoot(profileRoot)).resolves.toBe(profileRoot);
    expect((await stat(profileRoot)).mode & 0o777).toBe(0o700);

    await chmod(profileRoot, 0o755);
    const owner = (await stat(profileRoot)).uid;
    vi.spyOn(process, "getuid").mockReturnValue(owner + 1);
    await expect(secureProviderProfileRoot(profileRoot)).rejects.toMatchObject({
      name: "ProviderProfileOwnershipError",
      code: "profile-ownership-invalid",
    });
    expect(new ProviderProfileOwnershipError()).toBeInstanceOf(Error);
    expect((await stat(profileRoot)).mode & 0o777).toBe(0o755);
  });

  it("symlink profile은 검증과 migration 모두에서 거부한다", async () => {
    const fixture = await fixtureDirectory("massion-profile-permission-link-");
    cleanups.push(fixture.cleanup);
    const target = join(fixture.path, "profile");
    const link = join(fixture.path, "profile-link");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, link);

    await expect(assertSecureProviderProfileRoot(link)).rejects.toMatchObject({ code: "profile-path-invalid" });
    await expect(secureProviderProfileRoot(link)).rejects.toMatchObject({ code: "profile-path-invalid" });
    expect(new ProviderProfilePathError()).toBeInstanceOf(Error);
  });

  it("현재 사용자 ID를 확인할 수 없는 platform에서는 chmod 없이 fail-closed한다", async () => {
    const fixture = await fixtureDirectory("massion-profile-permission-no-uid-");
    cleanups.push(fixture.cleanup);
    const profileRoot = join(fixture.path, "profile");
    await mkdir(profileRoot, { mode: 0o755 });
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    try {
      await expect(secureProviderProfileRoot(profileRoot)).rejects.toMatchObject({
        code: "profile-ownership-invalid",
      });
      expect((await stat(profileRoot)).mode & 0o777).toBe(0o755);
    } finally {
      if (descriptor) Object.defineProperty(process, "getuid", descriptor);
    }
  });
});
