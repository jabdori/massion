# Owner quarantine evidence

This increment is stacked on PR #6 (`071cb2fa882d2be884f18461d39a42c9998fe470`,
tree `6b60a9d8c2fd149e5425b5915196a1493fda71bb`) and advances owner handling
of interrupted Work in [issue #4](https://github.com/jabdori/massion/issues/4).
The draft PR pins the exact published candidate and identical local tree.

## Final-candidate verification

- Node 24.19.0, TypeScript 7.0.2, actual SurrealDB 3.3.0/SurrealKV.
- Strict types and runtime syntax passed.
- Default aggregate: **193 passed, 0 failed, 16 intentional database skips**.
- Documented actual-store serial aggregate with crash/restart enabled:
  **209 passed, 0 failed, 0 skipped**. These counts are one candidate, not a sum.
- Independent reviewer ran both aggregates and inspected the frozen source.
  Source/test/script SHA-256 manifest fingerprint before and after both runs:
  `e4660b6802216f9a5f0a22c78f8343b184164560b00e54a54c85512845527506`.
- Regression-first domain tests and UI harness tests failed before implementation.
- Owner-only/current-run/explicit-acknowledgement checks; stale revision and
  competing command rejection; exact identity replay; response-loss readback;
  ordinary cancellation followed by quarantine; existing receipt and reservation
  preservation; null usage and no invented receipt/Record.
- Local HTTP provider receipt-commit failure handled through a second owner host
  without a configured provider. Held-response and separate-worker races establish
  durable late-receipt/task/artifact/verifier/acceptance fencing.
- A deliberately paused already-admitted effect still dispatches after another
  host quarantines it. This test prevents any claim that local quarantine proves
  remote cessation. Its output cannot progress the quarantined Work.
- Actual SurrealDB fresh-client quarantine/export/clean restore retains exact
  journals, unknown effects, recovery evidence and original command identities.
  No provider call is replayed during restoration.
- An additional actual configured executor/artifact/verifier/accepted-Record
  round trip preserves original descriptor metadata, checksum and sealed bytes.

## Review finding fixed

The actual configured-run backup test revealed that runtime assignments historically
copy `enabled` and `capabilities` descriptor metadata, while the prior strict backup
validator rejected them. The validator now explicitly checks and preserves those
optional historical fields, including inside accepted Records. It rejects invalid
types and unrecognized fields; it never uses the metadata to grant execution
permission. No history or accepted Record is rewritten.

## Reproduce

```sh
npm run check
MASSION_SURREAL_BINARY=/absolute/path/to/surreal \
  python3 scripts/with-surreal.py -- \
  env MASSION_TEST_SURREAL_RESTART=1 \
  node --test --test-concurrency=1 tests/*.test.ts
```

Use the official SurrealDB 3.3.0 binary and only disposable stores. The existing
launcher and CI verify the pinned release archive. The serial command is required
for the suite's shared database/restart contract. Without live-store configuration,
intentional skips do not count as durability evidence.

## Honest boundary

This provides permanent owner quarantine, not resumed completion, remote-stop
proof, provider outcome reconciliation, a successor execution, or full recovery.
Late provider responses after quarantine are rejected by this bounded path.
Provider/account selection remains separate, and no provider is hardcoded by this
increment. No real model, account credential, paid call, merge, release or deployment
was used. Actual browser visual/accessibility review and live-provider quality are
not run. Issue #5 and the remaining full-product charter stay open. The UI tests
are JavaScript/DOM harness evidence only.
