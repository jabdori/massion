#!/bin/sh
set -eu
umask 077

version=${MASSION_VERSION:-1.0.0}
base_url=${MASSION_RELEASE_BASE_URL:-"https://github.com/jabdori/massion/releases/download/v${version}"}

case "$version" in
  ""|*[!0-9.]*)
    echo "MASSION_VERSION은 숫자와 점으로 된 버전이어야 합니다" >&2
    exit 2
    ;;
esac
case "$base_url" in
  https://*) curl_protocols="=https" ;;
  http://127.0.0.1:*|http://localhost:*) curl_protocols="=http,https" ;;
  *)
    echo "릴리스 URL은 HTTPS 또는 loopback HTTP여야 합니다" >&2
    exit 2
    ;;
esac
for tool in curl node tar; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool 실행 파일이 필요합니다" >&2
    exit 1
  fi
done
if command -v sha256sum >/dev/null 2>&1; then
  checksum_tool=sha256sum
elif command -v shasum >/dev/null 2>&1; then
  checksum_tool=shasum
else
  echo "SHA-256 검증 도구(sha256sum 또는 shasum)가 필요합니다" >&2
  exit 1
fi

base_url=${base_url%/}
temporary=$(mktemp -d "${TMPDIR:-/tmp}/massion-install.XXXXXX")
cleanup() {
  rm -rf "$temporary"
}
trap cleanup EXIT INT TERM

manifest="$temporary/release-manifest.json"
archive="$temporary/massion-local-${version}.tar.gz"
bundle="$temporary/bundle"
mkdir -m 700 "$bundle"

curl --fail --silent --show-error --location --proto "$curl_protocols" --tlsv1.2 \
  "$base_url/release-manifest.json" -o "$manifest"

metadata=$(node - "$manifest" "$version" <<'NODE'
const { readFileSync } = require("node:fs");
const [manifestPath, version] = process.argv.slice(2);
let value;
try {
  value = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch {
  process.stderr.write("릴리스 매니페스트 JSON을 읽을 수 없습니다\n");
  process.exit(2);
}
if (value?.schema !== "massion.release.v1" || value.version !== version || !Array.isArray(value.artifacts)) {
  process.stderr.write("릴리스 매니페스트 형식 또는 버전이 다릅니다\n");
  process.exit(2);
}
const expected = `massion-local-${version}.tar.gz`;
const artifact = value.artifacts.find((candidate) => candidate?.name === expected);
if (!artifact || typeof artifact.digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(artifact.digest)) {
  process.stderr.write("개인용 릴리스 아티팩트의 SHA-256이 없습니다\n");
  process.exit(2);
}
process.stdout.write(`${artifact.name}|${artifact.digest.slice(7)}\n`);
NODE
)
archive_name=${metadata%%|*}
archive_digest=${metadata#*|}
expected_name="massion-local-${version}.tar.gz"
if [ "$archive_name" != "$expected_name" ]; then
  echo "예상하지 않은 릴리스 아카이브입니다" >&2
  exit 2
fi

curl --fail --silent --show-error --location --proto "$curl_protocols" --tlsv1.2 \
  "$base_url/$archive_name" -o "$archive"
if [ "$checksum_tool" = "sha256sum" ]; then
  actual_digest=$(sha256sum "$archive" | awk '{print $1}')
else
  actual_digest=$(shasum -a 256 "$archive" | awk '{print $1}')
fi
if [ "$actual_digest" != "$archive_digest" ]; then
  echo "릴리스 아카이브 SHA-256 검증에 실패했습니다" >&2
  exit 1
fi

tar -xzf "$archive" -C "$bundle"
if [ ! -f "$bundle/install.sh" ] || [ -L "$bundle/install.sh" ] || [ ! -f "$bundle/SHA256SUMS" ]; then
  echo "릴리스 설치 묶음이 유효하지 않습니다" >&2
  exit 1
fi
exec sh "$bundle/install.sh"
