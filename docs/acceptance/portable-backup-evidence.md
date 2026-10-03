# Portable text Work backup evidence

This increment is stacked on PR #3 commit
`6cdcf5ab0d3c0264f4ffa5c8f93e10fcc3774bed` and addresses the backup/restore gate
in [issue #4](https://github.com/jabdori/massion/issues/4). The draft PR description
pins the exact published final candidate; this report belongs to that candidate,
not to older 60/92/156-test snapshots.

## Verified

- Node 24.19.0; TypeScript 7.0.2; SurrealDB 3.3.0 with SurrealKV.
- Official Surreal archive SHA-256:
  `44aeab565f7e7e39d2d0bf0583c8aae648babc91373c70b2658288d95bbbcd55`.
- Strict static types and runtime syntax checks passed.
- Full actual-store aggregate: **192 passed, 0 failed, 0 skipped**, including
  deliberate database crash/restart, existing runtime/mock-provider checks and new
  portability tests. Counts describe this candidate and are not additive with
  prior candidates.
- Accepted deterministic fixture Work restores into a separate fresh database;
  original Record, command identities, state and operation journal compare exactly.
- CLI restore into a separate fresh SurrealKV server and fresh Node client resolves
  accepted bytes after deleting the original artifact directory. Original Record
  checksum remains unchanged. There are no provider/effect invocations in restore.
- Missing, modified, duplicate and malformed blobs, unknown versions, unsafe paths,
  occupied destinations, stale/mismatched lineage and forged/rehashed command
  histories reject. English/Turkish process locales yield the same inventory.
- Pending/unknown effects remain unchanged; restored materialized outbox rows have
  `restored-held` status. Response-loss reconciliation does not replay import.
- Empty bundles initialize ownership markers; explicit relocation manifests permit
  a second API export; post-commit artifact failures report committed state.

Independent source review covered storage transactions/readback, lineage and
artifact/CLI boundaries. Findings fixed before final verification included
locale-dependent ordering, symlinked bundle ancestors, invalid UTF-8, empty-root
initialization and post-commit error clarity. No blocking finding remained.

## Reproduce

```sh
npm ci --cache /tmp/massion-npm-cache --ignore-scripts --no-audit --no-fund
npm run check
MASSION_SURREAL_BINARY=/absolute/path/to/surreal \
  python3 scripts/with-surreal.py -- \
  env MASSION_TEST_SURREAL_RESTART=1 \
  node --test --test-concurrency=1 tests/*.test.ts
```

Without a configured disposable service/binary, the default suite intentionally
skips integration cases; those skipped checks are not durable-store evidence.
Never run fault-injection tests against existing user data.

## Unresolved gates

This is deterministic fixture durability and mock-provider contract evidence, not
live-model quality. Authorized live-provider validation (#5), incorrect/correct
semantic judgment evaluation, actual browser visual/accessibility review and
remaining full-product charter items stay open. No credential, paid service,
merge, release or deployment was used.

Format v1 supports bounded text artifacts only. It is an offline owner-controlled
operation, not a production multi-writer backup protocol. Original bundle retention
is required for relocated descriptor reads/API re-export. Checksums detect
corruption and consistency errors, not a malicious author or historical authority.
See [architecture](../architecture/portable-backup.md) for exact limits, privacy,
projection reconstruction and filesystem/database atomicity boundaries.
