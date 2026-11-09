# Work step and check telemetry (R-A)

The product now records host observation times for admission/criteria pinning,
task effects and settlement, independent checks, steering and owner/room messages.
The existing Q13 plan supplies named steps, roles, dependencies and skips. Validated
independent checker predicates retain their result, quote and reason in the Work
and accepted Record. No missing historical observation is inferred.

[Design](../../architecture/work-telemetry.md), [domain](../../../src/domain.ts),
[application clock](../../../src/application.ts), [checker](../../../src/configured-runtime.ts),
[room view](../../../src/work-room-panel.ts) and
[Work-bound conversation](../../../src/assistant-conversation-panel.ts).

## Evidence

- [Screen report](contracts/report.md): twelve affected screens in dark/light,
  including B7 variants, B8 variants, B18-room-b and both B22 room views. The
  report includes required-element, text-budget, token and region checks, plus
  side-by-side prototype/rendered images. It is not a full-contract pass claim.
- [Room interactions](rooms/interactions.json): eight dark/light flows check
  timestamped room messages, exact selected Work, pane expansion/close, mobile
  overflow and absence of the legacy inspector.
- [Final scoped gate](contracts/scoped-gate.json): zero added, stale or infrastructure
  diagnostics against the retained exceptions.
- [Exception changes](allow-list-changes.json): exact removed occurrences and
  before/after mappings for existing residual diagnostics. No new exception is
  admitted for a new capability failure.
- Core and UI tests exercise duplicate command replay, drain fencing, unknown
  outcomes without resend, journal replay/tampering, skips without invented start
  times, mixed pass/fail predicates, stale verdicts, feed replacement, deadline
  refresh, delayed reads and literal rendering. External calls use loopback mocks.

Regeneration uses [fixed pre-change inputs](../../../scripts/ui-contracts/work-telemetry-inputs.json)
and [domain command producers](../../../scripts/ui-contracts/regenerate-work-telemetry.ts).
The input snapshots preserve the existing fixture text and evidence; new times
come from explicit versioned host observations. B7-churn reuses the established
Q13 procedure fixture. The second pricing Work is regenerated in its parent so
B18-room-b remains a small inherited fixture. Fixture evidence is not live-model,
browser, payment or business-oracle evidence.

## Residuals

- Text-only shopping Works still have generic producing/checking tasks. They do
  not produce shopping stages, browser/page/file-read counts, payment decisions,
  orders or vendor receipts. Timing a generic task does not establish those facts.
- Q13's four actual churn steps differ from the prototype's business procedure.
  Dependencies and skipped results are retained, but queued workers have no
  result or final summary message. Work-bound participant discussion is shown in
  the conversation; prototype pane-message ordering still differs.
- The pricing fixture has no typed pricing table, admitted member procedure or
  memory proposal. Its actual task and steering times now render; those other
  producers remain absent.
- Legacy verdict fixtures do not contain structured independent-check reports.
  Their overall verdict is not expanded into fabricated business predicates.
  The real configured runtime and UI tests cover the new structured report path.
- Remaining geometry, copy and order differences in the reports are retained
  explicitly. The complete suite and screen catalog remain CI-owned.

The pre-existing shopping UI fixtures use nonportable artifact identifiers; their
standalone portable-lineage check fails identically before and after this change.
They are presentation fixtures, not backup/restore proof. Runtime/application
journal tests provide storage evidence.

The 30 mapped diagnostics retain existing missing capabilities: old missing-time
wording is narrowed to remaining browser/business/room/table producers; a later
summary role reports an order failure after the earlier actual role becomes
visible; unknown shopping rows still lack business/payment events after a real
task time fills the first time slot. The matcher, budgets and contract requirements
are unchanged. Exact mappings are in `allow-list-changes.json`.

## Reproduce

```sh
node scripts/ui-contracts/regenerate-work-telemetry.ts
UI_CONTRACTS_OUTPUT=docs/acceptance/work-telemetry/contracts node scripts/ui-contracts/run.mjs B7 B7-churn B7-done B7-fail B7-unknown B8 B8-done B8-fail B8-unknown B18-room-b B22-room B22-room-steps
UI_CONTRACTS_OUTPUT=docs/acceptance/work-telemetry/rooms node scripts/ui-contracts/verify-member-rooms.mjs
npm run typecheck
```

The screen command reports residuals without hiding them. The PR's full blocking
CI gate checks the complete capture against the remaining allow-list.

## CI integration follow-up

The full CI unit suite exposed B5's fixed snapshot missing the newly observed
admission/task times. `regenerateException()` now rebuilds that fixture through
its original Application command sequence. The unchanged exact-snapshot test
passes with explicit time assertions; B5's two-theme scoped gate has zero new,
stale or infrastructure diagnostics. Main's E9a2 browser/desktop journey updates
were merged without rewriting history. The first telemetry head passed the full
screen gate and received clean Codex code/security receipts; the final head is
verified again on the PR.
