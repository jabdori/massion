#!/bin/sh
set -eu

version="1.0.0"
owner_marker="massion-local-1.0.0"
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
prefix=${MASSION_PREFIX:-"${HOME:?HOME이 필요합니다}/.local"}
release_dir="$prefix/lib/massion/$version"

case "$prefix" in
  /*) ;;
  *)
    echo "MASSION_PREFIX는 절대 경로여야 합니다" >&2
    exit 1
    ;;
esac

if [ -L "$prefix" ] || [ ! -d "$prefix" ]; then
  echo "설치 prefix를 안전하게 확인할 수 없습니다: $prefix" >&2
  exit 1
fi

for managed_directory in "$prefix/lib" "$prefix/lib/massion" "$prefix/bin"; do
  if [ ! -d "$managed_directory" ] || [ -L "$managed_directory" ]; then
    echo "관리 대상 directory를 안전하게 확인할 수 없습니다: $managed_directory" >&2
    exit 1
  fi
done

if [ ! -d "$release_dir" ] || [ -L "$release_dir" ]; then
  echo "설치된 release directory를 확인할 수 없습니다: $release_dir" >&2
  exit 1
fi

installed_source=$(CDPATH= cd -- "$release_dir" && pwd)
if [ "$source_dir" != "$installed_source" ]; then
  echo "설치된 release에 포함된 uninstall.sh만 실행할 수 있습니다" >&2
  exit 1
fi

marker="$release_dir/.massion-install-owner"
if [ ! -f "$marker" ] || [ -L "$marker" ] || [ "$(cat "$marker")" != "$owner_marker" ]; then
  echo "release directory의 소유권을 확인할 수 없어 제거를 중단합니다: $release_dir" >&2
  exit 1
fi

for command_name in massion massion-connector massion-server; do
  link="$prefix/bin/$command_name"
  target="$release_dir/bin/$command_name"
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then
    rm "$link"
  fi
done

rm -rf "$release_dir"
echo "Massion AgentOS $version 실행 파일을 제거했습니다. 사용자 data와 backup은 보존했습니다."
