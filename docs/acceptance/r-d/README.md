# R-D: rule decisions, member memory and visual-gate corrections

## Implemented

Stored host-rounding Growth evaluations produce exact owner decision cards and activity rows. Owner act/later/ask use the existing decision path; act retains independent improvement and current-baseline checks. Unknown deliveries never resend. Both memory and rule endpoints identify definite pre-intent refusals so a fresh owner review remains possible.

Member turns may propose one named memory instruction separately from Work steering. Candidates pin the member, owner message, segment, ID/version/hash, Mission and optional source Work. Save records a durable owner intent before one original Mission write; discard writes no memory. Restart reconciliation is read-only. A definite post-intent save rejection is recorded as terminal host bookkeeping, so later reads remain `not_saved`; uncertain outcomes stay locked. Memories retain names and exact source input/criteria hashes.

## Visual-gate corrections

- **Case link:** B2's approved link targets B12. It opens existing Memory evidence only after the exact Mission/revision and current navigation generation have loaded; stale or out-of-order reads do not expand another proposal. The unapproved case pane, version IDs, raw calculation layout and invented headings were removed. `case-memory.png` shows the approved destination.
- **B2/B9:** the proposal is in the captured viewport with `지금 / 변경 후 / 주의`, the two actions and right-aligned case link. No phantom rounding Work appears in the sidebar. Production schedule transitions create the fixture briefing; exact pending decision links supply B9's `반올림 규칙` entry. `B9-briefing.png` verifies its navigation back to the proposal.
- **B18-room-b:** the fresh isolated capture opens the exact `경쟁사 가격` Work pane. No stale rule-case tab exists.
- **Member candidates:** B6, B7-fail and B18-room-b render the inline `기억 후보: {text} 남기기 지우기` line once, without a bordered card or repeated name/content.
- **B12:** one Settings search field; one title and one inline detail/source line. The explicit baseline is genuinely effective and the learned candidate genuinely pending. Actual timestamped adoption and reversion commands produce dated history; evaluation time is never substituted. An already-reverted historical entry cannot be undone directly, so its history control is disabled; adoption remains an owner decision.

## Verification

A production fixture Workbench browser walk also verified Send → new member candidate → enabled save/discard → saved receipt without reload. Related tests cover the four recurring failure classes, strict candidate input, backup lineage, source navigation, dated and legacy history, native-hash completion, approved case navigation and briefing references. `npm run typecheck` and copy lint pass. The final related local run passed 167 tests with 16 actual-DB cases skipped (183 total). Real DB/provider/payment execution is not local visual evidence.

Affected browser captures cover B2 and offline variants, B9 and variants, B12, B16 and variants, B7 detail variants, B6, B18 and B18-room-b in both themes. B12 passes 26/26 required elements; B16 passes 22/22; B16-later passes 21/21; offline variants pass 20/20 and 22/22. Every measured remaining diagnostic matches an existing scoped exception, with no new or stale entries. Six B9 briefing exceptions were removed in this correction, reducing the original 804-entry allow-list to 734.

Committed fresh captures: `B2-dark.png`, `B2-light.png`, `B12-dark.png`, `B12-light.png`, `B18-room-b-dark.png`, `B18-room-b-light.png`, `B6-dark.png`, `B7-fail-dark.png`, `B9-briefing.png`, `case-memory.png`. Obsolete case-pane and stale-tab screenshots were removed. Full measured snapshots, checks and artboard pairs are under `.runtime/rd-visual-final/`.

## Remaining B6 detail

The older B6 fixture still lacks recorded research/team and enterprise-steering detail. Its exception no longer claims member memory candidates are missing. Unrelated business summaries, step timestamps, layout drift and unavailable integrations keep their existing exceptions.

## Remaining sent-row chronology

B16-sent has a real rounding-rule activity row. Reading it clears its unread marker; the remaining PR unread marker follows the sent link while the contract expects one before it. Keep the existing ordering exception rather than reorder unrelated activities.

## Integration

The main-branch MCP browser-context fix is integrated before final-head CI. Full repository, actual durable-store and all-screen checks run in CI under the local verification budget. This PR is never merged by this task.
