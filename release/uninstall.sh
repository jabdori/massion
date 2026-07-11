#!/bin/sh
set -eu

version="1.0.0"
prefix=${MASSION_PREFIX:-"${HOME:?HOME이 필요합니다}/.local"}
release_dir="$prefix/lib/massion/$version"

for command_name in mass massion-server massion-tui; do
  link="$prefix/bin/$command_name"
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$release_dir/bin/$command_name" ]; then
    rm "$link"
  fi
done
rm -rf "$release_dir"
echo "Massion AgentOS $version 실행 파일을 제거했습니다. 사용자 data와 backup은 보존했습니다."
