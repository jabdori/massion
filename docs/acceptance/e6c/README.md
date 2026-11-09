# E6c acceptance evidence

Payment and external-member decisions use the production Work effect reducer, decision service and `/assistant/decisions` route. Only explicitly registered fixture adapters run. A proposal pauses the Work; one owner approval permits one fresh committed dispatch claim. The request, input hash, original idempotency key, answers and remote receipt remain in the journal. Timeout, receipt mismatch, lost storage reply, shutdown and restart do not resend.

## Verification

- **137/137 targeted regressions passed on Node v24.21.0 for the CI/visual review correction.** This includes the reproduced failing `deadline refresh updates worker results without an event while member chat is selected` test, a mixed run/payment deadline regression, effect authority/dispatch/lineage tests, conversation/sidebar tests and fixture checks. The original E6c future-only deadline filter caused the CI failure; it excluded elapsed run deadlines and chose 60 seconds instead of 1 second. The fix filters expired payment deadlines only.
- `npm run typecheck` passes; UI copy lint reports no findings.
- [Initial-round browser interaction](interaction.json): later → ask → act through the rendered UI and production service; exactly one fixture transmission, remote arrival recorded as `received`, Work outcome still `unknown`, reload without another send. This is a synthetic loopback test transport; the normal server route is separately tested.
- [Contract report](report.md), [raw report](report.json), `checks/`, `snapshots/`, `visual/`, `screenshots/`, and `pairs/` retain B4, B16, B16-sent and B16-later in dark and light. Pairs place the approved artboard on the left and the application on the right. All eight pairs were inspected.

Reproduction: `TMPDIR=/private/tmp node --test tests/internal-teams-surface.test.ts tests/effect-decisions.test.ts tests/effect-decisions-ui.test.ts tests/conversation-cards.test.ts tests/surface-shell.test.ts tests/ui-contract-fixtures.test.ts tests/backup-lineage.test.ts`; `UI_CONTRACTS_BLOCKING=0 UI_CONTRACTS_OUTPUT=docs/acceptance/e6c node scripts/ui-contracts/run.mjs B4 B16 B16-sent B16-later`.

## Residuals

B4 now exposes only payment and Later, and the public route accepts only act/later/ask. Following the visual review, the browser tab uses the shared **unavailable** state, without a checkout-text reconstruction or second payment control. No browser page/snapshot producer or B15 browser component exists on inspected `origin/main` (`395193e`); the existing B15 fixture and E3d2 ledger also record that absence. Consequently B4 is **31/35** in each theme: three page-amount occurrences and the page member chip remain unsupported. These are reported failures, not a relaxed checker.

B16 now includes Devices navigation, an agent icon beside the recorded device label, and a summary derived from the pinned outgoing request: sentence count, repository name and test-name count. The literal instruction is not used in the decision rows. New repository metadata is optional only to preserve previously stored scope-only requests. The sent and later screenshots are unchanged by this correction.

The B16 variants retain the missing Representative rounding/check-rule proposal. Its row and unread occurrence cannot be fabricated from the external-member decision; the sent-state order diagnostic follows from this absent preceding row. These failures remain in the report and in [E3e residuals](../E3e/residuals.md). No checker, contract, text budget or CI switch was relaxed.

## Not run / not claimed

No real payment, remote device, provider model, credential delegation, deployment or merge. No live checkout screenshot or provider-confirmed order-history reconciliation. The default host has no effect adapter, and refuses approval when one is unavailable. Persistent trust of a device across different Work admissions is not added: each pinned handoff needs its own owner decision. Full-suite and full-contract runs belong to CI under the owner's verification budget; independent review belongs to the lead and the requested Codex PR review.
