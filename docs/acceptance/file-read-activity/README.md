# File-read completion activity evidence

R-Q resolves the six B7-done/B7-fail/B7-unknown completion-link exceptions
(three screens, dark and light). Count and completion time come from exact
successful provider file-input receipts, not a model report or Work outcome.
No approved screen contract was changed.

## Local verification

- Node.js 24.21.0, with the canonical scratchpad TMPDIR from CODEX-BRIEF.
- Typecheck passed.
- 212 related tests passed across file-read activity, read telemetry, Work
  telemetry, shell, member Work, GitHub review, team surface, fixture host and
  backup lineage. After adding the fixture assertion, all five activity tests
  passed again; all 43 shell tests also passed after the final display change.
  These runs overlap and their counts must not be added.
- New tests first failed for absent completion projections, absent delivery
  timestamps and absent sidebar links. Coverage includes partial/absent/untimed
  reads, skipped steps, wrong-step and wrong-hash observations, duplicate
  delivery, overlapping receipt commands, clock rollback, injected timestamps,
  event replay, accepted receipt checksums and unknown-owner reconciliation.
- The first expanded run used the machine default Node.js 26.13.0 and failed
  runtime tests; it was stopped. The same named failure and the entire affected
  selection passed under the repository-supported Node.js 24 with its prescribed
  TMPDIR. The supported-environment run is the verification result above.

## Browser checks

Ran the existing contract runner for all three screens in both themes, using
agent-browser with isolated worktree sessions. Compared all six captures with
their approved artboards. The completion link passes in all six snapshots.
Other pane/business/browser differences remain covered by existing exceptions.

The scoped gate uses `readCapture` and `evaluateGate`, with the six corresponding
screen/theme keys and their retained allow-list entries: **0 new, 0 stale,
0 infrastructure errors** ([gate](gate.json), [capture report](report.json)).
The full 75-screen blocking gate belongs to CI; a partial capture cannot satisfy
its complete-coverage requirement.

| State | Dark | Light |
| --- | --- | --- |
| Done | [capture](dark-B7-done.png), [snapshot](dark-B7-done.snapshot.txt) | [capture](light-B7-done.png), [snapshot](light-B7-done.snapshot.txt) |
| Failed | [capture](dark-B7-fail.png), [snapshot](dark-B7-fail.snapshot.txt) | [capture](light-B7-fail.png), [snapshot](light-B7-fail.snapshot.txt) |
| Unknown | [capture](dark-B7-unknown.png), [snapshot](dark-B7-unknown.snapshot.txt) | [capture](light-B7-unknown.png), [snapshot](light-B7-unknown.snapshot.txt) |

In each state/theme, clicked the completion link, observed the original PR #84
Work tab and heading, clicked again, and confirmed one completion link and no
duplicate tab ([interaction assertions](interactions.json)). Its recorded
fixture receipt reports 11 files at 14:08; the prototype's illustrative 10:58 is
not substituted for that observation. The existing Work-status row is separate
from this historical step-completion link.

## Bounds

Fixture-only evidence, with zero real model/provider calls. Existing bounded
GitHub UTF-8 source snapshots remain the source of file identities and hashes.
Legacy untimed receipts intentionally produce no completion activity. Browser
runtime, member undo/attribution, room geometry, payment decisions, release,
deployment and merge are outside this slice.
