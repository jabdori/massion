#!/usr/bin/env bash
# Installs locked tools, then runs the normal CLI against disposable local fixtures.
set -euo pipefail
cd "$(dirname "$0")/.."
node --input-type=module -e 'import assert from "node:assert/strict"; const [major,minor]=process.versions.node.split(".").map(Number); assert.ok(major===24 && minor>=19,"Use Node >=24.19.0 <25");'
command -v python3 >/dev/null
npm ci --ignore-scripts --no-audit --no-fund
# Resolve macOS temporary-directory aliases before artifact path validation.
TMPDIR="$(python3 -c 'import pathlib,tempfile; print(pathlib.Path(tempfile.gettempdir()).resolve())')"
export TMPDIR
smoke_port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
python3 scripts/with-surreal.py --port "$smoke_port" --timeout 120 -- \
  node --test --test-concurrency=1 \
  tests/release-smoke.test.ts tests/schema-migrations.test.ts
python3 scripts/with-surreal.py --port "$smoke_port" --timeout 60 -- \
  node --test --test-name-pattern='old backup ->' tests/portable-backup.test.ts
