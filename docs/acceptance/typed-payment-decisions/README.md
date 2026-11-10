# Typed payment decisions (R-S)

## Implemented

The bounded text runtime accepts an exact payment declaration from a producing call, validates it before retaining its output, and pauses before artifact creation. The owner approves or declines the declared payee, integer minor-unit amount, currency, purpose and source reference. Each answer pins the immutable intent hash and goes through the existing journal/CAS/idempotency boundary. Approval never dispatches a payment. Work detail shows the declared amount and timestamped owner answer without a receipt or accepted Record.

The source reference is the member's declaration, not independently verified evidence. The fixed currency table follows SIX List One published 2026-09-17, retrieved 2026-11-10; codes without numeric minor units are rejected. Formatting uses integer/string arithmetic, including the maximum safe integer, instead of floating-point division.

## Verification

- Red/green tests for typed approval, exact/concurrent replay, decline, tampered intent and input, malformed money/currency/oversized fields, owner drain, service restart and journal replay.
- Runtime tests cover producing output, invalid output redaction, no artifact/checker/payment call, post-run owner approval and a member worker that prevents dependent tasks from running.
- Client tests cover exact displayed hash, detached controls, database replacement, terminal approved/declined rows and Work detail amount/history.
- `npm run typecheck` and `node scripts/check.mjs` pass. Local testing uses only related files; full suite and all screen contracts belong to CI. The two existing tuple inference errors in schedule/settings fixture tests were fixed with `as const`.
- `TMPDIR=/private/tmp node scripts/ui-contracts/verify-payment-intents.mjs`: normal host decision routes, in-memory store, no payment adapter or model/network provider. Both themes walk open → approve → decline → reload → mobile; one durable answer per intent, no dispatch/receipt/Record. Snapshot files retain semantic names and roles. The narrow viewport uses the existing sidebar toggle.
- Compared the B4 prototype's decision card hierarchy, yellow decision-only treatment, amount and primary/secondary actions with the captures. Browser checkout screenshots, card information and paid/order claims are intentionally absent because the new request kind cannot produce them. Existing card geometry and typography are reused. Impeccable detection returned no findings.

| Theme | Pending | Approved | Declined | Reloaded mobile |
| --- | --- | --- | --- | --- |
| Light | [open](light-open.png) | [approved](light-approved.png) | [declined](light-declined.png) | [mobile](light-reloaded-mobile.png) |
| Dark | [open](dark-open.png) | [approved](dark-approved.png) | [declined](dark-declined.png) | [mobile](dark-reloaded-mobile.png) |

## Remaining contract evidence

Forty existing allow-list reasons were narrowed; no diagnostic or approved contract was removed or rewritten. Eighteen capability gaps belong to legacy fixtures with no declared payment intent. Fourteen completed-order amount/currency/history entries need actual typed execution/order observations. Eight shopping-step/payment-row order entries also need the absent shopping stages and owner decision in those fixtures. The separate new fixture proves approval only; retrofitting it into already-completed or unknown legacy Works would invent provenance.

B8/B15 browser/form or real execution rows are not evidence of this intent gate. Real order history, vendor receipts, browser observations and subscription-CLI connection proof remain unavailable here. PR #127 owns browser sources; this branch changes none. No contract changes are proposed for the owner.

## Limits

One unresolved intent per Work; multiple simultaneous worker intents fail closed rather than dropping one or approving several. Approved and declined Works remain paused; no automatic continuation, actual payment integration or replay is added. The source reference is never fetched. The normal effect decision surface remains scoped to the current intake Mission. Restart tests validate retained fixture state and journal replay; they do not claim a live payment or real-database run.

## Lead review correction (R-S fix round 1)

- Typed payment decisions no longer arm or honor the browser's external-effect receipt lock. A refused or lost answer can be explicitly attempted again when durable readback still says open; the existing single-use reducer rejects any second consumption. Executable payments retain their no-resend guard.
- Regression tests reproduce 500, host drain/contention 503 and a rejected network/timeout response, then exercise another answer. A retained lock from the earlier client no longer hides or blocks the typed decision.
- Approved/declined lines now identify the payee and amount/currency and use the recorded owner-answer time, including chronological placement. Work detail keeps the same identity in its timeline.
- The source row shows the declared reference kind (document, Record, Work, web address or generic reference). The internal reference remains immutable in the intent but is never rendered as the row label; no source is fetched or verified.
- Related effect/client/Work-pane tests: 88 passed. Typecheck passed. The browser verification regenerated all listed screenshots and snapshots, and asserts the human source label plus the exact payee/amount/answer/time in both themes and after mobile reload.

### CI and Codex follow-up

The UTC CI runner exposed a Seoul-only expected clock value in the recovery tests. The assertion now derives the browser-local answer time; all 25 client tests pass under UTC and the four recovery cases pass under Asia/Seoul.

Codex found that owner steering during a producing call or proposal contention could bind old payment output to newer inputs. Proposal admission now retains the producing effect's original input hash and compares it at every commit attempt. Assembly uses the existing steering-change path; stale worker declarations block without an approval or provider replay. Three regressions reproduce receipt-time steering, proposal CAS contention and worker-output steering. Related member/runtime/effect tests pass 162 / 3 environment-gated skips (165 cases), and typecheck passes. Existing UI captures remain current because this follow-up changes only runtime admission and the test expectation.

### Terminal intent budget settlement

A terminal, non-executable payment declaration now closes its model-budget reservation for accounting without changing the Work's waiting state or recording a successful payment. Both approve and decline release unused tokens, retain measured usage and permit another Work within the remaining monthly limit. Unknown real invocations still hold their reservations. The restart/reconciliation regression verifies those behaviors and journal replay; related runtime/monthly-budget tests pass 64 / 3 environment-gated skips (67 cases), with typecheck passing.
