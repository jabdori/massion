# Local Mission/Work interface candidate — 2026-10-03

This increment remains a local candidate separate from the published foundation checkpoint. It adds useful authoring and continuity without pretending that a model is configured.

## Demonstrated behavior

- User-authored Mission purpose/scope/constraints/criteria and revision-checked Work admission.
- Explicit provider/runtime-unavailable states. No user Work silently invokes the development fixture or an unapproved model.
- Owner cancellation/steering, visible lifecycle/blockers/instructions, criteria and memory pins, evidence and Records inspection.
- Atomic durable operation cursors, bounded catch-up, no extra event on replay/rejection/rollback, and actual HTTP-host restart reading the same user Work and later events.
- A structured client that clears stale results, retains manually selected Mission IDs, suppresses repeated submissions and handles conflicts without automatic writes.
- Pending identities saved before transmission and restored across reload. Unknown outcomes remain locked until exact durable receipt; unrelated or absent events do not establish an outcome.
- Web Locks serialize shared recovery-marker claims/clears across tabs; a late response cannot delete another tab's newer marker. Missing coordination or unreadable/corrupt storage fails closed for writes while preserving reads.

## Validation

Independently reviewed source commit: `a96a60ec493d3a96ef0f6423e491ed3d4a6285c4`. The following evidence update is documentation-only; the source manifest is unchanged.

- Node 24.19.0; actual separate SurrealDB 3.3.0 with fresh disposable SurrealKV storage.
- Full actual-store aggregate: **92 passed, 0 failed, 0 skipped**. Independent review reran the same candidate with an unchanged pre/post source manifest and found no remaining blocker in this local interface scope. It separately reproduced reload recovery with zero POST retransmits and reviewed the cross-tab repair.
- Ordinary `npm run check`: runtime syntax passed; **86 passed, 0 failed, 6 actual-store tests skipped** without the disposable database.
- The client contributes **19 JavaScript/DOM harness tests**, using Node's JavaScript context and a small DOM/coordination test harness. This is not real browser or OS/VM testing.
- This reviewed interface checkpoint preceded compiler installation. The subsequent static-validation follow-up installs pinned TypeScript 7.0.2 and Node types 24.19.1, fixes artifact-boundary/test narrowing and adds the compiler to local/CI aggregate checks; see `static-validation.md`.
- Real browser visual/accessibility verification: blocked by the environment's loopback browser restriction. No external exposure was used to bypass it.
- Real provider execution, actual model quality, governed provider/account/spend configuration, general independent assurance, production authentication, OS/VM execution isolation and deployment: not established.
- Cursor schema version 2 refuses nonempty legacy journals without a reviewed migration; it does not invent order or erase data.

Run:

```sh
MASSION_SURREAL_BINARY=/absolute/path/to/surreal \
  python3 scripts/with-surreal.py -- \
  env MASSION_TEST_SURREAL_RESTART=1 \
  node --test --test-concurrency=1 tests/*.test.ts
```

Source/test/script manifest SHA-256: `58cb8c8d0796f05cd92a3136a6ad040e6d47e19572730eb6c7807ff56eb0c519`.
Generate it with `find src tests scripts -type f -print0 | sort -z | xargs -0 sha256sum` (POSIX environment).

## Remaining product gates

These controls do not implement automatic effect recovery, admission scheduling, complete conversation/organization continuity, native database knowledge-graph queries, retained-feed snapshot fallback, approval lifecycle, real-provider execution or production operation. The product scope/requirement ledger keeps those responsibilities open. An unavailable provider is a truthful blocker, not completion of the user's Work.
