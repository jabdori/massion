import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = "1.0.0";
const ownerMarker = "massion-local-1.0.0";
const commands = ["massion", "massion-connector", "massion-server"];

function nativeRuntime() {
  const operatingSystem = process.platform === "darwin" ? "darwin" : "linux";
  const architecture = process.arch === "arm64" ? "arm64" : "amd64";
  const platform = `${operatingSystem}-${architecture}`;
  return {
    version: "3.2.1",
    platform,
    binary: `runtime/surrealdb/3.2.1/${platform}/surreal`,
  };
}

async function filesUnder(path) {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(child)));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function writeChecksums(bundle) {
  const lines = [];
  for (const path of await filesUnder(bundle)) {
    const name = relative(bundle, path).split(sep).join("/");
    if (name === "SHA256SUMS") continue;
    const digest = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    lines.push(`${digest}  ${name}`);
  }
  await writeFile(join(bundle, "SHA256SUMS"), `${lines.sort().join("\n")}\n`, { mode: 0o600 });
}

async function makeBundle(context) {
  const root = await mkdtemp(join(tmpdir(), "massion release install "));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const bundle = join(root, "release bundle");
  const prefix = join(root, "personal prefix");
  await mkdir(bundle, { recursive: true, mode: 0o700 });
  await cp(join(repositoryRoot, "release/install.sh"), join(bundle, "install.sh"));
  await cp(join(repositoryRoot, "release/uninstall.sh"), join(bundle, "uninstall.sh"));
  await cp(join(repositoryRoot, "release/update.sh"), join(bundle, "update.sh"));
  await chmod(join(bundle, "install.sh"), 0o700);
  await chmod(join(bundle, "uninstall.sh"), 0o700);
  await chmod(join(bundle, "update.sh"), 0o700);

  const entrypoints = {
    massion: "runtime/node_modules/@massion/cli/dist/main.js",
    connector: "runtime/node_modules/@massion/connector/dist/main.js",
    server: "runtime/node_modules/@massion/server/dist/main.js",
    tui: "runtime/node_modules/@massion/tui/dist/main.js",
  };
  for (const path of Object.values(entrypoints)) {
    const absolute = join(bundle, path);
    await mkdir(dirname(absolute), { recursive: true });
    const content =
      path === entrypoints.massion
        ? "#!/usr/bin/env node\nif (process.argv[2] === 'native-runtime') process.stdout.write(JSON.stringify({ binary: process.env.MASSION_SURREAL_BINARY, sha256: process.env.MASSION_SURREAL_SHA256 }));\nelse process.stdout.write('fixture runtime\\n');\n"
        : "#!/usr/bin/env node\nprocess.stdout.write('fixture runtime\\n');\n";
    await writeFile(absolute, content, {
      mode: 0o600,
    });
  }
  const surreal = nativeRuntime();
  const nativeBinary = join(bundle, surreal.binary);
  await mkdir(dirname(nativeBinary), { recursive: true });
  await writeFile(nativeBinary, "#!/bin/sh\nprintf '3.2.1 for fixture\\n'\n", { mode: 0o700 });
  await chmod(nativeBinary, 0o700);
  surreal.sha256 = createHash("sha256")
    .update(await readFile(nativeBinary))
    .digest("hex");
  await writeFile(
    join(bundle, "release-bundle.json"),
    `${JSON.stringify({ schema: "massion.release-bundle.v1", version, entrypoints, nativeRuntime: { surrealdb: surreal } }, undefined, 2)}\n`,
    { mode: 0o600 },
  );
  await mkdir(join(bundle, "web"), { recursive: true });
  await writeFile(join(bundle, "web", "index.html"), "<!doctype html>\n", { mode: 0o600 });
  await writeChecksums(bundle);
  return { bundle, prefix, root, surreal };
}

function runScript(script, prefix, environment = {}) {
  return spawnSync("sh", [script], {
    encoding: "utf8",
    env: { ...process.env, MASSION_PREFIX: prefix, ...environment },
    timeout: 30_000,
  });
}

function assertSucceeded(result) {
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

test("공백이 있는 개인 경로에 connector를 설치하고 진단한 뒤 안전하게 제거한다", async (context) => {
  const { bundle, prefix } = await makeBundle(context);
  assertSucceeded(runScript(join(bundle, "install.sh"), prefix));

  const release = join(prefix, "lib/massion", version);
  assert.equal(await readFile(join(release, ".massion-install-owner"), "utf8"), `${ownerMarker}\n`);
  assert.equal((await stat(release)).mode & 0o777, 0o700);
  assert.match(await readFile(join(release, "bin/massion"), "utf8"), /local ensure/u);
  assert.match(
    await readFile(join(release, "bin/massion"), "utf8"),
    /runtime\/node_modules\/@massion\/cli\/dist\/main\.js" init/u,
  );
  assert.match(await readFile(join(release, "bin/massion"), "utf8"), /status --json.*main\.js" init/su);
  assert.equal((await lstat(join(release, "update.sh"))).isFile(), true);
  assert.match(await readFile(join(release, "bin/massion"), "utf8"), /MASSION_UPDATE_BIN/u);
  for (const command of commands) {
    const link = join(prefix, "bin", command);
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal(await readlink(link), join(release, "bin", command));
    const wrapperMode = (await stat(join(release, "bin", command))).mode & 0o777;
    assert.equal(wrapperMode & 0o077, 0, `${command} wrapper는 소유자 전용이어야 합니다`);
    assert.notEqual(wrapperMode & 0o100, 0, `${command} wrapper는 실행 가능해야 합니다`);
  }

  const connector = join(prefix, "bin/massion-connector");
  const help = spawnSync(connector, ["--help"], { encoding: "utf8", timeout: 10_000 });
  assertSucceeded(help);
  assert.match(help.stdout, /doctor/u);
  assert.match(help.stdout, /secure-profile/u);
  const doctor = spawnSync(connector, ["doctor"], { encoding: "utf8", timeout: 10_000 });
  assertSucceeded(doctor);
  assert.deepEqual(JSON.parse(doctor.stdout), {
    schema: "massion.connector-doctor.v1",
    status: "ready",
    runtime: "bundled",
  });

  assertSucceeded(runScript(join(release, "uninstall.sh"), prefix));
  await assert.rejects(async () => await lstat(release), { code: "ENOENT" });
  for (const command of commands) {
    await assert.rejects(async () => await lstat(join(prefix, "bin", command)), { code: "ENOENT" });
  }
});

test("설치기는 native SurrealDB binary를 XDG cache로 복사하고 massion에 검증 metadata를 전달한다", async (context) => {
  const { bundle, prefix, root, surreal } = await makeBundle(context);
  const home = join(root, "home");
  const dataHome = join(root, "xdg-data");
  await mkdir(home, { recursive: true, mode: 0o700 });

  assertSucceeded(runScript(join(bundle, "install.sh"), prefix, { HOME: home, XDG_DATA_HOME: dataHome }));

  const cached = join(dataHome, "massion", surreal.binary);
  assert.equal(await readFile(cached, "utf8"), await readFile(join(bundle, surreal.binary), "utf8"));
  assert.equal((await stat(cached)).mode & 0o777, 0o700);
  const launched = spawnSync(join(prefix, "bin/massion"), ["native-runtime"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome },
    timeout: 10_000,
  });
  assertSucceeded(launched);
  assert.deepEqual(JSON.parse(launched.stdout), { binary: cached, sha256: surreal.sha256 });
});

test("기존 외부 connector 실행 파일을 덮어쓰지 않고 설치 전 상태를 보존한다", async (context) => {
  const { bundle, prefix } = await makeBundle(context);
  const external = join(prefix, "bin/massion-connector");
  await mkdir(dirname(external), { recursive: true });
  await writeFile(external, "external connector\n", { mode: 0o700 });

  const result = runScript(join(bundle, "install.sh"), prefix);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(external, "utf8"), "external connector\n");
  await assert.rejects(async () => await lstat(join(prefix, "lib/massion", version)), { code: "ENOENT" });
  for (const command of commands.filter((name) => name !== "massion-connector")) {
    await assert.rejects(async () => await lstat(join(prefix, "bin", command)), { code: "ENOENT" });
  }
});

test("설치 도중 link 생성이 실패하면 이전 release와 명령을 원상 복구한다", async (context) => {
  const { bundle, prefix, root } = await makeBundle(context);
  assertSucceeded(runScript(join(bundle, "install.sh"), prefix));
  const release = join(prefix, "lib/massion", version);
  await writeFile(join(release, "previous-install-sentinel"), "preserve me\n", { mode: 0o600 });

  const tools = join(root, "failing tools");
  await mkdir(tools, { mode: 0o700 });
  const realLn = spawnSync("sh", ["-c", "command -v ln"], { encoding: "utf8" }).stdout.trim();
  const fakeLn = join(tools, "ln");
  await writeFile(
    fakeLn,
    `#!/bin/sh\ncount=0\nif [ -f "$FAKE_LN_COUNT" ]; then count=$(sed -n '1p' "$FAKE_LN_COUNT"); fi\ncount=$((count + 1))\nprintf '%s\\n' "$count" >"$FAKE_LN_COUNT"\nif [ "$count" -eq 2 ]; then exit 97; fi\nexec "$REAL_LN" "$@"\n`,
    { mode: 0o700 },
  );
  const result = runScript(join(bundle, "install.sh"), prefix, {
    FAKE_LN_COUNT: join(root, "ln-count"),
    PATH: `${tools}:${process.env.PATH}`,
    REAL_LN: realLn,
  });

  assert.notEqual(result.status, 0);
  assert.equal(await readFile(join(release, "previous-install-sentinel"), "utf8"), "preserve me\n");
  for (const command of commands) {
    assert.equal(await readlink(join(prefix, "bin", command)), join(release, "bin", command));
  }
});

test("소유 표식이 없는 기존 release directory를 제거하거나 교체하지 않는다", async (context) => {
  const { bundle, prefix } = await makeBundle(context);
  const release = join(prefix, "lib/massion", version);
  await mkdir(release, { recursive: true });
  await writeFile(join(release, "external-sentinel"), "external release\n");

  const result = runScript(join(bundle, "install.sh"), prefix);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(join(release, "external-sentinel"), "utf8"), "external release\n");
  for (const command of commands) {
    await assert.rejects(async () => await lstat(join(prefix, "bin", command)), { code: "ENOENT" });
  }
});

test("제거 중 외부 파일로 교체된 connector 명령은 보존한다", async (context) => {
  const { bundle, prefix } = await makeBundle(context);
  assertSucceeded(runScript(join(bundle, "install.sh"), prefix));
  const release = join(prefix, "lib/massion", version);
  const connector = join(prefix, "bin/massion-connector");
  await rm(connector);
  await writeFile(connector, "external replacement\n", { mode: 0o700 });

  assertSucceeded(runScript(join(release, "uninstall.sh"), prefix));
  assert.equal(await readFile(connector, "utf8"), "external replacement\n");
  await assert.rejects(async () => await lstat(release), { code: "ENOENT" });
});

test("release 밖의 제거 스크립트는 설치된 파일을 삭제할 수 없다", async (context) => {
  const { bundle, prefix } = await makeBundle(context);
  assertSucceeded(runScript(join(bundle, "install.sh"), prefix));
  const release = join(prefix, "lib/massion", version);

  const refused = runScript(join(bundle, "uninstall.sh"), prefix);
  assert.notEqual(refused.status, 0);
  assert.equal(await readFile(join(release, ".massion-install-owner"), "utf8"), `${ownerMarker}\n`);
  for (const command of commands) {
    assert.equal(await readlink(join(prefix, "bin", command)), join(release, "bin", command));
  }

  assertSucceeded(runScript(join(release, "uninstall.sh"), prefix));
});

test("관리 대상 하위 directory가 symlink이면 외부 경로를 따라가지 않는다", async (context) => {
  for (const target of ["bin", "lib/massion"]) {
    const { bundle, prefix, root } = await makeBundle(context);
    const external = join(root, `external ${target.replaceAll("/", "-")}`);
    const managed = join(prefix, target);
    await mkdir(external, { recursive: true });
    await mkdir(dirname(managed), { recursive: true });
    await symlink(external, managed, "dir");

    const result = runScript(join(bundle, "install.sh"), prefix);
    assert.notEqual(result.status, 0, `${target} symlink 설치는 거부되어야 합니다`);
    assert.deepEqual(await readdir(external), [], `${target} symlink의 외부 대상은 변경되면 안 됩니다`);
  }
});

test("설치 prefix 자체가 symlink이면 외부 대상에 파일을 만들지 않는다", async (context) => {
  const { bundle, prefix, root } = await makeBundle(context);
  const external = join(root, "external prefix target");
  await mkdir(external, { mode: 0o700 });
  await symlink(external, prefix, "dir");

  const result = runScript(join(bundle, "install.sh"), prefix);

  assert.notEqual(result.status, 0);
  assert.deepEqual(await readdir(external), []);
});

test("관리 대상 하위 경로가 directory가 아니면 설치하지 않는다", async (context) => {
  for (const target of ["bin", "lib", "lib/massion"]) {
    const { bundle, prefix } = await makeBundle(context);
    const managed = join(prefix, target);
    await mkdir(dirname(managed), { recursive: true });
    await writeFile(managed, "external path\n", { mode: 0o600 });

    const result = runScript(join(bundle, "install.sh"), prefix);
    assert.notEqual(result.status, 0, `${target} 일반 파일 설치는 거부되어야 합니다`);
    assert.equal(await readFile(managed, "utf8"), "external path\n");
  }
});

test("제거 시 bin directory가 symlink로 바뀌면 외부 대상을 건드리지 않는다", async (context) => {
  const { bundle, prefix, root } = await makeBundle(context);
  assertSucceeded(runScript(join(bundle, "install.sh"), prefix));
  const release = join(prefix, "lib/massion", version);
  const bin = join(prefix, "bin");
  const originalBin = join(root, "original bin");
  const external = join(root, "external uninstall bin");
  await rename(bin, originalBin);
  await mkdir(external);
  await symlink(external, bin, "dir");

  const refused = runScript(join(release, "uninstall.sh"), prefix);
  assert.notEqual(refused.status, 0);
  assert.deepEqual(await readdir(external), []);
  assert.equal(await readFile(join(release, ".massion-install-owner"), "utf8"), `${ownerMarker}\n`);

  await rm(bin);
  await rename(originalBin, bin);
  assertSucceeded(runScript(join(release, "uninstall.sh"), prefix));
});
