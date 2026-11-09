# Work room step-time and research-order evidence

Separate slice from main `3ffdf51` for PR #118's 22 remaining unclassified
occurrences. The Q13 compact worker-output identity now reads role chip →
producing member, matching the B7-fail result sequence. Participant chips,
procedure order, worker-result text, source guards and expanded flow retain their
existing behavior. No contract, fixture, schema, runtime command or threshold is
changed. The verifier's existing `UI_CONTRACTS_OUTPUT` convention keeps this
evidence separate from historical Q13 captures.

## Unrecorded step times

No per-step timestamp exists in the current producing data:

- [TeamStep](../../../src/internal-teams.ts#L9) has role, title, dependencies and
  optional skip reason. [Plan validation](../../../src/internal-teams.ts#L36)
  admits exactly those fields, so a model-supplied timestamp is not accepted.
- [Task](../../../src/domain.ts#L31) retains identity, parent, status, optional
  result and step. [Delegation](../../../src/domain.ts#L314) creates queued tasks;
  [settlement](../../../src/domain.ts#L317) changes status/result, not a task time.
- [Q13 worker settlement](../../../src/configured-runtime.ts#L263) supplies a task
  ID and result only. The [expanded pane](../../../src/work-room-panel.ts#L84)
  correctly has no recorded time for these worker events.

Work runtime start, Work end and Representative/conversation message times are
different facts. They remain in their existing header/handoff/flow locations;
none is copied into a step row or repeated to satisfy multiple `{time}` slots.
Consequently all 20 original pane-time occurrences remain failures. Persisting
identity-bound per-step start/finish facts would need a separately scoped runtime
change; this UI slice does not invent that data or a write path.

## Legacy research role order

The real Q13 result block previously placed the member before the role. The
[renderer](../../../src/work-room-panel.ts#L70) now places `조사` before `퀼`
for that output, preserving literal text and the member's actual identity.
The existing unit test first failed on `[퀼, 조사]`, then passed on `[조사, 퀼]`.
Both-theme Q13 browser snapshots confirm the order.

The catalog [B7-fail fixture](../../../scripts/ui-contracts/fixtures/B7-fail.json#L626)
still contains legacy root/executor/verifier tasks, with no `Task.step` role or
worker-message sequence. The participant list and outputs are built only from
[actual worker metadata](../../../src/work-room-panel.ts#L59). The Work title's
word `조사` is not a research-worker identity and is not reused as one. Correct
ordering in real Q13 output cannot create the second required legacy `조사`
occurrence or the artboard's five-message research exchange. These two original
occurrences therefore remain explicit residuals rather than a claimed fix.

## Exact residuals

[remaining.json](remaining.json) gives all 22 original identities, each with its
own category, reason, ledger section and code sources. Identity is screen, theme,
kind, normalized diagnostic and duplicate ordinal, never a source line number.

| Screen | Per-theme original residuals | Both themes |
| --- | --- | ---: |
| B7 | One unrecorded pane time | 2 |
| B7-done | Five unrecorded pane times | 10 |
| B7-unknown | Four unrecorded pane times | 8 |
| B7-fail | Second research-role order occurrence without worker metadata | 2 |

No allow-list is changed in this PR. After it merges, PR #118 must merge main,
remove stale entries and use the complete new main CI capture before admitting
these exact ledger-backed residuals. A report-only run is not a passing contract
claim. No time or role occurrence is claimed resolved merely by this ledger.

## Validation

Node 24.21.0, with the repository brief's physical scratchpad `TMPDIR`:

```sh
node --test tests/internal-teams-surface.test.ts tests/work-room-visual.test.ts tests/member-work-surface.test.ts tests/owner-work-sources-panel.test.ts tests/owner-record-artifact-panel.test.ts tests/rejected-text-panel.test.ts
npm run typecheck
UI_CONTRACTS_OUTPUT=docs/acceptance/pane-step-times/after node scripts/ui-contracts/run.mjs B7 B7-done B7-fail B7-unknown
UI_CONTRACTS_OUTPUT=docs/acceptance/pane-step-times/q13 node scripts/ui-contracts/verify-internal-teams.mjs
```

Related tests: 129 total, 121 passed, eight existing DB-environment skips, no
failures. Typecheck passed. An initial run without the prescribed real TMPDIR
hit the artifact-store symlink guard; the correctly configured run passed.
The mechanical design detector reported no findings in the changed UI source.

The eight affected legacy captures before and after are identical: 296/422
required matches, 126 retained contract failures, zero visual failures and zero
infrastructure errors. [Before](before.json), [after](after/report.json),
[checks](after/checks/), [measured snapshots](after/snapshots/).
All 22 original identities are still present and explicitly reasoned.

The real Q13 B7 examples match 50/74 requirements per theme with 24 retained
failures, no hard visible-budget or forbidden-copy failures. B8 is a structural
check, not compared with the printer contract. Three headless flows pass:
participant/role order, literal results after the flat procedure, translated
skip/dependency labels, inspection open/close, width toggle, 390px overflow and
pane close. All send zero product commands.
[Interaction receipt](q13/interactions.json), [verification totals](verification.json).

Inspected the affected legacy prototype/app pairs as a contact sheet, and the
Q13 dark/light desktop and compact mobile captures directly. Review images:
[dark](q13/B7-teams-dark.png), [light](q13/B7-teams-light.png),
[mobile](q13/B8-teams-dark-mobile.png). Full local captures remain under
`.runtime/pane-step-times-after-full` and `.runtime/pane-step-times-q13-full`;
only measured snapshots, checks and representative changed-surface images are
committed to keep this slice small. Historical Q13 evidence was not overwritten.

No full local suite/catalog, real provider, payment, external effect, deployment
or merge was run. CI owns aggregate verification; full prototype parity remains
open where recorded producers are absent.
