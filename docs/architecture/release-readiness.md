# Release readiness (Q17)

## Outcome and boundaries

An owner can install the development candidate, start it against a local persistent
SurrealDB, and retain old portable backups through a storage upgrade. No release
tag, package publication, live provider call, background recovery or new UI is part
of this change. Node 24, SurrealDB 3.3.0 and the existing HTTP transport remain.

## Storage and lifetime

Keep journal schema 2 and portable text format v1 unchanged. Add `storageVersion`
to the database-local feed metadata: an absent marker is legacy version 0; version
1 establishes the current cursor constraints, feed identity and host settings
table. The explicit initializer applies the forward step and marker in one
transaction. Current databases open idempotently; malformed or newer versions fail
closed, with no committed schema/data changes. Existing journal, snapshots,
Records, outbox, feed identity and settings are never rewritten by migration.
Pre-cursor nonempty databases remain unsupported: do not invent historical order.

Run initialization before connections, schedulers or HTTP admission. Install
SIGINT/SIGTERM handling before asynchronous startup. A stop fences further startup;
an already submitted transaction may finish, but no host is then admitted. Bound
the wait and report unsettled shutdown if startup cannot settle. Never rerun
effects or claim remote stop. Upgrades require exclusive offline ownership:
drain every old host first. This is not a distributed migration lease.

## Implementation plan

1. Add failing migration tests in `tests/schema-migrations.test.ts`: new/legacy/
   current/future markers, atomic rollback, repeated/concurrent initialization,
   response loss without resubmission, and abort before/after admission. Implement
   the guarded step in `src/storage.ts` using the existing transaction transport.
2. Freeze a pre-change portable fixture with an accepted text Record and unresolved
   effects. Extend `tests/portable-backup.test.ts` with old backup -> legacy store ->
   upgrade -> clean restore, checking every operation, projection and artifact.
3. Add startup signal coverage and `tests/release-smoke.test.ts` exercising the
   normal CLI, fixture HTTP commands, duplicate command identity, restart, backup
   and restore. Change only CLI startup in `src/server.ts`; keep ownerStore and
   existing client generation/feed/deadline handling intact.
4. Add `scripts/install-smoke.sh` and a separate CI job: locked install, disposable
   database, smoke and migration contracts. Reuse the existing owned DB launcher
   and pinned archive checksum. Document install, first run, paths, upgrades,
   backup/restore and troubleshooting in README.
5. Run affected tests, static checks and the aggregate suite; review the final diff
   for data loss and startup/drain risks, then commit, push and open a PR. Do not merge.

No browser state changes are introduced. Existing stale-feed, deadline and
out-of-order response tests remain the regression checks for those bug classes;
new tests target schema/startup races and overlapping owner commands instead of
duplicating unrelated UI tests. Fixtures and loopback mocks are not live-model
evidence. Portable backup still excludes host settings/credentials and unsupported
non-text artifacts; retain settings separately as documented in the existing contract.

Primary references: [SurrealDB transactions](https://surrealdb.com/docs/learn/querying/concepts-and-guides/transactions),
[table definitions](https://surrealdb.com/docs/reference/query-language/statements/define/table),
[GitHub Node CI](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs).
Current docs were checked; the actual 3.3.0 binary is the compatibility gate.

## Final candidate evidence

Verified on 2026-11-08, with fixtures/local mocks only and no live model calls:

- Clean Linux arm64 installation: Node 24.22.2, official SurrealDB 3.3.0,
  archive SHA-256 `f03356497f875057126641f06757671542e0a7b75f18fd13820c2dab29349d74`.
  Dependency acquisition was separate; installation from the populated npm cache
  and all runtime checks ran in a Docker container with `--network none`.
- `bash scripts/install-smoke.sh`: 9/9 startup/migration/CLI tests and 1/1 frozen
  backup upgrade/restore contract, no skips.
- `npm run typecheck`, `node scripts/check.mjs`, shell syntax and diff whitespace
  checks passed. No new npm dependencies.
- Actual disposable SurrealKV aggregate, with `MASSION_TEST_SURREAL_RESTART=1`
  and `node --test --test-concurrency=1 tests/*.test.ts`: **1,427 passed,
  0 failed, 33 skipped** (1,460 total). Includes owned CLI drain/crash, storage
  crash/reopen, portable restore, lifetime, duplicate commands and stale clients.
  Opt-in browser rendering is not claimed.
- macOS arm64 / Node 24.21.0: clean installation smoke passed. Parallel `npm test`
  returned 1,118 passed, 2 failed, 339 skipped: the known case-insensitive-path
  inventory failure and a pre-existing 500 ms lifetime test that passed on its
  focused rerun. A macOS durable aggregate also hit 248 Linux `/proc` ownership
  checks, that path failure and a lifetime timeout. These were not suppressed;
  the full Linux run above passed their supported execution paths.
- An independent read-only final review found no actionable defects. Tests-first
  failures were observed for schema marker/readback/abort behavior and normal CLI
  termination during startup before the implementation changes.

CI pins Node 24.19.0 and the existing verified Linux amd64 SurrealDB 3.3.0 archive;
the local Linux evidence above uses a newer compatible Node 24.x and arm64.
No tag, release, package publication or merge was performed.
