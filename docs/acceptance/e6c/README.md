# E6c acceptance evidence

Payment and external-member decisions use the production Work effect reducer, decision service and `/assistant/decisions` route. Only explicitly registered fixture adapters run. A proposal pauses the Work; one owner approval permits one fresh committed dispatch claim. The request, input hash, original idempotency key, answers and remote receipt remain in the journal. Timeout, receipt mismatch, lost storage reply, shutdown and restart do not resend.

## Verification

- **170/170 targeted regressions passed on Node v24.21.0 for the CI/visual review correction.** This includes the reproduced failing `deadline refresh updates worker results without an event while member chat is selected` test, a mixed run/payment deadline regression, effect authority/dispatch/lineage tests, conversation/sidebar tests and fixture checks. The original E6c future-only deadline filter caused the CI failure; it excluded elapsed run deadlines and chose 60 seconds instead of 1 second. The fix filters expired payment deadlines only.
- `npm run typecheck` passes; UI copy lint reports no findings.
- [Initial-round browser interaction](interaction.json): later → ask → act through the rendered UI and production service; exactly one fixture transmission, remote arrival recorded as `received`, Work outcome still `unknown`, reload without another send. This is a synthetic loopback test transport; the normal server route is separately tested.
- [Contract report](report.md), [raw report](report.json), `checks/`, `snapshots/`, `visual/`, `screenshots/`, and `pairs/` retain B4, B16, B16-sent and B16-later in dark and light. Pairs place the approved artboard on the left and the application on the right. All eight pairs were inspected.

Reproduction: `TMPDIR=/private/tmp node --test tests/internal-teams-surface.test.ts tests/effect-decisions.test.ts tests/effect-decisions-ui.test.ts tests/conversation-cards.test.ts tests/surface-shell.test.ts tests/ui-contract-fixtures.test.ts tests/backup-lineage.test.ts tests/skills-surface.test.ts tests/apps-surface.test.ts tests/members.test.ts`; `UI_CONTRACTS_BLOCKING=0 UI_CONTRACTS_OUTPUT=docs/acceptance/e6c node scripts/ui-contracts/run.mjs B4 B16 B16-sent B16-later`.

## Residuals

B4 now exposes only payment and Later, and the public route accepts only act/later/ask. Following the visual review, the browser tab uses the shared **unavailable** state, without a checkout-text reconstruction or second payment control. No browser page/snapshot producer or B15 browser component exists on inspected `origin/main` (`395193e`); the existing B15 fixture and E3d2 ledger also record that absence. Consequently B4 is **31/35** in each theme: three page-amount occurrences and the page member chip remain unsupported. These are reported failures, not a relaxed checker.

B16 now includes Devices navigation, an agent icon beside the recorded device label, and a summary derived from the pinned outgoing request: sentence count, repository name and test-name count. The literal instruction is not used in the decision rows. New repository metadata is optional only to preserve previously stored scope-only requests. The sent and later screenshots are unchanged by this correction.

The B16 variants retain the missing Representative rounding/check-rule proposal. Its row and unread occurrence cannot be fabricated from the external-member decision; the sent-state order diagnostic follows from this absent preceding row. These failures remain in the report and in [E3e residuals](../E3e/residuals.md). No checker, contract, text budget or CI switch was relaxed.

## Post-merge contract identities

After E6c and the blocking baseline merged, main `ac99f1da04ca51007223edb566e36d3b29933cb6`
reported 38 resolved exceptions and 18 new diagnostic identities in [CI run
42657950604](https://github.com/jabdori/massion/actions/runs/42657950604).
The [exact addition reasons](rebaseline-reasons.json) cover both themes and
preserve duplicate amount occurrence ordinals. These are bounded exceptions,
not successful screen contracts. Remove them when their producers land.

- **B4 amount occurrences 1–3:** the contract requires item subtotal, shipping
  and total inside the browser pane. `chatCheckoutRender` in
  `src/assistant-conversation-panel.ts` renders only the shared unavailable
  paragraph. Amounts in the conversation decision card cannot satisfy these
  page slots. There is no page snapshot producer; copying the pinned checkout
  fields into a mock page would misrepresent observed browser content.
- **B4 member-chip order:** the contract requires the page member chip after
  the page amounts. The unavailable pane has no page identity chip. The
  checker's Korean-name placeholder also matches the earlier unavailable
  text, producing an order diagnostic after the close control. Reordering the
  tab/close controls would not supply the absent page identity. It needs the
  same real page snapshot producer, not a fabricated chip.
- **B4 gap:** the unavailable browser tab and lack of checkout-text fallback
  explicitly record that same missing producer.
- **B16, B16-later and B16-sent gaps:** the external-member handoff does not
  produce the separate Representative rounding/check-rule proposal. Its
  activity row and associated unread state remain absent.
- **B16-sent sidebar-link order:** `src/surface-shell.ts` places open decisions
  before sent external handoffs, then other Work rows. The snapshot contains
  the correctly labeled sent link before the unrelated PR #84 unread row.
  The contract expects a rounding-proposal row and its unread marker before
  that link. With the proposal absent, the checker consumes the later PR #84
  unread text, then reports the preceding sent link as out of order. Moving
  unrelated activity or inventing unread state would conceal the missing
  proposal. Remove this exception together with the rounding-proposal
  residual after the real producer supplies that preceding row and marker.

### Rebaseline verification

[Machine-readable results](rebaseline-verification.json): 978 original entries
minus 38 resolved plus 18 explicitly justified additions equals 958. Every
retained entry and the original baseline source are unchanged. The gate against
the complete 150-row CI capture passes with zero new, stale or infrastructure
diagnostics. Node v24.21.0: all six gate unit tests and typecheck pass.

A fresh headless capture of B4, B16, B16-later and B16-sent in both themes is
stored locally in `.runtime/rebaseline-local/` (`report.json`, `checks/`,
`snapshots/`, `screenshots/`, `visual/`, `pairs/`). The existing capture reader
and gate evaluator pass against the exact eight-row subset: 24 allowed
occurrences, zero new/stale/infrastructure diagnostics. Raw contracts still
report 16 failures and eight producer gaps; there are no visual failures or
warnings. This verifies classification, not completion of those capabilities.
No UI, fixture, contract, checker or gate implementation changed.

## Not run / not claimed

No real payment, remote device, provider model, credential delegation, deployment or merge. No live checkout screenshot or provider-confirmed order-history reconciliation. The default host has no effect adapter, and refuses approval when one is unavailable. Persistent trust of a device across different Work admissions is not added: each pinned handoff needs its own owner decision. Full-suite and full-contract runs belong to CI under the owner's verification budget; independent review belongs to the lead and the requested Codex PR review.
