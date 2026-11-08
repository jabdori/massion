#!/usr/bin/env bash
# Installs locked tools, then runs the normal CLI against disposable local fixtures.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -L node_modules ]; then
  echo 'node_modules is a symlink; run from a clean clone' >&2
  exit 1
fi
node --input-type=module -e 'import assert from "node:assert/strict"; const [major,minor]=process.versions.node.split(".").map(Number); assert.ok(major===24 && minor>=19,"Use Node >=24.19.0 <25");'
command -v python3 >/dev/null
npm ci --ignore-scripts --no-audit --no-fund
# Resolve macOS temporary-directory aliases before artifact path validation.
TMPDIR="$(python3 -c 'import pathlib,tempfile; print(pathlib.Path(tempfile.gettempdir()).resolve())')"
export TMPDIR
smoke_port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
smoke_log="$(mktemp)"
trap 'rm -f "$smoke_log"' EXIT
run_smoke() {
  python3 scripts/with-surreal.py --port "$smoke_port" --timeout 120 -- \
    node --test --test-reporter=tap "$@" | tee "$smoke_log"
  # Node can count an unmatched filter's file as passing; reject its empty plan too.
  awk 'BEGIN { passed=-1; skipped=-1 }
    /^1\.\.0([[:space:]]|$)/ { empty=1 }
    /^# pass / { passed=$3 }
    /^# skipped / { skipped=$3 }
    END { exit !(passed>0 && skipped==0 && !empty) }' "$smoke_log" || {
      echo 'Smoke coverage missing: require executed tests, no skips and no empty plans' >&2
      return 1
    }
}
run_smoke --test-concurrency=1 \
  tests/release-smoke.test.ts tests/schema-migrations.test.ts
run_smoke --test-name-pattern='old backup ->' tests/portable-backup.test.ts
