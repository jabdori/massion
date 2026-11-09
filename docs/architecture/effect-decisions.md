# Payment and external-member decisions (E6c)

The owner decides a pinned payment or external-member handoff when a Work reaches that step (ADR 0002 §5, §11–12; ADR 0003; ADR 0005). The existing decision route carries act, later and ask. The reducer retains historical terminal refusal records, but the route and card expose only those three answers. No payment or remote-device integration is enabled by default.

## Boundary

Keep the proposal, owner answers, immutable request, dispatch identity and receipt on the Work's existing effect. Proposal and pause commit atomically in its Mission. The host derives the decision identity from Mission, Work and step, so changing a checkout cannot create a second authorization for the same step. The request pins integer KRW amounts, checkout expiry and visible order facts, or a device/agent identity, instruction and scope. It also pins the Work input hash. Only the owner can answer; only the dedicated host actor can propose, claim and record the adapter result.

A fresh committed claim is the only invocation permission. It records unknown before calling the adapter, with one idempotency key. Replayed/ambiguous claims, overlapping answers, restart and restore never invoke. A bounded timeout, invalid receipt or lost reply stays unknown; no automatic resend or late result overwrites it. External arrival is recorded separately from completed processing and never accepts a Work result. Generic effect commands cannot bypass this decision's receipt or claim boundary.

Owner admission and dispatch claims use the drain-aware owner store. Already-started receipt writes use the host store so drain can settle local bookkeeping. The normal feed and client generation guards cover stale reads. Restored snapshots/journals validate this additive effect shape and replay its typed commands without running adapters.

## Plan and verification

- [x] Add failing fixture-only tests for exact payment/handoff approval, pause, rejection/deferral, expiry/input changes, overlapping commands, lost claim/reply, receipt identity and restart/lineage.
- [x] Extend domain effect transitions, backup lineage, the host decision service and existing server route; no new public producer route.
- [x] Reuse the conversation decision UI and pane tokens for checkout, admission, sent and deferred states. Test generation/feed fencing and run the four affected contracts in both themes with agent-browser.
- [x] Generate fixture data from actual transitions/readers, retain artboard/app pairs in `docs/acceptance/e6c/`, and update only resolved E3e residuals. The unrelated rounding proposal remains a residual.
- [x] Run typecheck and related tests only (the owner's verification budget), and merge current origin/main. CI owns full-suite/contracts.

Delivery: push `feat/effect-decisions`, open the requested PR and request `@codex review`; do not merge.

No real money, remote device, credentials, autonomous hiring, general browser automation or new retry mechanism is included. The fixture adapter proves dispatch semantics, not provider delivery or payment competence.

## PR #120 review correction

The E6c timer change filtered past run deadlines together with expired payments. Preserve the original one-second refresh for elapsed run deadlines; only already-expired checkout deadlines are omitted. The existing member-chat regression and an added mixed-deadline regression cover both semantics.

B4 exposes only payment and Later. No page snapshot producer exists on the inspected main (`395193e`); the browser tab shows the shared unavailable state and never reconstructs a page by dumping checkout fields. B16 restores Devices navigation and the recorded agent/device identity. Its send summary counts request sentences and pinned repository/test-name fields, while retaining compatibility with older scope-only requests. It never displays the literal instruction in the decision rows.
