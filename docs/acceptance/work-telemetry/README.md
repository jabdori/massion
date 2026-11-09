# Work step and check telemetry (R-A)

Work rooms retain observed step times, counts, independent predicates and
Work-bound messages through the existing command, journal and read model.
The visual correction uses the actual selected Work; the evidence driver no
longer injects an unrelated proposal/challenge/concession transcript.

[Design](../../architecture/work-telemetry.md), [domain](../../../src/domain.ts),
[progress validation](../../../src/work-telemetry.ts),
[configured worker producer](../../../src/configured-runtime.ts),
[room view](../../../src/work-room-panel.ts) and
[conversation](../../../src/assistant-conversation-panel.ts).

## Visual gate correction

| Screen | Checked behavior |
| --- | --- |
| B22-room-steps | Read 4/11 with running status and 10:40; next step; pending procedure note at 10:44 in the row and conversation; member/Check participants; no misleading aggregate header, generic criteria caption or injected challenge transcript. |
| B18-room-b | Check marks, recorded per-step times/counts, skipped reason, detail note, waiting/next states, four direction-labelled worker messages, and a 22-minute check-wait duration. |
| B18 | Conversation times use the existing muted monospace time tokens. |

The [six owned interaction flows](rooms/interactions.json) include both themes,
mobile overflow, pane toggle/close and note-link focus. Screenshots live in
`rooms/B18-{theme}.png`, `rooms/B18-room-b-{theme}.png` and
`rooms/B22-room-steps-{theme}.png`, with `-mobile.png` companions. Obsolete
injected-transcript captures were removed. The latest
[26 screen/theme capture report](contracts/report.md) includes related shared
surfaces and prototype/rendered pairs; it is not a full-prototype parity claim.

The [latest scoped gate](contracts/scoped-gate.json) has no new, stale or
infrastructure diagnostics. [This correction's audit](visual-correction-changes.json)
removes 60 resolved occurrences and narrows two existing gap descriptions.
[The initial telemetry audit](allow-list-changes.json) is retained separately.
The contract matcher, budgets and required elements are unchanged.

## Producers and boundaries

- Application commands record admission/criteria, task and check times. Historical
  missing observations stay missing; replay returns the original time.
- `record-step-progress` accepts bounded monotonic units from the assigned worker,
  freezes the total, records host time and refuses unknown/interrupted Work.
  The bounded text runtime reports its actual one-call step as 0/1 then 1/1.
  Finer controlled fixture observations demonstrate 4/11 and 3/3; these are not
  claims of real browser/file operations or accepted business evidence.
- The validated plan retains the actual optional worker instruction. Pane messages
  project that instruction/start and result/end with their direction and role.
  Silent internal results remain in deliberate flow detail.
- The existing owner Work message accepts an optional exact-step procedure note.
  It stays pending discussion: no plan, skill, permission, memory or acceptance
  changes. It uses the existing ownerStore/CAS/drain boundary.
- The independent checker retains validated predicates, quotes and reasons. Its
  structured result does not duplicate raw provider-review JSON on the surface.

[Room fixture producer](../../../scripts/ui-contracts/room-telemetry-fixtures.ts)
uses owner procedure writes, validated plans, assignments, progress, effects,
receipts and the owner note command. It validates the selected Mission's lineage.
[General regeneration](../../../scripts/ui-contracts/regenerate-work-telemetry.ts)
retains the existing fixture inputs and produces the observations; regeneration
is byte-stable. No real provider or payment is invoked.

## Residuals

- **Monthly pricing table:** still lacks a typed business-result producer. Worker
  prose is not converted into a table. Its missing amount/count cells remain
  explicitly allow-listed, as requested.
- **R-D:** the B18 memory-candidate row and its keep/discard controls are unchanged.
- **R-E:** B22-room PR head/check/files/read-mark content is unchanged. Its original
  fixture and app view are not rewritten by the steps-view generator.
- A pending owner procedure note does not fabricate a member acknowledgement.
  The prototype's second reply/Copy occurrence therefore remains absent.
- Existing business-specific conversation summaries and shell geometry residuals
  remain in the capture report. Historical shopping presentation fixtures retain
  their pre-existing nonportable artifact IDs; runtime journal tests, not those
  presentation fixtures, establish storage/restore evidence.

## Verification

Node 24.21.0: related integration batch 230 tests, 223 passed, seven environment
skips, zero failures. Later affected shell/card/UI checks passed 139 tests; the
final row-state checks passed 51. These batches overlap. Typecheck, copy diagnostic
gate and diff whitespace checks passed. New boundary and visual assertions were
observed failing before their fixes. Tests cover duplicate commands, drain,
unknown outcomes, journal replay, stale/feed/deadline behavior, late reads,
literal rendering and exact Work binding. Full tests and all screens run in CI.

```sh
node scripts/ui-contracts/regenerate-work-telemetry.ts
UI_CONTRACTS_OUTPUT=docs/acceptance/work-telemetry/rooms node scripts/ui-contracts/verify-member-rooms.mjs
UI_CONTRACTS_OUTPUT=docs/acceptance/work-telemetry/contracts node scripts/ui-contracts/run.mjs B7 B7-churn B7-done B7-fail B7-unknown B8 B8-done B8-fail B8-unknown B18 B18-room-b B22-room B22-room-steps
npm run typecheck
```
