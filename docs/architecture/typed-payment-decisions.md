# Typed payment decisions for text Works (R-S)

## Design before implementation

A producing member may return an exact `massion-payment-intent/v1` envelope instead of an artifact: `{format, payee, amountMinor, currency, purpose, sourceReference}`. The host accepts only a positive safe integer in ISO 4217 minor units, a pinned currency/minor-unit table, and bounded, single-line strings with no extra keys. The reference is declared provenance, not proof of an order, receipt or website observation. Neither prose nor token budgets supplies an amount.

Reuse the existing Work owner-effect proposal, decision service, journal, feed and decision card with an additive `payment-intent` request kind. A completed producing call may propose the envelope; planning, challenge and checking calls cannot. The host stores an immutable intent hash and Work input hash, then pauses before artifact creation or independent acceptance. Team workers declare at the joined step boundary so an in-flight sibling call is not mistaken for a payment outcome.

An owner answer names the exact request hash shown on the card. Approve and decline are terminal, durable, single-use answers. An exact command replay returns its original result; another command cannot consume the decision again. Every retained answer pins the intent hash, including across journal replay. Changed intent or Work input invalidates approval. Owner writes use the drain-aware store. Approval is local bookkeeping and can happen after the producing model run ends; it grants no execution permission.

The new kind never reaches adapter lookup, dispatch or receipt recording. Approval remains “Approved · not executed by Massion”; decline remains “Declined”. Neither is a successful payment, accepted Record or permission to resume the Work. The Work stays paused for a future separately designed execution integration. No credentials, card data, provider calls, automatic continuation or inferred order history are added.

## Scope and validation

Touch the typed request validator and effect decisions, bounded text runtime producer, existing decision card/copy, focused tests, fixture producers and accurately narrowed allow-list reasons. Do not change `src/browser-*`, screen contracts, prototype sources, member undo/attribution, file-read activity or room geometry.

Tests cover malformed/oversized amounts and currencies, tampered intent and input, exact and overlapping replay, decline, restart/journal validation, drain, runtime production without artifact/payment execution, and stale/feed/late client controls. Use headless agent-browser for approve/decline UI states; run local typecheck and relevant tests, with full checks/contracts in CI. The lead owns the independent review. Request Codex review after pushes, resolve P1/P2 plus CI failures, and stop clean or report the remainder after four rounds. Do not merge.

## Residuals

Real receipts, order history, merchant/browser observations, subscription CLI proof, multi-stage shopping timestamps and payment execution remain unavailable. Keep their exceptions with precise reasons; add no scenario-specific product logic. Fixture declarations prove only typed approval, never real payment or browser observation.

Currency source: [SIX ISO 4217 maintenance agency](https://www.six-group.com/en/products-services/financial-information/market-reference-data/data-standards.html), current List One checked 2026-11-10. Persist a fixed minor-unit mapping so later ICU upgrades do not change journal validation.

## Lead review correction and delivery

R-S fix round 1 authorizes completing the three lead findings, then merging current `origin/main` and PR #150 after CI and Codex are clean. This supersedes the initial do-not-merge delivery instruction. Typed owner-answer requests have no execution receipt lock; persisted single-use decision state governs any explicit attempt after a lost/refused response. Displayed terminal lines carry the declared payee/amount and recorded answer time. Source rows label only the declared reference kind, retaining the exact original reference in the hashed intent without fetching it.

The producing invocation's retained receipt supplies the payment proposal input fence. Recheck that original hash at every store commit attempt, including CAS retries. Changed assembly input uses the existing reassembly boundary; a stale worker declaration fails closed without replaying its producing call or asking the owner to approve it under newer instructions.

Terminal approval/decline permits monthly model-token settlement once real invocations and moderation have known usage. The declaration's non-executable pending status is not an unknown external invocation. Keep the Work paused and preserve every payment field; settle only model usage and free unused reservation capacity. Any actual unresolved invocation still holds the reservation.
