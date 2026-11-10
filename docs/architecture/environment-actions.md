# Environment-neutral actions and owner waits (R-U1)

## Design before implementation

R-U1 is the host library and deterministic fake for the owner-approved observe → act → pause → resume direction. It does not bind a browser, a vault, a model, an HTTP route or a new screen. The existing decision cards and Work rows are the intended consumers in the binding slice. No screen contracts or prototype sources change.

An observation contains environment/surface/origin/document-generation identity, a revision, bounded public structure, host facts and an ephemeral image handle. Structure labels are untrusted data, never confirmation or authority. Host facts are typed booleans from adapter instrumentation, not extracted claims in page text. The host adapter declares each element's available operations and required decisions. An unclear operation requires irreversible-submit approval. Click, type, key, select, scroll and submit bind the exact observation, element and parameters; type carries only an owner/slot secret reference. No credential value enters this library's durable state.

Each environment has a bounded journaled action ledger in the existing Store, under the reserved internal aggregate prefix. One unresolved step blocks the next. The exact action hash includes the target, parameters and all host-declared gates. Account creation, personal-data submission, terms acceptance and irreversible submission require an owner answer naming that hash. A money gate carries the existing validated PaymentIntent from #150; approval remains non-executable in this slice. An owner cannot turn that intent into a payment dispatch through this interface.

The service accepts trusted host proposals and owner answers through separate methods, not model-callable capabilities. The eventual host must authenticate callers, bind the current Work/input and environment ownership, and pass its drain-aware ownerStore. It must never expose adapter dispatch, the secret resolver or proposal methods directly to models. No runtime integration is enabled in R-U1.

Before acting, read the environment again and compare the entire bound observation identity and element policy. The adapter must atomically check the same identity immediately before input delivery, including after secret resolution. A surface/origin/document-generation change permanently invalidates the pending action, even if the original location returns. A fresh committed claim is the only dispatch authority; the ledger becomes unknown before adapter invocation. Replay, ambiguous commit, restart and restored claims never dispatch. Adapter success is delivery only, not acceptance, a payment receipt or a Record.

Secret resolution happens inside the trusted adapter boundary through a single-use callback bound to the approved owner/slot. The adapter owns temporary bytes, clears them after delivery, never returns them, and validates the target again after resolution. A secret-fill claim durably taints the environment before resolving; subsequent public observations suppress structure, facts and images. A later binding must isolate or destroy that environment to recover public observation; this slice has no unsafe untaint operation.

Owner-needed kinds are confirm-on-device, human-check, enter-value and approve. The wait pins host-observed who/what/where and an exact false→true or true→false host-fact transition. It never clicks or completes a human check. Read-only polling persists its reservation before observing, uses a fixed interval, finite attempts and absolute deadline, and survives service restart without resetting any bound. Cancel, decline, timeout and surface invalidation are terminal. A poll result commits only against its reservation; cancellation or a newer request defeats a late response. Completion records the specified observed transition, never the owner's or page text's claim. Approve uses the same exact-hash owner answer instead of page polling.

## Implementation and evidence plan

1. Write this design, then failing fixture tests for gates/hash tampering, duplicate commands, surface changes, no-replay claims, owner waits, cancellation, expiry, restart, secret reference isolation and private observations.
2. Implement bounded types/validation, reducer and Store service using existing hash, boundedPlainJson, callTool and ownerStore patterns. Add the fake adapter under tests and inert portable-journal replay support.
3. Run typecheck and relevant tests locally. CI owns the full suite and screen contracts. Push one branch, open a PR, and repeat CI plus head-SHA Codex review up to four rounds. Do not merge.

Scope excludes src/browser-*, src/secret-slots.ts and secret sources; actual browser/vault binding; payment execution; virtual desktop implementation; model calls; new UI and contract changes. Fake and journal evidence does not establish real browser, vault or database behavior. The lead owns the independent security review.

## Verification and integration boundaries

The implementation uses a separate bounded internal aggregate, matching existing host-service ledgers. Portable lineage replays its events without adapters, and backup inventory includes no image artifacts. Restoring into a different database feed quarantines the old environment ledger; service restart on the original database preserves waits and bounds. The environment remains private after any secret-fill claim, including an unknown outcome. A trusted host can still poll instrumentation internally; public observation returns no structure, facts or image from a tainted environment.

Nested database admission now refuses to replace a different outer feed identity. A regression reproduced the earlier overwrite before this guard was added. Read-only polls use the smaller of their adapter timeout and remaining absolute wait deadline. The fake checks target identity again after resolving secret bytes and clears those bytes in finally. No real keychain, vault, site, model or payment is used. Existing keychain tests were inspected and already inject fake runners; no real security/op test was found on this branch.

Local evidence: Node 24.21.0, typecheck, 20 new deterministic tests. The related storage/lineage/backup/effect/device/budget/discriminator run passed 141 tests, skipped 8 actual-database cases and reproduced the pre-existing macOS portable-inventory/Turkish-locale directory-realpath failure documented in the work brief. Full-suite, syntax, actual DB and screen checks belong to CI. No UI changed, so no new screen contract or screenshot evidence is proposed.
