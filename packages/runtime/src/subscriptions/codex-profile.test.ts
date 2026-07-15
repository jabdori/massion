import { chmod, link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  codexFileCredentialStoreArguments,
  ensureManagedCodexProfile,
  managedCodexCredentialState,
} from "./codex-profile.js";

describe("관리 Codex profile", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  it("owner-only config에서 file credential store를 강제한다", async () => {
    const profile = await mkdtemp(join(tmpdir(), "massion-codex-profile-"));
    roots.push(profile);
    await chmod(profile, 0o700);

    await ensureManagedCodexProfile(profile);

    const config = join(profile, "config.toml");
    await expect(readFile(config, "utf8")).resolves.toBe('cli_auth_credentials_store = "file"\n');
    expect((await lstat(config)).mode & 0o777).toBe(0o600);
    expect(codexFileCredentialStoreArguments(["/runtime/codex.js"])).toEqual([
      "/runtime/codex.js",
      "--config",
      'cli_auth_credentials_store = "file"',
    ]);
  });

  it("기존의 owner-only Codex config는 보존하고 실행마다 file credential store를 override한다", async () => {
    const profile = await mkdtemp(join(tmpdir(), "massion-codex-profile-existing-config-"));
    roots.push(profile);
    await chmod(profile, 0o700);
    const config = join(profile, "config.toml");
    await writeFile(config, 'model = "gpt-5.6"\n', { mode: 0o600 });

    await ensureManagedCodexProfile(profile);

    await expect(readFile(config, "utf8")).resolves.toBe('model = "gpt-5.6"\n');
    expect(codexFileCredentialStoreArguments(["/runtime/codex.js", "login"])).toEqual([
      "/runtime/codex.js",
      "login",
      "--config",
      'cli_auth_credentials_store = "file"',
    ]);
  });

  it("다른 OS 사용자가 읽거나 변경할 수 있는 기존 Codex config는 신뢰하지 않고 실패 폐쇄한다", async () => {
    const profile = await mkdtemp(join(tmpdir(), "massion-codex-profile-insecure-config-"));
    roots.push(profile);
    await chmod(profile, 0o700);
    const config = join(profile, "config.toml");
    await writeFile(config, 'model = "gpt-5.6"\n', { mode: 0o644 });

    await expect(ensureManagedCodexProfile(profile)).rejects.toThrow(/owner-only|안전/u);
    expect((await lstat(config)).mode & 0o777).toBe(0o644);
  });

  it("config symlink를 따라가지 않고 실패 폐쇄한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-codex-profile-root-"));
    const outside = await mkdtemp(join(tmpdir(), "massion-codex-profile-outside-"));
    roots.push(root, outside);
    await chmod(root, 0o700);
    const outsideConfig = join(outside, "config.toml");
    await writeFile(outsideConfig, "outside\n", { mode: 0o600 });
    await symlink(outsideConfig, join(root, "config.toml"));

    await expect(ensureManagedCodexProfile(root)).rejects.toThrow(/symlink|안전/u);
    await expect(readFile(outsideConfig, "utf8")).resolves.toBe("outside\n");
  });

  it("관리 profile의 auth.json은 없음을 안전하게 보고하고, owner-only 단일 파일만 재사용한다", async () => {
    const profile = await mkdtemp(join(tmpdir(), "massion-codex-profile-auth-"));
    roots.push(profile);
    await chmod(profile, 0o700);

    await expect(managedCodexCredentialState(profile)).resolves.toBe("missing");
    const auth = join(profile, "auth.json");
    await writeFile(auth, "private-login-state", { mode: 0o600 });
    await expect(managedCodexCredentialState(profile)).resolves.toBe("present");
    await chmod(auth, 0o644);
    await expect(managedCodexCredentialState(profile)).rejects.toThrow(/0600|owner-only|안전/u);
  });

  it("관리 profile의 auth.json symlink와 hard link는 전역 자격 증명 별칭으로 보지 않고 실패 폐쇄한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-codex-profile-auth-root-"));
    const outside = await mkdtemp(join(tmpdir(), "massion-codex-profile-auth-outside-"));
    roots.push(root, outside);
    await chmod(root, 0o700);
    await chmod(outside, 0o700);
    const outsideAuth = join(outside, "auth.json");
    await writeFile(outsideAuth, "outside-private-login-state", { mode: 0o600 });
    const profileAuth = join(root, "auth.json");

    await symlink(outsideAuth, profileAuth);
    await expect(managedCodexCredentialState(root)).rejects.toThrow(/symlink|안전/u);
    await rm(profileAuth);
    await link(outsideAuth, profileAuth);
    await expect(managedCodexCredentialState(root)).rejects.toThrow(/hard link|안전/u);
    await expect(readFile(outsideAuth, "utf8")).resolves.toBe("outside-private-login-state");
  });

  it("관리 Codex config의 hard link도 외부 설정 별칭으로 보지 않고 실패 폐쇄한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-codex-profile-config-root-"));
    const outside = await mkdtemp(join(tmpdir(), "massion-codex-profile-config-outside-"));
    roots.push(root, outside);
    await chmod(root, 0o700);
    await chmod(outside, 0o700);
    const outsideConfig = join(outside, "config.toml");
    await writeFile(outsideConfig, 'model = "gpt-5.6"\n', { mode: 0o600 });
    await link(outsideConfig, join(root, "config.toml"));

    await expect(ensureManagedCodexProfile(root)).rejects.toThrow(/hard link|안전/u);
    await expect(readFile(outsideConfig, "utf8")).resolves.toBe('model = "gpt-5.6"\n');
  });
});
