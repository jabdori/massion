#!/bin/sh
set -eu

version="1.0.0"
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
prefix=${MASSION_PREFIX:-"${HOME:?HOME이 필요합니다}/.local"}
release_dir="$prefix/lib/massion/$version"
bin_dir="$prefix/bin"

verify_checksums() {
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$source_dir" && sha256sum -c SHA256SUMS)
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$source_dir" && shasum -a 256 -c SHA256SUMS)
  else
    echo "SHA-256 검증 도구가 필요합니다" >&2
    exit 1
  fi
}

node_major=$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)
if [ -z "$node_major" ] || [ "$node_major" -lt 24 ]; then
  echo "Node.js 24 이상이 필요합니다" >&2
  exit 1
fi
if ! command -v bun >/dev/null 2>&1; then
  echo "Bun 1.3 이상이 필요합니다" >&2
  exit 1
fi

verify_checksums
mkdir -p "$prefix/lib/massion" "$bin_dir"
temporary="$prefix/lib/massion/.1.0.0.$$"
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
rm -rf "$temporary"
mkdir -m 755 "$temporary"
cp -R "$source_dir/runtime" "$temporary/runtime"
cp "$source_dir/release-bundle.json" "$source_dir/SHA256SUMS" "$source_dir/uninstall.sh" "$temporary/"
mkdir -m 755 "$temporary/bin"

cat >"$temporary/bin/mass" <<EOF
#!/bin/sh
export MASSION_SERVER_BIN="$release_dir/runtime/node_modules/@massion/server/dist/main.js"
exec node "$release_dir/runtime/node_modules/@massion/cli/dist/main.js" "\$@"
EOF
cat >"$temporary/bin/massion-server" <<EOF
#!/bin/sh
exec node "$release_dir/runtime/node_modules/@massion/server/dist/main.js" "\$@"
EOF
cat >"$temporary/bin/massion-tui" <<EOF
#!/bin/sh
exec bun "$release_dir/runtime/node_modules/@massion/tui/dist/main.js" "\$@"
EOF
chmod 755 "$temporary/bin/mass" "$temporary/bin/massion-server" "$temporary/bin/massion-tui" "$temporary/uninstall.sh"

if [ -e "$release_dir" ]; then
  rm -rf "$temporary"
else
  mv "$temporary" "$release_dir"
fi
for command_name in mass massion-server massion-tui; do
  link="$bin_dir/$command_name"
  candidate="$bin_dir/.$command_name.$$"
  ln -s "$release_dir/bin/$command_name" "$candidate"
  mv -f "$candidate" "$link"
done
trap - EXIT HUP INT TERM
echo "Massion AgentOS $version 설치 완료: $bin_dir/mass"
