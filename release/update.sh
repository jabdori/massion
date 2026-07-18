#!/bin/sh
set -eu
umask 077

operation=check
json=0
requested_version=${MASSION_VERSION:-}
for argument in "$@"; do
  case "$argument" in
    --check) operation=check ;;
    --apply) operation=apply ;;
    --json) json=1 ;;
    --*) echo "지원하지 않는 update option입니다: $argument" >&2; exit 2 ;;
    *)
      if [ -n "$requested_version" ]; then
        echo "버전은 하나만 지정할 수 있습니다" >&2
        exit 2
      fi
      requested_version=$argument
      ;;
  esac
done

prefix=${MASSION_PREFIX:-"${HOME:?HOME이 필요합니다}/.local"}
release_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
current_bundle="$release_dir/release-bundle.json"
for tool in curl node bun tar; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool 실행 파일이 필요합니다" >&2
    exit 1
  fi
done
bun_version=${MASSION_BUN_VERSION:-$(bun --version)}
export MASSION_BUN_VERSION="$bun_version"
if command -v sha256sum >/dev/null 2>&1; then checksum_tool=sha256sum; else checksum_tool=shasum; fi

temporary=$(mktemp -d "${TMPDIR:-/tmp}/massion-upgrade.XXXXXX")
cleanup() { rm -rf "$temporary"; }
trap cleanup EXIT INT TERM

if [ -z "$requested_version" ]; then
  latest_json="$temporary/latest.json"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    -H 'Accept: application/vnd.github+json' \
    https://api.github.com/repos/jabdori/massion/releases/latest -o "$latest_json"
  requested_version=$(node - "$latest_json" <<'NODE'
const { readFileSync } = require("node:fs");
const value = JSON.parse(readFileSync(process.argv[2], "utf8"));
const tag = typeof value?.tag_name === "string" ? value.tag_name : "";
if (!/^v\d+\.\d+\.\d+$/u.test(tag)) process.exit(2);
process.stdout.write(tag.slice(1));
NODE
  )
fi

case "$requested_version" in
  ''|*[!0-9.]*) echo "버전이 유효하지 않습니다: $requested_version" >&2; exit 2 ;;
esac

current_version=$(node - "$current_bundle" <<'NODE'
const { readFileSync } = require("node:fs");
const value = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (value?.schema !== "massion.release-bundle.v1" || typeof value.version !== "string") process.exit(2);
process.stdout.write(value.version);
NODE
)
base_url=${MASSION_RELEASE_BASE_URL:-"https://github.com/jabdori/massion/releases/download/v${requested_version}"}
case "$base_url" in
  https://*) curl_protocols='=https' ;;
  http://127.0.0.1:*|http://localhost:*) curl_protocols='=http,https' ;;
  *) echo "릴리스 URL은 HTTPS 또는 loopback HTTP여야 합니다" >&2; exit 2 ;;
esac
base_url=${base_url%/}
manifest="$temporary/release-manifest.json"
curl --fail --silent --show-error --location --proto "$curl_protocols" --tlsv1.2 \
  "$base_url/release-manifest.json" -o "$manifest"

metadata=$(node - "$current_bundle" "$manifest" "$current_version" "$requested_version" <<'NODE'
const { readFileSync } = require("node:fs");
const [currentPath, manifestPath, currentVersion, targetVersion] = process.argv.slice(2);
const current = JSON.parse(readFileSync(currentPath, "utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const semver = (value) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  if (!match) throw new Error("invalid version");
  return match.slice(1).map(Number);
};
const compare = (left, right) => {
  const a = semver(left); const b = semver(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
};
const currentParts = semver(currentVersion); const targetParts = semver(targetVersion);
if (manifest?.schema !== "massion.release.v1" || manifest.version !== targetVersion || !Array.isArray(manifest.artifacts)) throw new Error("릴리스 매니페스트가 유효하지 않습니다");
if (targetParts[0] !== currentParts[0]) throw new Error("주 버전이 달라 호환성 검토가 필요합니다");
const artifact = manifest.artifacts.find((item) => item?.name === `massion-local-${targetVersion}.tar.gz`);
if (!artifact || typeof artifact.digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest)) throw new Error("개인용 아카이브 정보가 없습니다");
const toolchains = manifest.toolchains;
if (!toolchains || typeof toolchains.node !== "string" || typeof toolchains.bun !== "string") throw new Error("릴리스 호환성 정보가 없습니다");
const compatibility = manifest.compatibility ?? {
  platforms: ["darwin-arm64", "darwin-amd64", "linux-arm64", "linux-amd64"],
  node: { minMajor: 24 },
  bun: { minVersion: "1.3.0" },
};
const architecture = process.arch === "x64" ? "amd64" : process.arch;
const platform = `${process.platform}-${architecture}`;
if (!compatibility || !Array.isArray(compatibility.platforms) || !compatibility.platforms.includes(platform)) throw new Error(`현재 실행 환경(${platform})과 호환되지 않는 release입니다`);
const nodeRequiredMajor = Number(compatibility.node?.minMajor);
const bunRequired = semver(compatibility.bun?.minVersion);
if (!Number.isSafeInteger(nodeRequiredMajor) || nodeRequiredMajor < 1) throw new Error("릴리스 Node.js 호환성 정보가 유효하지 않습니다");
const nodeCurrent = semver(process.versions.node);
const bunCurrent = semver(process.env.MASSION_BUN_VERSION ?? compatibility.bun.minVersion);
if (
  nodeCurrent[0] < nodeRequiredMajor ||
  bunCurrent[0] < bunRequired[0] ||
  (bunCurrent[0] === bunRequired[0] &&
    (bunCurrent[1] < bunRequired[1] || (bunCurrent[1] === bunRequired[1] && bunCurrent[2] < bunRequired[2])))
)
  throw new Error("현재 Node.js 또는 Bun이 release 호환 범위를 만족하지 않습니다");
process.stdout.write(`${artifact.name}|${artifact.digest.slice(7)}|${compare(targetVersion, currentVersion)}\n`);
NODE
)
archive_name=${metadata%%|*}
remaining=${metadata#*|}
archive_digest=${remaining%%|*}
version_order=${remaining#*|}

if [ "$version_order" -le 0 ]; then
  if [ "$json" -eq 1 ]; then
    printf '{"schema":"massion.update.v1","operation":"%s","status":"current","currentVersion":"%s","targetVersion":"%s"}\n' "$operation" "$current_version" "$requested_version"
  else
    echo "Massion $current_version이 이미 설치되어 있습니다"
  fi
  exit 0
fi

if [ "$operation" = "check" ]; then
  if [ "$json" -eq 1 ]; then
    printf '{"schema":"massion.update.v1","operation":"check","status":"available","currentVersion":"%s","targetVersion":"%s","compatible":true}\n' "$current_version" "$requested_version"
  else
    echo "Massion $requested_version 업그레이드 가능"
  fi
  exit 0
fi

archive="$temporary/$archive_name"
bundle="$temporary/bundle"
mkdir -m 700 "$bundle"
curl --fail --silent --show-error --location --proto "$curl_protocols" --tlsv1.2 \
  "$base_url/$archive_name" -o "$archive"
if [ "$checksum_tool" = "sha256sum" ]; then actual_digest=$(sha256sum "$archive" | awk '{print $1}'); else actual_digest=$(shasum -a 256 "$archive" | awk '{print $1}'); fi
if [ "$actual_digest" != "$archive_digest" ]; then echo "릴리스 아카이브 SHA-256 검증에 실패했습니다" >&2; exit 1; fi
tar -xzf "$archive" -C "$bundle"
if [ ! -f "$bundle/install.sh" ] || [ -L "$bundle/install.sh" ] || [ ! -f "$bundle/SHA256SUMS" ]; then echo "릴리스 설치 묶음이 유효하지 않습니다" >&2; exit 1; fi
node - "$bundle/release-bundle.json" "$requested_version" <<'NODE'
const { readFileSync } = require("node:fs");
const [bundlePath, requestedVersion] = process.argv.slice(2);
let bundle;
try {
  bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
} catch {
  process.stderr.write("release bundle version을 확인할 수 없습니다\n");
  process.exit(1);
}
if (bundle?.schema !== "massion.release-bundle.v1" || bundle.version !== requestedVersion) {
  process.stderr.write("release bundle version이 manifest와 다릅니다\n");
  process.exit(1);
}
NODE
if [ "$json" -eq 1 ]; then
  MASSION_PREFIX="$prefix" sh "$bundle/install.sh" >/dev/null
  printf '{"schema":"massion.update.v1","operation":"upgrade","status":"updated","currentVersion":"%s","targetVersion":"%s"}\n' "$current_version" "$requested_version"
else
  MASSION_PREFIX="$prefix" sh "$bundle/install.sh"
fi
