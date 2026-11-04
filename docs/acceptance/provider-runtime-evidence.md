# Configured-provider runtime evidence — 2026-10-03

This is a bounded text runtime and protocol integration checkpoint. **No external model, paid account, platform credential or CLI agent was used.** Every provider exchange below used a local HTTP server or an injected mock transport.

## Verified candidate

- Strict TypeScript 7.0.2 checking passes.
- Independently rerun actual-SurrealDB 3.3.0 plus loopback-provider aggregate: **156 passed, 0 failed, 0 skipped**.
- Source/test/script manifest was unchanged before/after independent verification: `45416c60878a081b551a98e1210b52d2acd1227fd6273782352a235b7ada119f`.
- Existing browser client coverage remains a JavaScript/DOM harness, not real browser rendering or OS/VM isolation.

## What those tests establish

The configured HTTP route invokes the same product application runtime that owns Work. It durably admits the run, assigns separate executor/verifier identities, reserves their output-token caps, records intent before each invocation, persists bounded untrusted output/usage receipts, writes an actual text artifact, validates independent artifact/criteria/quote bindings, rechecks bytes and constructs Records only after the pass. Local mock Records remain fixture-class.

Tests reject forged hashes, incompatible criteria/configuration, insufficient reservations, arbitrary retries of an admitted run, post-dispatch ambiguity, changed artifact bytes and unsafe file paths/links. Cancellation preserves remote uncertainty and does not create another effect. Two adversarial race reproductions were independently verified after repair:

1. Steering between preflight and effect admission leaves Work waiting and prevents the artifact write.
2. Receipt-commit contention after provider dispatch returns `admitted-unsettled`, not a false rolled-back/retryable run.

A prospective Mission change does not replace the already admitted Work's input snapshot. A new runtime instance observes an existing admitted run rather than replaying it.

## Database correctness repair

Real integration exposed SurrealDB 3.3.0 JSON RPC's eager interpretation of colon-shaped strings. For example, an opaque multi-colon assignment ID was truncated even by a bare variable echo. The transport now JSON-encodes each parameter and decodes it inside SurrealQL before use. Native structured stored values and native record links are retained; IDs are not renamed and snapshots are not replaced by opaque text blobs.

Live deep-equality tests now cover nested IDs, input/output text, receipts, events and outbox data. Previously truncated values cannot be silently reconstructed; recovery requires an intact source or backup. See [storage details](../architecture/storage.md).

## Remaining gates

- Explicit real provider/account, input scope and usage/spend authorization, and safe caller-owned authentication integration.
- Actual returned-model compatibility and independent model-judgment quality. Schema/hash checks do not prove semantic truth.
- Monetary cost enforcement: current reservations are output-token units, not a guaranteed dollar or all-token cap.
- Production authentication, general approval/rebind/recovery controls, persistent worker ownership, full native knowledge graph, real browser/accessibility QA and OS/VM isolation.

The default server still loads no credentials and enables no live provider. No merge or deployment is part of this evidence.

Reproduce the actual-store aggregate with the approved official binary:

```sh
MASSION_SURREAL_BINARY=/absolute/path/to/surreal \
  python3 scripts/with-surreal.py -- \
  env MASSION_TEST_SURREAL_RESTART=1 \
  node --test --test-concurrency=1 tests/*.test.ts
```
