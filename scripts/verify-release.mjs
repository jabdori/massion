import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;

async function digest(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export async function verifyReleaseArtifacts(directory, manifest) {
  if (manifest?.schema !== "massion.release.v1" || manifest.version !== "1.0.0" || !Array.isArray(manifest.artifacts))
    throw new Error("release manifest가 유효하지 않습니다");
  for (const artifact of manifest.artifacts) {
    if (
      !artifact ||
      typeof artifact.name !== "string" ||
      basename(artifact.name) !== artifact.name ||
      !Number.isSafeInteger(artifact.bytes) ||
      !DIGEST.test(artifact.digest)
    )
      throw new Error("release artifact manifest가 유효하지 않습니다");
    const path = resolve(directory, artifact.name);
    const metadata = await stat(path);
    if (metadata.size !== artifact.bytes || `sha256:${await digest(path)}` !== artifact.digest)
      throw new Error(`release artifact가 manifest와 다릅니다: ${artifact.name}`);
  }
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    env: options.environment ?? process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (result.status !== 0)
    throw new Error(`${command} ${arguments_.join(" ")} 실행이 실패했습니다: ${String(result.stderr).slice(0, 2048)}`);
  return result.stdout;
}

function jsonOutput(command, arguments_, environment) {
  return JSON.parse(String(run(command, arguments_, { environment })).trim());
}

async function waitReady(endpoint) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await globalThis.fetch(`${endpoint}/health/ready`, {
        signal: globalThis.AbortSignal.timeout(1_000),
      });
      if (response.ok) return await response.json();
    } catch {
      // 다음 bounded attempt에서 다시 확인합니다.
    }
    await new Promise((resolveWait) => globalThis.setTimeout(resolveWait, 250));
  }
  throw new Error(`release server readiness 시간이 초과됐습니다: ${endpoint}`);
}

export function restoreEnvironmentForRelease(environment, input) {
  return {
    ...environment,
    MASSION_MODE: "local",
    MASSION_DATABASE_URL: input.databaseUrl,
    MASSION_TOKEN_KEY_FILE: input.tokenKeyFile,
    MASSION_CREDENTIAL_KEY_FILE: input.credentialKeyFile,
    MASSION_SOFTWARE_WORKSPACE_ROOT: input.workspaceRoot,
    MASSION_CONNECTOR_ROOT: input.connectorRoot,
  };
}

async function main() {
  const root = resolve(fileURLToPath(new globalThis.URL("..", import.meta.url)));
  const release = resolve(root, process.argv[2] ?? "artifacts/release-1.0.0");
  const manifest = JSON.parse(await readFile(resolve(release, "release-manifest.json"), "utf8"));
  await verifyReleaseArtifacts(release, manifest);
  const temporary = await mkdtemp(join(tmpdir(), "massion-release-e2e-"));
  const home = resolve(temporary, "home");
  const prefix = resolve(temporary, "prefix");
  const extracted = resolve(temporary, "extracted");
  const localPort = 20_000 + (process.pid % 20_000);
  const restorePort = localPort + 10;
  let restoreProcess;
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(prefix, { recursive: true, mode: 0o700 });
  await mkdir(extracted, { recursive: true, mode: 0o700 });
  const environment = {
    ...process.env,
    HOME: home,
    MASSION_PREFIX: prefix,
    MASSION_LOCAL_PORT: String(localPort),
    PATH: `${resolve(prefix, "bin")}:${process.env.PATH ?? ""}`,
  };
  const mass = resolve(prefix, "bin/mass");
  const connector = resolve(prefix, "bin/massion-connector");
  try {
    run("tar", ["-xzf", resolve(release, "massion-local-1.0.0.tar.gz"), "-C", extracted]);
    run(resolve(extracted, "install.sh"), [], { environment, inherit: true });
    if (String(run(mass, ["version"], { environment })).trim() !== "Massion AgentOS 1.0.0")
      throw new Error("설치된 mass version이 일치하지 않습니다");
    if (!String(run(connector, ["--help"], { environment })).includes("doctor"))
      throw new Error("설치된 massion-connector 도움말이 유효하지 않습니다");
    const connectorDoctor = jsonOutput(connector, ["doctor"], environment);
    if (
      connectorDoctor?.schema !== "massion.connector-doctor.v1" ||
      connectorDoctor.status !== "ready" ||
      connectorDoctor.runtime !== "bundled"
    )
      throw new Error("설치된 massion-connector runtime 진단이 유효하지 않습니다");
    const started = jsonOutput(mass, ["local", "start", "--json"], environment);
    if (started.status !== "started" || started.endpoint !== `http://127.0.0.1:${String(localPort)}`)
      throw new Error("설치된 local server가 시작되지 않았습니다");
    jsonOutput(
      mass,
      ["init", `http://127.0.0.1:${String(localPort)}`, "owner@example.com", "Release Owner", "--json"],
      environment,
    );
    const status = jsonOutput(mass, ["status", "--json"], environment);
    if (status?.data?.status !== "ready" || status?.data?.modelRuntime !== "limited")
      throw new Error("release limited mode 상태가 유효하지 않습니다");
    const runResult = jsonOutput(mass, ["run", "release E2E", "--detach", "--json"], environment);
    if (runResult.type !== "accepted") throw new Error("release Work가 접수되지 않았습니다");
    const backup = resolve(home, "massion-release-backup.json");
    const backedUp = jsonOutput(mass, ["local", "backup", backup, "--json"], environment);
    if (backedUp.status !== "backed-up") throw new Error("release backup이 완료되지 않았습니다");
    if ((await stat(backup)).mode & 0o077) throw new Error("release backup은 owner-only여야 합니다");
    jsonOutput(mass, ["local", "stop", "--json"], environment);

    const tokenKey = resolve(home, ".config/massion/token-key");
    const credentialKey = resolve(home, ".config/massion/credential-key");
    const restoredDatabase = resolve(home, ".local/share/massion-restore.db");
    const server = resolve(prefix, "bin/massion-server");
    const restoreEnvironment = restoreEnvironmentForRelease(environment, {
      databaseUrl: `rocksdb://${restoredDatabase}`,
      tokenKeyFile: tokenKey,
      credentialKeyFile: credentialKey,
      workspaceRoot: resolve(home, ".local/share/massion/restore-workspaces"),
      connectorRoot: resolve(home, ".local/share/massion/restore-connectors"),
    });
    run(server, ["restore", backup], { environment: restoreEnvironment });
    restoreProcess = spawn(server, [], {
      env: {
        ...restoreEnvironment,
        MASSION_HTTP_PORT: String(restorePort),
        MASSION_REGISTRY_PORT: String(restorePort + 1),
        MASSION_METRICS_PORT: String(restorePort + 2),
      },
      stdio: "ignore",
    });
    const restored = await waitReady(`http://127.0.0.1:${String(restorePort)}`);
    if (restored?.status !== "ready") throw new Error("복구된 release database가 준비되지 않았습니다");
    restoreProcess.kill("SIGTERM");
    const exit = await new Promise((resolveExit) =>
      restoreProcess.once("exit", (code, signal) => resolveExit({ code, signal })),
    );
    if (JSON.stringify(exit) !== JSON.stringify({ code: 0, signal: null }))
      throw new Error("복구된 release server가 정상 종료되지 않았습니다");
    restoreProcess = undefined;
    run(resolve(prefix, "lib/massion/1.0.0/uninstall.sh"), [], { environment, inherit: true });
    for (const command of ["mass", "massion-connector", "massion-server", "massion-tui"]) {
      await access(resolve(prefix, "bin", command)).then(
        () => {
          throw new Error(`uninstall 뒤 ${command} symlink가 남았습니다`);
        },
        () => undefined,
      );
    }
    await access(resolve(home, ".local/share/massion"));
    process.stdout.write(
      `${JSON.stringify({ status: "passed", version: "1.0.0", mode: "limited", connector: "ready", backup: "restored", uninstall: "data-preserved" })}\n`,
    );
  } finally {
    if (restoreProcess) restoreProcess.kill("SIGTERM");
    if (
      await access(mass).then(
        () => true,
        () => false,
      )
    )
      spawnSync(mass, ["local", "stop", "--json"], { env: environment, stdio: "ignore" });
    await rm(temporary, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) await main();
