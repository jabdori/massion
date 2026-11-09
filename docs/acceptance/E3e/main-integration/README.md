# Main integration and blocking visual fixes

Merged origin/main `094eca4`, then `1d0d1e3` after #111 landed, including Q13,
the desktop/daemon work and the secret launcher, into
`feat/fidelity-remaining` without rewriting history. Resolve only copy-table and
Work-room conflicts: retain all additive copy, Q13 roles/dependencies/results,
E3e failure evidence and root-excluding legacy counts. Team status notes inherit
their row color, so ordinary dependency/skip notes do not become red failures.
Existing Q13 tests now check team and legacy procedure counts separately.

B26/B26-later reuse B7-done's exact existing Work reads rather than B2's rounding
evaluation conversation. No renderer filters or fabricated approvals are added.
A regression checks all resolved fixture bytes and conversations for leaked test
results. The actual decision HTTP route regression checks all nine act/later/ask
attempts for the absent payment/external-device/budget proposal IDs: 400, no events.

The payment/external-device/monthly-budget cards, B4 checkout pane, B16's two
priority decisions and B26's budget-wait separator **remain blocking**. Their exact
missing producers and why the existing permission/fresh-budget APIs cannot replace
them are recorded in the [current residual ledger](../residuals.md#main-integration-and-blocking-visual-gate-2026-11-09).
The historical forty captures and allow-list counts describe b8f1f20 only; Q13 is
now merged, so its previous dependency status is no longer a current capability claim.

Validation: Node 24.21.0 typecheck passed; nineteen related test files produced
339 passes, nine environment-gated skips, zero failures; copy lint has zero findings.
Four fresh budget-screen captures have six expected missing-decision/reopen/attention
diagnostics, zero geometry or infrastructure errors, and no leaked TOTAL examples.
The lead's independent review and visual gate remain in progress. Full tests and
all screen contracts belong to CI; inherited desktop code was not modified further.

Artboard left, app right:

| State | Dark | Light |
| --- | --- | --- |
| B26 | [PNG](pairs/dark/B26.png) | [PNG](pairs/light/B26.png) |
| B26-later | [PNG](pairs/dark/B26-later.png) | [PNG](pairs/light/B26-later.png) |

Related test command:

```sh
TMPDIR=/private/tmp/massion-e3e-tests node --test tests/work-room-visual.test.ts tests/internal-teams-surface.test.ts tests/conversation-cards.test.ts tests/conversation-visual-gate.test.ts tests/member-work-surface.test.ts tests/members-surface.test.ts tests/surface-shell.test.ts tests/conversation-work-panel.test.ts tests/ui-contract-fixtures.test.ts tests/ui-copy.test.ts tests/ui-copy-lint.test.ts tests/internal-teams.test.ts tests/member-work.test.ts tests/permissions.test.ts tests/owner-work-budget.test.ts tests/server.test.ts tests/configured-runtime.test.ts tests/tool-call.test.ts tests/secret-launcher-runtime.test.ts
npm run typecheck
node scripts/ui-contracts/copy-lint.mjs
UI_CONTRACTS_OUTPUT=.runtime/e3e-main-integration UI_CONTRACTS_BLOCKING=0 node scripts/ui-contracts/run.mjs B26 B26-later
```
