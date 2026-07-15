#!/bin/sh
set -eu
umask 077

version="1.0.0"
owner_marker="massion-local-1.0.0"
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
prefix=${MASSION_PREFIX:-"${HOME:?HOME이 필요합니다}/.local"}
release_dir="$prefix/lib/massion/$version"
release_parent="$prefix/lib/massion"
bin_dir="$prefix/bin"
command_names="massion massion-connector massion-server"

case "$prefix" in
  /*) ;;
  *)
    echo "MASSION_PREFIX는 절대 경로여야 합니다" >&2
    exit 1
    ;;
esac

path_exists() {
  [ -e "$1" ] || [ -L "$1" ]
}

is_owned_release() {
  candidate=$1
  marker="$candidate/.massion-install-owner"
  [ -d "$candidate" ] &&
    [ ! -L "$candidate" ] &&
    [ -f "$marker" ] &&
    [ ! -L "$marker" ] &&
    [ "$(cat "$marker")" = "$owner_marker" ]
}

is_managed_link() {
  link=$1
  target=$2
  [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]
}

assert_safe_managed_directory() {
  candidate=$1
  label=$2
  if [ -L "$candidate" ]; then
    echo "$label 경로는 symbolic link일 수 없습니다: $candidate" >&2
    exit 1
  fi
  if [ -e "$candidate" ] && [ ! -d "$candidate" ]; then
    echo "$label 경로가 directory가 아닙니다: $candidate" >&2
    exit 1
  fi
}

verify_checksums() {
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$source_dir" && sha256sum -c SHA256SUMS >/dev/null)
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$source_dir" && shasum -a 256 -c SHA256SUMS >/dev/null)
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

if [ -L "$prefix" ] || { [ -e "$prefix" ] && [ ! -d "$prefix" ]; }; then
  echo "설치 prefix가 symlink 없는 directory가 아닙니다: $prefix" >&2
  exit 1
fi
assert_safe_managed_directory "$prefix/lib" "설치 library"
assert_safe_managed_directory "$release_parent" "Massion release"
assert_safe_managed_directory "$bin_dir" "실행 파일"

for entrypoint in \
  "runtime/node_modules/@massion/cli/dist/main.js" \
  "runtime/node_modules/@massion/connector/dist/main.js" \
  "runtime/node_modules/@massion/server/dist/main.js" \
  "runtime/node_modules/@massion/tui/dist/main.js"
do
  if [ ! -f "$source_dir/$entrypoint" ] || [ -L "$source_dir/$entrypoint" ]; then
    echo "release runtime 진입점이 없거나 일반 파일이 아닙니다: $entrypoint" >&2
    exit 1
  fi
done
if [ ! -f "$source_dir/web/index.html" ] || [ -L "$source_dir/web/index.html" ]; then
  echo "release Web 진입점이 없거나 일반 파일이 아닙니다: web/index.html" >&2
  exit 1
fi

release_exists=0
if path_exists "$release_dir"; then
  if ! is_owned_release "$release_dir"; then
    echo "기존 release directory의 소유권을 확인할 수 없어 설치를 중단합니다: $release_dir" >&2
    exit 1
  fi
  release_exists=1
fi

# 쓰기를 시작하기 전에 네 명령의 충돌을 모두 확인합니다.
for command_name in $command_names; do
  link="$bin_dir/$command_name"
  target="$release_dir/bin/$command_name"
  if path_exists "$link"; then
    if [ "$release_exists" -ne 1 ] || ! is_managed_link "$link" "$target"; then
      echo "기존 외부 실행 파일을 덮어쓸 수 없습니다: $link" >&2
      exit 1
    fi
  fi
done

mkdir -p "$release_parent" "$bin_dir"
# mkdir 직후에도 경로 교체 여부를 다시 확인해 외부 directory를 따라가지 않습니다.
assert_safe_managed_directory "$prefix/lib" "설치 library"
assert_safe_managed_directory "$release_parent" "Massion release"
assert_safe_managed_directory "$bin_dir" "실행 파일"
chmod 700 "$release_parent"
transaction=$(mktemp -d "$release_parent/.install-$version.XXXXXX")
staged="$transaction/staged-release"
previous="$transaction/previous-release"
link_backups="$transaction/link-backups"
new_links="$transaction/new-links"
mkdir -m 700 "$staged" "$link_backups" "$new_links"

release_promoted=0
previous_saved=0
committed=0

rollback() {
  status=$?
  trap - 0 1 2 15
  set +e
  rollback_failed=0

  if [ "$committed" -ne 1 ] && [ -n "${transaction:-}" ]; then
    for command_name in $command_names; do
      link="$bin_dir/$command_name"
      target="$release_dir/bin/$command_name"
      backup="$link_backups/$command_name"
      if [ -f "$new_links/$command_name" ] && is_managed_link "$link" "$target"; then
        rm "$link" || rollback_failed=1
      fi
      if path_exists "$backup"; then
        if path_exists "$link"; then
          echo "rollback 중 외부 파일이 발견되어 기존 link backup을 보존합니다: $backup" >&2
          rollback_failed=1
        else
          mv "$backup" "$link" || rollback_failed=1
        fi
      fi
    done

    if [ "$release_promoted" -eq 1 ] && is_owned_release "$release_dir"; then
      rm -rf "$release_dir" || rollback_failed=1
    fi
    if [ "$previous_saved" -eq 1 ] && path_exists "$previous"; then
      if path_exists "$release_dir"; then
        echo "rollback 중 release 경로가 점유되어 이전 release를 보존합니다: $previous" >&2
        rollback_failed=1
      else
        mv "$previous" "$release_dir" || rollback_failed=1
      fi
    fi

    if [ "$rollback_failed" -eq 0 ]; then
      rm -rf "$transaction"
    else
      echo "자동 rollback을 완료하지 못했습니다. 복구 자료를 보존했습니다: $transaction" >&2
    fi
  fi

  if [ "$status" -eq 0 ]; then status=1; fi
  exit "$status"
}

trap rollback 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 143' 15

cp -R "$source_dir/runtime" "$staged/runtime"
cp -R "$source_dir/web" "$staged/web"
cp "$source_dir/release-bundle.json" "$source_dir/SHA256SUMS" "$source_dir/uninstall.sh" "$staged/"
printf '%s\n' "$owner_marker" >"$staged/.massion-install-owner"
mkdir -m 700 "$staged/bin"

cat >"$staged/bin/massion" <<'EOF'
#!/bin/sh
set -eu
launcher=$0
if [ -L "$launcher" ]; then launcher=$(readlink "$launcher"); fi
release_dir=$(CDPATH= cd -- "$(dirname -- "$launcher")/.." && pwd)
export MASSION_SERVER_BIN="$release_dir/runtime/node_modules/@massion/server/dist/main.js"
export MASSION_WEB_ROOT="$release_dir/web"
if [ "$#" -eq 0 ] && [ -t 0 ] && [ -t 1 ]; then
  config_path="${XDG_CONFIG_HOME:-$HOME/.config}/massion/config.json"
  case "$(uname -s)" in
    Darwin) config_path="$HOME/Library/Application Support/Massion/config.json" ;;
  esac
  if [ ! -e "$config_path" ]; then
    node "$release_dir/runtime/node_modules/@massion/cli/dist/main.js" init
  fi
  node "$release_dir/runtime/node_modules/@massion/cli/dist/main.js" local ensure --json >/dev/null
  exec bun "$release_dir/runtime/node_modules/@massion/tui/dist/main.js"
fi
exec node "$release_dir/runtime/node_modules/@massion/cli/dist/main.js" "$@"
EOF

cat >"$staged/bin/massion-connector" <<'EOF'
#!/bin/sh
set -eu
launcher=$0
if [ -L "$launcher" ]; then launcher=$(readlink "$launcher"); fi
release_dir=$(CDPATH= cd -- "$(dirname -- "$launcher")/.." && pwd)
entrypoint="$release_dir/runtime/node_modules/@massion/connector/dist/main.js"

case "${1:-}" in
  -h|--help|help)
    cat <<'HELP'
Massion Connector

사용법:
  massion-connector enroll                         연결 등록
  massion-connector run                            연결 실행
  massion-connector secure-profile --profile-root  Provider profile 권한 보호
  massion-connector doctor                         설치된 runtime 진단
HELP
    exit 0
    ;;
  doctor)
    if [ "$#" -ne 1 ]; then
      echo "doctor에는 추가 인수를 지정할 수 없습니다" >&2
      exit 2
    fi
    if [ ! -f "$entrypoint" ] || [ -L "$entrypoint" ] || ! node --check "$entrypoint" >/dev/null 2>&1; then
      echo '{"schema":"massion.connector-doctor.v1","status":"error","runtime":"bundled"}' >&2
      exit 1
    fi
    echo '{"schema":"massion.connector-doctor.v1","status":"ready","runtime":"bundled"}'
    exit 0
    ;;
esac

exec node "$entrypoint" "$@"
EOF

cat >"$staged/bin/massion-server" <<'EOF'
#!/bin/sh
set -eu
launcher=$0
if [ -L "$launcher" ]; then launcher=$(readlink "$launcher"); fi
release_dir=$(CDPATH= cd -- "$(dirname -- "$launcher")/.." && pwd)
export MASSION_WEB_ROOT="$release_dir/web"
exec node "$release_dir/runtime/node_modules/@massion/server/dist/main.js" "$@"
EOF

chmod -R go-rwx "$staged"
chmod 700 \
  "$staged/bin/massion" \
  "$staged/bin/massion-connector" \
  "$staged/bin/massion-server" \
  "$staged/uninstall.sh"
chmod 600 "$staged/.massion-install-owner" "$staged/release-bundle.json" "$staged/SHA256SUMS"

if [ "$release_exists" -eq 1 ]; then
  mv "$release_dir" "$previous"
  previous_saved=1
fi
mv "$staged" "$release_dir"
release_promoted=1

for command_name in $command_names; do
  link="$bin_dir/$command_name"
  if path_exists "$link"; then mv "$link" "$link_backups/$command_name"; fi
done

for command_name in $command_names; do
  link="$bin_dir/$command_name"
  : >"$new_links/$command_name"
  ln -s "$release_dir/bin/$command_name" "$link"
done

# 설치 완료를 확정하기 전에 실제 공개 명령으로 runtime을 진단합니다.
"$bin_dir/massion-connector" --help >/dev/null
"$bin_dir/massion-connector" doctor >/dev/null

committed=1
rm -rf "$transaction"
transaction=""
trap - 0 1 2 15
echo "Massion AgentOS $version 설치 완료: $bin_dir/massion"
