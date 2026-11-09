# Work pane fidelity (E3c)

Replace the Work-tab execution/evidence presentation with the approved compact room (B7) and expanded inspection (B8). Existing Mission tabs retain the technical authoring/inspection controls. Source copy is `docs/product/screens/copy.ko.json`; visual values use generated tokens from `visual.json`. No new API, provider invocation or durable state is introduced.

Render current exact Work state: status, actual start/end time, participant identity, task progress/results, criteria, independent verdict, retained Record and discussion. Budget metadata remains in technical inspection; the corrected B7/B8 view has no standalone budget line. Use only timestamps actually produced by the host. Never interpret an execution budget unit as currency, a generic effect as payment, or owner-only discussion as agent room chat. Missing browser telemetry, payment amount/approval/order facts, named team-worker roles and per-step timestamps remain explicit capability residuals.

Stop calls the existing `sendCommand(cancel)` path, with current Mission/revision checks, existing recovery/idempotency lock and drain-aware server admission. Unknown effects remain unknown; no timeout causes replay. The view consumes the existing generation/scoped snapshot. If the exact original Representative turn is outside the loaded segment, one existing conversation-segment query reads its handoff time. A per-render generation and request scope, pane/Work/Mission/revision/feed/epoch checks, original-message binding and DOM-identity recheck fence late responses; the out-of-order source-read regression covers tab changes. No new read or write API is added. Exact Record/result inspection reuses existing controls and read guards.

## Execution and evidence

1. Save all nine B7/B8 states in both themes, classify every failure and post the cause table before UI edits.
2. Extend existing client tests first for current Work presentation, safe Stop, immutable unknown state and expanded controls; observe failure before implementation.
3. Replace only Work-tab presentation and its styles. Repair supported fixture read shapes separately; never add fictional telemetry or relax the checker.
4. Before every push, run the full 75-contract runner in both themes with the CI command (`UI_CONTRACTS_BLOCKING=0 node scripts/ui-contracts/run.mjs`, no screen arguments), including B4 residuals, inspect all 18 artboard/app pairs and record every remaining failure with producing-path evidence. Run focused tests, typecheck, source checks and aggregate tests.
5. Commit and push `feat/fidelity-work-pane`, open/update the PR to main, request `@codex review` and do not merge. E3 as a whole stays open.

Current baseline and decisions are recorded under `docs/acceptance/e3c/`. The supplied execution brief is the approved plan; no additional product design or visual exploration is needed. External reference: [MDN grid sizing](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/grid-template-columns).

## Review and integration corrections

Same-revision Work/Mission tab changes rebuild the appropriate presentation. A verdict is current only when its artifact hash/version and criteria version match, and stale acceptance cannot show a checked result. End time comes from the durable Work snapshot before the global list. Source-use and inbox inspection links open all current enclosing details before focusing a technical control. The expanded layout keeps the existing Stop node after the heading in DOM order and at its approved visual position. Header busy status follows the named member in accessibility order. All unrelated wide views retain their existing layout.

The member Work room reuses exact original Representative Work turns and the current same-feed global Work list for its conversation cards. Older progress is discarded when revisions differ. Retry only prepares the pinned owner text as a private draft; Close in both member and Representative views uses the existing durable write/recovery boundary, so changing views cannot resend an unknown cancellation. Existing global unknown/receipt state, not a component-local busy flag, controls replay.

## PR 108 requested visual and integration corrections

The B7/B8 contracts require no budget line; remove the earlier brief-only line. Render the approved full-width bottom check bar, status/step glyphs, terminal-state Stop rules, borderless procedure and icon-bearing check chip. Expanded cards use labelled rows and bullet-separated actual events without synthetic discussion markers, duplicate Record labels or mislabelled artifact effects. Connection text resolves the exact pinned profile/configuration to its catalog connection label and fails closed to an unknown label instead of displaying a provider tag. B22 opens the new outer inspection before nested evidence. Unknown-outcome review resolves room-projected source turns using the shared handler and retains every read-only freshness/run/focus guard.
