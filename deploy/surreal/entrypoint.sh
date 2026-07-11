#!/bin/sh
set -eu

password_file="${SURREAL_PASSWORD_FILE:-/run/secrets/database_password}"
if [ ! -r "$password_file" ]; then
  echo "SurrealDB password secret file을 읽을 수 없습니다" >&2
  exit 1
fi
password="$(cat "$password_file")"
if [ "${#password}" -lt 16 ]; then
  echo "SurrealDB password는 16자 이상이어야 합니다" >&2
  exit 1
fi
exec /usr/local/bin/surreal start \
  --no-banner \
  --bind 0.0.0.0:8000 \
  --log "${SURREAL_LOG:-info}" \
  --user "${SURREAL_USER:-root}" \
  --pass "$password" \
  rocksdb:/data/massion.db
