const VERSION = /^\d+\.\d+\.\d+$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function verifyReleaseVersions(version, packages) {
  if (!VERSION.test(version)) throw new Error("release version이 유효하지 않습니다");
  if (!Array.isArray(packages) || packages.length < 1) throw new Error("release package 목록이 비어 있습니다");
  const names = new Set();
  for (const package_ of packages) {
    if (!package_ || typeof package_.name !== "string" || package_.name.length > 128)
      throw new Error("release package 이름이 유효하지 않습니다");
    if (names.has(package_.name)) throw new Error(`release package 이름이 중복됐습니다: ${package_.name}`);
    names.add(package_.name);
    if (package_.version !== version)
      throw new Error(`${package_.name} version ${String(package_.version)}이 release ${version}과 다릅니다`);
  }
}

export function createReleaseManifest(input) {
  if (!VERSION.test(input.version) || !COMMIT.test(input.gitCommit) || !DIGEST.test(input.sourceDigest))
    throw new Error("release identity가 유효하지 않습니다");
  const toolchains = input.toolchains;
  if (!toolchains || !VERSION.test(toolchains.node) || !VERSION.test(toolchains.bun) || !VERSION.test(toolchains.pnpm))
    throw new Error("release toolchain이 유효하지 않습니다");
  if (!Array.isArray(input.artifacts) || input.artifacts.length < 1)
    throw new Error("release artifact 목록이 비어 있습니다");
  const names = new Set();
  const artifacts = input.artifacts
    .map((artifact) => {
      if (!ARTIFACT_NAME.test(artifact.name)) throw new Error("release artifact 이름이 유효하지 않습니다");
      if (names.has(artifact.name)) throw new Error(`release artifact 이름이 중복됐습니다: ${artifact.name}`);
      names.add(artifact.name);
      if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || !DIGEST.test(artifact.digest))
        throw new Error(`release artifact 정보가 유효하지 않습니다: ${artifact.name}`);
      return { name: artifact.name, bytes: artifact.bytes, digest: `sha256:${artifact.digest}` };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    schema: "massion.release.v1",
    version: input.version,
    gitCommit: input.gitCommit,
    sourceDigest: `sha256:${input.sourceDigest}`,
    toolchains: { ...toolchains },
    artifacts,
  };
}
