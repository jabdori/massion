# Work pane fidelity (E3c)

Replace the Work-tab execution/evidence presentation with the approved compact room (B7) and expanded inspection (B8). Existing Mission tabs retain the technical authoring/inspection controls. Source copy is `docs/product/screens/copy.ko.json`; visual values use generated tokens from `visual.json`. No new API, provider invocation or durable state is introduced.

Render current exact Work state: status, actual start/end time, participant identity, task progress/results, criteria, independent verdict, retained Record and discussion. Use only timestamps actually produced by the host. Never interpret an execution budget unit as currency, a generic effect as payment, or owner-only discussion as agent room chat. Missing browser telemetry, payment amount/approval/order facts, named team-worker roles and per-step timestamps remain explicit capability residuals.

Stop calls the existing `sendCommand(cancel)` path, with current Mission/revision checks, existing recovery/idempotency lock and drain-aware server admission. Unknown effects remain unknown; no timeout causes replay. There are no new async reads; the view consumes the existing generation/scoped snapshot. Exact Record/result inspection reuses existing controls and read guards.

## Execution and evidence

1. Save all nine B7/B8 states in both themes, classify every failure and post the cause table before UI edits.
2. Extend existing client tests first for current Work presentation, safe Stop, immutable unknown state and expanded controls; observe failure before implementation.
3. Replace only Work-tab presentation and its styles. Repair supported fixture read shapes separately; never add fictional telemetry or relax the checker.
4. Re-run scoped contracts plus B4 residuals, inspect all 18 artboard/app pairs and record every remaining failure with producing-path evidence. Run focused tests, typecheck, source checks and aggregate tests.
5. Commit and push `feat/fidelity-work-pane`, open/update the PR to main, request `@codex review` and do not merge. E3 as a whole stays open.

Current baseline and decisions are recorded under `docs/acceptance/e3c/`. The supplied execution brief is the approved plan; no additional product design or visual exploration is needed. External reference: [MDN grid sizing](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/grid-template-columns).
