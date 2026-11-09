# PR 108 review correction evidence

The initial E3c delivery was not ready: the complete CI capture found a B22 setup regression, and a projected member-room unknown card could not open its read-only review. This revision fixes both and applies the requested visual-gate changes without changing the checker or treating infrastructure errors as gaps.

## Integration and review action

- **B22-room-steps:** the evidence summary is inside the new closed Work-room inspection. The fixture now clicks the outer check bar before the nested evidence summary, then waits for the original attempts summary. A fixture regression checks that order, and the headless interaction regression performs the actual clicks in both themes. The original error was reproduced in both themes before the fix.
- **Projected unknown Work:** the shared `chatReviewUnknown` handler resolves `chatView.turns` and the same `chatRoomTurns()` projection that rendered the card. All existing generation/thread/segment/feed/epoch/Mission/Work/run/focus guards remain. Six added regressions cover the real card action opening the exact current review, no product writes, retained unknown effects and late responses after scope/focus changes. No handler submits, acknowledges, quarantines or settles the outcome.
- **Push gate:** every push runs the exact CI command, `UI_CONTRACTS_BLOCKING=0 node scripts/ui-contracts/run.mjs`, with no screen arguments: all 75 contracts in both themes. No timeout, error classification, occurrence, order or budget rule was relaxed. Capture-input hashes bind the final run to the pushed implementation.

## Visual gate A–J

| Item | Result | Verification |
| --- | --- | --- |
| A — Budget | Removed the standalone Work-room budget line. None of the nine B7/B8 contracts requires a budget/currency/token line. Existing technical inspection retains the original budget data. | Unit and browser assertions reject `.room-budget`. |
| B — Check bar | Full-width bottom summary with the approved shield, bold waiting/done/failed/not-checked label, actual criterion/evidence detail and right chevron. Failed status/detail is red. Native disclosure behavior and existing deep controls remain. | Both-theme bounds, icon masks, status and normalized failure-color assertions. |
| C — Stop | The existing Stop control has the 8px square glyph and keeps its existing guarded command path. | Browser pseudo-element size/content assertion. |
| D — Procedure/chip | Borderless procedure and header, list icon and icon-bearing Check chip. Procedure progress stays beside its title. | Computed borders, masks and 8px title/progress gap. |
| E — Done | Checkmark before the done state and on settled steps. | Actual SVG masks in both themes. |
| F — Fail | The bound verifier task has a red cross and is excluded from the procedure completion count. Other verification tasks are not spuriously failed. The footer and failure values are red. | Failed-step and progress regressions, including another settled verification task; normalized browser colors. |
| G — Terminal | One terminal predicate excludes Stop for unknown, accepted, failed, stale, cancelled and settled Work. Unknown effects remain unknown and their task displays that uncertainty rather than an active-looking generic step. | All done/fail/unknown cases in both compact and wide views; stored unknown state is unchanged. |
| H — Cards | Definition-list rows with label/value/note columns. Progress stays in its criterion row; the Record body uses a Result row instead of repeating its heading. The actual artifact effect has a Result label, separate from Write and Check. | Four structured row groups, no duplicate effect labels in the supported runtime fixture; original criteria/record/effect data remain inspectable. |
| I — Flow | Actual events have a fixed time column, bullet column and text column. | Every rendered row has its bullet; token values come from the approved artboard measurements. |
| J — Failed flow | Removed the synthetic `대화` event. Owner discussion remains in the compact room and original inspection; a discussion with no event timestamp is not invented as a flow event. | Browser and unit assertions reject that stray row. |

B8 card headers are 38px. The B7 procedure header is 34px and its rows are at least 32px, preserving long-content wrapping. This also prevents the legacy global `header` height from expanding the cards. The dimensions are measured in `visual.json` and emitted by the token generator; generated CSS was not hand-edited.

## Production connection labels

The previous provider strip printed `Assignment.model.provider`, so its literal `fixture` value was not a safe production display contract. That fallback is removed. The view now resolves the Work's exact executor/verifier profile IDs and configuration hashes, then matches the selected profile revision/provider kind to the current host connection catalog and displays the connection's declared label. Multiple real connection labels are retained without repeating an identical label. If the original binding cannot be matched, the view says `알 수 없음`; it never substitutes a raw provider ID as a connection name.

The regression checks a pinned production-shaped profile/catalog, verifies the real connection label instead of the fixture assignment's provider tag, and rejects a changed profile hash. No connection discovery, model call or new async read is introduced.

## Evidence

- [Final full-run receipt](full150-execution.json) and [all 150 rows](full150.json).
- [Both-theme visual/interaction assertions](interactions.json), including the actual B22 nested-evidence setup.
- [B22 dark pair](pairs/dark/B22-room-steps.png) and [light pair](pairs/light/B22-room-steps.png).
- [All 18 requested B7/B8 pairs and scoped counts](README.md).
- [Final verification receipt](verification.json).

Only missing producing capabilities and their strict-order diagnostics remain in the scoped ledger. Visual changes A–J are implemented changes, not capability deferrals. The original strict contracts remain unchanged; the Record layout follows the explicit visual-gate request to avoid a repeated body heading, and its generic Record data remains present.

Final local verification: full150 exit0 with zero infrastructure errors; both B22 setups reached their actual nested evidence state; native visual/interaction checks20/20 passed; focused regressions111 passed; complete suite1,578 passed,340 skipped, one previously documented local macOS portable-inventory failure. No CI error policy, checker rule, timeout or contract was weakened.

## Subsequent P2: command feedback visibility

The generic Work-room sibling filter also hid the existing live `#status` region. Since `report()` routes an open-pane action's feedback there, revision conflicts and command warnings were invisible. The filter now keeps only that region's error/warning states visible; ordinary ready/loading/success helper text remains hidden. The region is sticky at the pane's top, so a rejected technical action remains visible after the owner scrolls into its inspection.

A regression rejects the actual Stop command with a revision conflict, verifies that Work stays active, and checks that the existing warning reports the conflict without an automatic retry or unknown-command reclassification. Native browser assertions additionally verify both error and warning visibility in compact/wide rooms at 1440px and 390px in both themes, after scrolling the pane. Normal helper text is hidden again when cleared. These 16 viewport/tone assertions issue zero product commands and do not synthesize a provider outcome. The full 150-state CI-command gate is repeated before the follow-up push.

Command-feedback follow-up verification: repeated full150 exit0 with zero infrastructure errors on the final inputs; native cases20/20 and viewport/tone feedback assertions16/16 passed; complete suite1,578 passed,340 skipped,one known local portable-inventory failure.

## Subsequent P2: projected Work Start

The Start handler also used only the current member conversation, so a projected unstarted Work displayed a control that could not resolve its original turn. It now resolves the same current room projection as the renderer, Retry, Close and unknown review. Existing busy/sending/in-flight guards remain; already-started, unknown, accepted/stale/failed and closed Work cannot be started by a stale control.

Both the Representative and projected-room Start use the existing durable `write(..., longRun=true)` boundary for the same `/missions/:id/run` command. The original Work ID/revision and one operation identity are persisted before the request, admission receipts release the existing owner-write fence, and an unresolved request cannot be resent with a new identity after a view switch. This adds no run API, resume operation, model route or automatic retry. The global write-control lock disables Start while a command outcome is unresolved.

Two regressions reproduce overlapping actual Start clicks in both views, verify the original Work/revision payload, then return an unknown response and change back to the Representative. Each scenario retains the original pending command identity and exactly one POST. Both tests failed before the fix (projected Start sent no request; direct Start had no durable unknown fence) and pass after the shared-path correction. All Work-card action handlers were checked for the same projection boundary. The complete 150-state CI-command gate is run again before this follow-up push.

Start follow-up final verification: full150 exit0, zero infrastructure errors, final inputs unchanged; focused111 passed; complete suite1,578 passed,340 skipped,one known local portable-inventory failure. The legacy lost-response unit fixture now supplies the real initial read-state handshake instead of relying on an unready client sending a direct request; its original focus/node/label/lost-response assertions remain.
