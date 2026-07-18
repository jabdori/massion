import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
export const PUBLIC_RELEASE_COMMANDS = ["massion", "massion-connector"];

export function releaseVerificationEnvironment({ home, prefix, localPort, environment = process.env }) {
  if (!Number.isSafeInteger(localPort) || localPort < 2 || localPort > 65_535)
    throw new Error("release local port가 유효하지 않습니다");
  return {
    ...environment,
    HOME: home,
    MASSION_PREFIX: prefix,
    MASSION_LOCAL_PORT: String(localPort),
    MASSION_SURREAL_PORT: String(localPort - 1),
    PATH: `${resolve(prefix, "bin")}:${environment.PATH ?? ""}`,
  };
}

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
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(prefix, { recursive: true, mode: 0o700 });
  await mkdir(extracted, { recursive: true, mode: 0o700 });
  const environment = releaseVerificationEnvironment({ home, prefix, localPort });
  const massion = resolve(prefix, "bin/massion");
  const connector = resolve(prefix, "bin/massion-connector");
  try {
    run("tar", ["-xzf", resolve(release, "massion-local-1.0.0.tar.gz"), "-C", extracted]);
    run(resolve(extracted, "install.sh"), [], { environment, inherit: true });
    if (String(run(massion, ["version"], { environment })).trim() !== "Massion AgentOS 1.0.0")
      throw new Error("설치된 massion version이 일치하지 않습니다");
    if (!String(run(connector, ["--help"], { environment })).includes("doctor"))
      throw new Error("설치된 massion-connector 도움말이 유효하지 않습니다");
    const connectorDoctor = jsonOutput(connector, ["doctor"], environment);
    if (
      connectorDoctor?.schema !== "massion.connector-doctor.v1" ||
      connectorDoctor.status !== "ready" ||
      connectorDoctor.runtime !== "bundled"
    )
      throw new Error("설치된 massion-connector runtime 진단이 유효하지 않습니다");
    const prepared = jsonOutput(massion, ["local", "ensure", "--json"], environment);
    if (prepared.status !== "ready" || prepared.endpoint !== `http://127.0.0.1:${String(localPort)}`)
      throw new Error("설치된 local runtime이 준비되지 않았습니다");
    jsonOutput(
      massion,
      ["init", `http://127.0.0.1:${String(localPort)}`, "owner@example.com", "Release Owner", "--json"],
      environment,
    );
    const status = jsonOutput(massion, ["status", "--json"], environment);
    if (status?.data?.status !== "ready" || status?.data?.modelRuntime !== "limited")
      throw new Error("release limited mode 상태가 유효하지 않습니다");
    const runResult = jsonOutput(massion, ["run", "release E2E", "--detach", "--json"], environment);
    if (runResult.type !== "accepted") throw new Error("release Work가 접수되지 않았습니다");
    const backup = resolve(home, "massion-release-backup.json");
    const backedUp = jsonOutput(massion, ["local", "backup", backup, "--json"], environment);
    if (backedUp.status !== "backed-up") throw new Error("release backup이 완료되지 않았습니다");
    if ((await stat(backup)).mode & 0o077) throw new Error("release backup은 owner-only여야 합니다");
    jsonOutput(massion, ["local", "stop", "--json"], environment);
    run(resolve(prefix, "lib/massion/1.0.0/uninstall.sh"), [], { environment, inherit: true });
    for (const command of PUBLIC_RELEASE_COMMANDS) {
      await access(resolve(prefix, "bin", command)).then(
        () => {
          throw new Error(`uninstall 뒤 ${command} symlink가 남았습니다`);
        },
        () => undefined,
      );
    }
    await access(resolve(home, ".local/share/massion"));
    process.stdout.write(
      `${JSON.stringify({ status: "passed", version: "1.0.0", mode: "limited", connector: "ready", backup: "created", uninstall: "data-preserved" })}\n`,
    );
  } finally {
    if (
      await access(massion).then(
        () => true,
        () => false,
      )
    )
      spawnSync(massion, ["local", "stop", "--json"], { env: environment, stdio: "ignore" });
    await rm(temporary, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) await main();
