import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHA256 = /^[a-f0-9]{64}$/u;

export function createReleaseReceipt(input) {
  if (!/^\d+\.\d+\.\d+$/u.test(input.version) || !/^[a-f0-9]{40}$/u.test(input.gitCommit))
    throw new Error("release version 또는 Git commit이 유효하지 않습니다");
  if (
    !SHA256.test(input.sourceDigest) ||
    !SHA256.test(input.sbomDigest) ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.imageId) ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.imageDigest) ||
    !Number.isSafeInteger(input.sbomComponents) ||
    input.sbomComponents < 1
  )
    throw new Error("release digest 또는 SBOM component 수가 유효하지 않습니다");
  return {
    schema: "massion.release-evidence.v1",
    version: input.version,
    gitCommit: input.gitCommit,
    sourceDigest: `sha256:${input.sourceDigest}`,
    imageId: input.imageId,
    imageDigest: input.imageDigest,
    sbom: { format: "CycloneDX", digest: `sha256:${input.sbomDigest}`, components: input.sbomComponents },
  };
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    encoding: options.encoding ?? "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.capture === false ? "inherit" : "pipe",
  });
  if (result.status !== 0)
    throw new Error(`${command} ${arguments_.join(" ")} 실행이 실패했습니다: ${String(result.stderr).slice(0, 1024)}`);
  return result.stdout;
}

async function sourceDigest(root) {
  const paths = String(run("git", ["ls-files", "-z"], { encoding: "buffer" }))
    .split("\0")
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    const body = await readFile(resolve(root, path));
    hash.update(path).update("\0").update(body).update("\0");
  }
  return hash.digest("hex");
}

async function main() {
  const root = resolve(fileURLToPath(new globalThis.URL("..", import.meta.url)));
  const output = resolve(root, process.argv[2] ?? "artifacts/release-1.0.0");
  const image = process.argv[3] ?? "massion:1.0.0";
  await mkdir(output, { recursive: true, mode: 0o700 });
  const sbomText = String(run("docker", ["scout", "sbom", "--format", "cyclonedx", image]));
  const sbom = JSON.parse(sbomText);
  if (sbom.bomFormat !== "CycloneDX" || !Array.isArray(sbom.components) || sbom.components.length < 1)
    throw new Error("CycloneDX SBOM이 유효하지 않습니다");
  const sbomPath = resolve(output, "massion-1.0.0.cdx.json");
  await writeFile(sbomPath, `${JSON.stringify(sbom, undefined, 2)}\n`, { mode: 0o600 });
  const normalizedSbom = await readFile(sbomPath);
  const inspected = JSON.parse(String(run("docker", ["image", "inspect", image])))?.[0];
  const repoDigest = inspected?.RepoDigests?.[0]?.split("@")[1];
  const receipt = createReleaseReceipt({
    version: "1.0.0",
    gitCommit: String(run("git", ["rev-parse", "HEAD"])).trim(),
    sourceDigest: await sourceDigest(root),
    imageId: inspected?.Id,
    imageDigest: repoDigest,
    sbomDigest: createHash("sha256").update(normalizedSbom).digest("hex"),
    sbomComponents: sbom.components.length,
  });
  await writeFile(resolve(output, "release-evidence.json"), `${JSON.stringify(receipt, undefined, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify({ output, ...receipt })}\n`);
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) await main();
