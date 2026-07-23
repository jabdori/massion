import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildEnvironment,
  deployArguments,
  stageBundledExtensions,
  updateRuntimeStageStamp,
  validateStage,
} from "./stage-runtime.mjs";
import { runtimePlatformForTarget, stageRuntimeInput } from "./prepare-runtime.mjs";

const manifest = {
  bridge: { destination: "desktop-bridge", entry: "dist/entry.js" },
  server: { destination: "server", entry: "dist/main.js" },
};

async function portablePackage(directory, name, entry) {
  await mkdir(path.dirname(path.join(directory, entry)), { recursive: true });
  await mkdir(path.join(directory, "node_modules", "dependency"), { recursive: true });
  await writeFile(path.join(directory, entry), "export {};\n");
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ name, type: "module", dependencies: { dependency: "1.0.0" } }),
  );
  await writeFile(path.join(directory, "node_modules", "dependency", "package.json"), "{}");
}

test("staging은 bridge와 server의 의존성을 자신의 경계 안에 보존한다", async () => {
  const stage = path.join(os.tmpdir(), `massion-stage-${process.pid}-${Date.now()}`);
  await mkdir(stage, { recursive: true });
  try {
    await portablePackage(path.join(stage, "desktop-bridge"), "@massion/desktop-bridge", "dist/entry.js");
    await portablePackage(path.join(stage, "server"), "@massion/server", "dist/main.js");
    await validateStage(stage, manifest);

    const outside = path.join(os.tmpdir(), `massion-stage-outside-${process.pid}-${Date.now()}`);
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(stage, "server/node_modules/dependency/escape"));
    await assert.rejects(validateStage(stage, manifest), /symbolic link/);
    await rm(path.join(stage, "server/node_modules/dependency/escape"));
    await rm(outside, { recursive: true, force: true });

    await rm(path.join(stage, "server/node_modules/dependency"), { recursive: true, force: true });
    await assert.rejects(validateStage(stage, manifest), /staging 경계에 없습니다/);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test("Tauri resource copy 전에도 직접 runtime 의존성은 symlink가 아니어야 한다", async () => {
  const stage = path.join(os.tmpdir(), `massion-stage-direct-dependency-${process.pid}-${Date.now()}`);
  await mkdir(stage, { recursive: true });
  try {
    const bridge = path.join(stage, "desktop-bridge");
    await portablePackage(bridge, "@massion/desktop-bridge", "dist/entry.js");
    await portablePackage(path.join(stage, "server"), "@massion/server", "dist/main.js");
    const dependency = path.join(bridge, "node_modules", "dependency");
    await rename(dependency, `${dependency}-physical`);
    await symlink("dependency-physical", dependency);

    await assert.rejects(validateStage(stage, manifest), /직접 의존성.*symbolic link/u);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test("검증된 SurrealDB 실행 파일만 Tauri sidecar 입력으로 복사한다", async (context) => {
  const root = path.join(os.tmpdir(), `massion-runtime-input-${process.pid}-${Date.now()}`);
  const source = path.join(root, "source/surreal");
  const destination = path.join(root, "binaries/surrealdb-aarch64-apple-darwin");
  context.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, "#!/bin/sh\nprintf 'SurrealDB 3.2.1\\n'\n");
  await chmod(source, 0o700);
  const sha256 = createHash("sha256").update(await readFile(source)).digest("hex");

  await stageRuntimeInput({ destination, expectedSha256: sha256, source });

  assert.equal(await readFile(destination, "utf8"), await readFile(source, "utf8"));
  assert.notEqual((await stat(destination)).mode & 0o111, 0);
  await assert.rejects(
    stageRuntimeInput({ destination: path.join(root, "binaries/invalid"), expectedSha256: "0".repeat(64), source }),
    /SHA-256/u,
  );
});

test("Apple Silicon desktop manifest는 host 추정 없이 Apple Silicon runtime을 준비한다", () => {
  assert.deepEqual(runtimePlatformForTarget("aarch64-apple-darwin"), { platform: "darwin", architecture: "arm64" });
  assert.throws(() => runtimePlatformForTarget("x86_64-unknown-linux-gnu"), /지원하지 않는/u);
});

test("runtime staging의 pnpm 명령은 비대화 환경에서도 의존성 배치를 진행한다", () => {
  const arguments_ = deployArguments("@massion/desktop-bridge", "target");
  assert.deepEqual(arguments_, [
    "--config.inject-workspace-packages=true",
    "--config.node-linker=hoisted",
    "--filter",
    "@massion/desktop-bridge",
    "--prod",
    "deploy",
    "target",
  ]);
});

test("릴리스 앱 전용 빌드는 최신 renderer와 runtime stage를 같은 작업 디렉터리에서 준비한다", async () => {
  const desktop = path.resolve(import.meta.dirname, "..");
  const packageJson = JSON.parse(await readFile(path.join(desktop, "package.json"), "utf8"));
  const release = JSON.parse(await readFile(path.join(desktop, "src-tauri/tauri.release.conf.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(desktop, "src-tauri/runtime-stage.manifest.json"), "utf8"));

  assert.equal(packageJson.scripts["tauri:build"], "cargo tauri build --bundles app --config src-tauri/tauri.release.conf.json");
  assert.equal(release.build.beforeBuildCommand, "pnpm build && node src-tauri/stage-runtime.mjs");
  assert.deepEqual(manifest.build, ["@massion/server", "@massion/desktop-bridge"]);
  assert.match(await readFile(path.join(desktop, "src-tauri/build.rs"), "utf8"), /rerun-if-changed=.runtime-stage\.stamp/);
});

test("변경된 runtime stage만 Cargo 감시 stamp를 갱신한다", async (context) => {
  const root = path.join(os.tmpdir(), `massion-runtime-stage-stamp-${process.pid}-${Date.now()}`);
  const stage = path.join(root, ".runtime-stage");
  const stamp = path.join(root, ".runtime-stage.stamp");
  context.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(stage, { recursive: true });
  await writeFile(path.join(stage, "runtime.js"), "export const revision = 1;\n");

  assert.equal(await updateRuntimeStageStamp(stage, stamp), true);
  const first = await readFile(stamp, "utf8");
  assert.equal(await updateRuntimeStageStamp(stage, stamp), false);
  assert.equal(await readFile(stamp, "utf8"), first);

  await writeFile(path.join(stage, "runtime.js"), "export const revision = 2;\n");
  assert.equal(await updateRuntimeStageStamp(stage, stamp), true);
  assert.notEqual(await readFile(stamp, "utf8"), first);
});

test("runtime staging의 workspace build는 의존성 검사 결과를 경고로만 보고 작업 트리를 변경하지 않는다", () => {
  assert.deepEqual(buildEnvironment({ PATH: "/runtime/bin" }), {
    PATH: "/runtime/bin",
    pnpm_config_verify_deps_before_run: "warn",
  });
});

test("공식 Extension packaging은 세 개의 검증용 artifact metadata를 runtime resource에 기록한다", async () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const destination = path.join(os.tmpdir(), `massion-official-extensions-${process.pid}-${Date.now()}`);
  try {
    await stageBundledExtensions(root, destination);
    const entries = JSON.parse(await readFile(path.join(destination, "official-extensions.json"), "utf8"));
    assert.deepEqual(entries.map((entry) => entry.packageName).sort(), ["@massion-ext/discord", "@massion-ext/github", "@massion-ext/slack"]);
    for (const entry of entries) {
      assert.match(entry.artifactDigest, /^[a-f0-9]{64}$/);
      assert.equal((await stat(path.join(destination, entry.archive))).isFile(), true);
    }
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}, 30_000);
