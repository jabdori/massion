# E3b conversation completion evidence

PR 106 above E3a (`1595710`), completed against the same 22 scoped states in
both browser system themes. Screen verification uses isolated **headless
agent-browser** only. Contracts, artboards, visual tokens and thresholds remain
unchanged. The approved missing copy was added with artboard evidence.

## Result

| Measurement across 44 captures | E3a baseline | Initial PR (`829ab57`) | Updated PR |
| --- | ---: | ---: | ---: |
| Required elements matched | 504 | 764 | 1,012 / 1,060 |
| Contract failures | 596 | 370 | **54** |
| Geometry/palette failures | 42 | 0 | **0** |
| Infrastructure errors | 0 | 0 | **0** |

The remaining **12 diagnostics belong to the later B7 Work-pane layout** and
**42 require a missing producing product capability**. Each occurrence has a
reason and code evidence in [remaining.json](remaining.json) and the readable
[residual ledger](after-failures.md). There are no retained UI-code, fixture-gap
or checker exemptions. This does not claim that unavailable product scenes have
been implemented or that E3 as a whole is complete.

The initial [370-occurrence triage](triage-initial.json) was posted
[before the fixes](https://github.com/jabdori/massion/pull/106#issuecomment-6727883256).
It assigns one primary cause per occurrence: missing element 90, wrong copy 44,
wrong order 60, extra text 44, unsupported product state 34, fixture gap 64,
checker limitation 34. Further tracing identified missing post-decision reply
producers and the payment-to-Work decision binding; those are explicitly
explained in the final residual ledger rather than represented by fake UI data.

[Initial PR report](initial-pr.json) · [final report](after.json) ·
[final geometry/palette measurements](after-visual.json) ·
[all final raw and structured snapshots](final-snapshots/) ·
[capture sources](capture-sources.json).

## What changed

- One accessible composer label, approved first-screen prompt, `맨 아래로`,
  interrupted-answer copy, and the missing B11 draft-copy control. Copy remains
  keyed; new entries carry B2/B11/B21 artboard provenance.
- Correct member/Work state names and busy marks, retained waiting/failed/recent
  completed Work, header sidebar-name updates and workspace access, explicit
  priority control, and local unread state acknowledged only by explicit opens.
- Card heading order matches the reference: state, assignee and elapsed time
  before role chips and summary. A member's own card omits redundant identity;
  elapsed time remains visible while awaiting a check, without introducing
  waiting-state polling. Failed Work keeps its inspection card; recovery actions
  follow the latest reply. Verdict evidence counts come from stored verdicts.
- Recorded steering is a timed, read-only link to its exact stored Work. A late
  global Work-list response now activates that link without another conversation
  read, including for completed Work with no polling timer.
- Completed member admissions link to the stored member ID. The actual host
  proposal/row/completion copy uses the approved Korean table, not only the
  screenshot fixtures. The admission command and replay/drain rules are unchanged.
- Supported fixture gaps were repaired using existing prepared domain Work,
  accepted Record bytes and read routes. No product writes were enabled. The
  fixtures now navigate the member/activity views through real controls, preserve
  recorded message/turn order, expose installed app rows and carry real assigned
  stage/evidence projections. Inherited fixtures were compacted with all 75
  resolved states checked for equivalence.

## Checks

- Node 24.21.0, existing dependencies, and the brief's physical macOS `TMPDIR`.
- `npm run typecheck`: passed.
- `node scripts/check.mjs`: passed; copy lint zero findings; generated tokens current.
- `npm test`: **1,536 passed, 340 skipped, one known local failure**:
  `portable inventory order is stable across English and Turkish process locales`
  (`Text artifact boundary: directory realpath mismatch`). No inventory code changed.
- Existing overlapping-command, drain-aware ownerStore, feed/deadline refresh,
  cached-thread and stale-generation guards remain covered. Unknown outcomes
  are never resent. Read-only links, member selection and draft copying issue no
  owner commands. Independent review's delayed-Work-link finding was reproduced
  with a failing test and fixed in the shared read path.
- Both-theme real-browser assertions: 200px editor cap with 770px scroll height,
  shrink to 22px, 680px column, 20px radius and token 2px focus ring; mention
  arrows/Escape/Enter, source-draft retention, sidebar search, menu/focus return,
  unread jump and 800px workspace reopening. [Measurements](interactions.json).
- Live budget negative checks in both themes count two equal visible helper
  paragraphs twice and hidden paragraphs zero. Approved accessible-only prompt
  text does not become an extra visible paragraph. [Proof](visible-budget-checks.json).
- Mechanical design detector: no findings on the panel/shell. `git diff --check`: passed.
- No real provider, database, remote delegation, payment, order query, attachment
  upload, release or deployment was exercised. No merge. Two existing failed-pane fixtures received selector-only repairs after the shared
  failed-card markup changed; [headless smoke results](pane-fixture-smoke.json)
  show zero infrastructure errors in both themes. Their B7/pane contract and
  geometry drift remains outside this slice. Other 51 artboard states were not
  recaptured; all 75 fixture data/inheritance checks were run.

## Measurement integrity

Thirty-four initial failures were demonstrated checker defects. Rechecking the
**same old 44 snapshots** changes 370 to 336, with no new failures: 26 noun
`필요` sentence false positives, six listbox/child-heading consumption errors and
two compound-status errors. Regression tests preserve real option order,
control reuse limits, status delimiters and explanatory-copy detection.

The prototype budgets count rendered DOM text. The runner now records actual
visible text separately from required accessible names. **AX names, roles, order
and forbidden-copy checks remain independent and mandatory**, and no budget
threshold changed. Invalid/incomplete visible-text evidence fails closed.
[Harness contract](../../architecture/ui-contract-harness.md#visible-text-budgets-and-accessibility-evidence).
For transparency, the final candidate's old AX-budget fallback is also retained:
[78 diagnostics](final-ax-fallback.json), versus **54** using rendered-text
budget evidence. The reduction from 370 includes UI fixes, supported fixture
repairs and these verified measurement corrections; it is not a pure pixel score.

## Reproduce

```sh
UI_CONTRACTS_OUTPUT=.runtime/e3b-delivery node scripts/ui-contracts/run.mjs B1 B2 B2-offline B2-offline-failed B3 B3-run B4 B5 B6 B6-token B11 B11-quill B16 B16-later B16-sent B18 B21 B21-name B21-done B21-done-hana B26 B26-later
```

The final B4 close-name correction and three gap-note updates were captured in
`.runtime/e3b-delivery-rerun`. Those eight real capture rows replace their earlier
rows; [capture-sources.json](capture-sources.json) records this composition. The
rest of the candidate's rendered states are unchanged. Original E3a baseline,
initial PR and final evidence are all preserved.

## Requested pairs

Reference left, implementation right. All eight final pairs were inspected.

| Screen | Dark final | Light final | Initial PR dark | Initial PR light |
| --- | --- | --- | --- | --- |
| B2 | [PNG](pairs/after/dark/B2.png) | [PNG](pairs/after/light/B2.png) | [PNG](pairs/initial-pr/dark/B2.png) | [PNG](pairs/initial-pr/light/B2.png) |
| B5 | [PNG](pairs/after/dark/B5.png) | [PNG](pairs/after/light/B5.png) | [PNG](pairs/initial-pr/dark/B5.png) | [PNG](pairs/initial-pr/light/B5.png) |
| B11 | [PNG](pairs/after/dark/B11.png) | [PNG](pairs/after/light/B11.png) | [PNG](pairs/initial-pr/dark/B11.png) | [PNG](pairs/initial-pr/light/B11.png) |
| B18 | [PNG](pairs/after/dark/B18.png) | [PNG](pairs/after/light/B18.png) | [PNG](pairs/initial-pr/dark/B18.png) | [PNG](pairs/initial-pr/light/B18.png) |

## Per-screen results

`matched / failures`; dark and light are independent captures. Geometry/palette
and infrastructure failures are zero in every row.

| State | Initial dark | Final dark | Initial light | Final light |
| --- | ---: | ---: | ---: | ---: |
| B1 | 9 / 3 | 11 / 0 | 9 / 3 | 11 / 0 |
| B2 | 24 / 9 | 29 / 2 | 24 / 9 | 29 / 2 |
| B2-offline | 17 / 4 | 20 / 0 | 17 / 4 | 20 / 0 |
| B2-offline-failed | 18 / 5 | 22 / 0 | 18 / 5 | 22 / 0 |
| B3 | 19 / 4 | 22 / 0 | 19 / 4 | 22 / 0 |
| B3-run | 19 / 5 | 22 / 1 | 19 / 5 | 22 / 1 |
| B4 | 21 / 19 | 30 / 8 | 21 / 19 | 30 / 8 |
| B5 | 11 / 7 | 14 / 3 | 11 / 7 | 14 / 3 |
| B6 | 17 / 19 | 30 / 4 | 17 / 19 | 30 / 4 |
| B6-token | 17 / 13 | 28 / 0 | 17 / 13 | 28 / 0 |
| B11 | 17 / 7 | 22 / 0 | 17 / 7 | 22 / 0 |
| B11-quill | 16 / 4 | 17 / 0 | 16 / 4 | 17 / 0 |
| B16 | 18 / 5 | 22 / 0 | 18 / 5 | 22 / 0 |
| B16-later | 17 / 5 | 20 / 1 | 17 / 5 | 20 / 1 |
| B16-sent | 16 / 6 | 19 / 2 | 16 / 6 | 19 / 2 |
| B18 | 19 / 17 | 30 / 4 | 19 / 17 | 30 / 4 |
| B21 | 18 / 5 | 21 / 0 | 18 / 5 | 21 / 0 |
| B21-name | 22 / 13 | 33 / 0 | 22 / 13 | 33 / 0 |
| B21-done | 17 / 4 | 20 / 0 | 17 / 4 | 20 / 0 |
| B21-done-hana | 18 / 5 | 21 / 1 | 18 / 5 | 21 / 1 |
| B26 | 17 / 12 | 27 / 0 | 17 / 12 | 27 / 0 |
| B26-later | 15 / 14 | 26 / 1 | 15 / 14 | 26 / 1 |

## Remaining groups

Each group applies in both themes; the full ledger keeps repeated amount slots
as distinct occurrences. Existing generic Growth, memory and quarantine tools
are not presented as identity-bound rule/payment/candidate flows they do not
produce. File-add remains disabled because message attachment transport is absent.

| State | Count | Allowed boundary | Reason |
| --- | ---: | --- | --- |
| B2 | 2 | unsupported product capability | A check-rule-change case inspector and its decision-to-case identity are not produced by /assistant/conversation. Generic Growth scores exist, but are not this rule-change case view. |
| B2 | 2 | unsupported product capability | The durable task/assignment model has executor/verifier stages, not the named investigation/classification/summary/table team roles and table-result metadata in this composite label. Actual assignee, state, elapsed time, assigned stage counts and verdict evidence are rendered; the missing roles/result summary are not invented. |
| B3-run | 2 | unsupported product capability | The durable task/assignment model has executor/verifier stages, not the named investigation/classification/summary/table team roles and table-result metadata in this composite label. Actual assignee, state, elapsed time, assigned stage counts and verdict evidence are rendered; the missing roles/result summary are not invented. |
| B4 | 2 | unsupported product capability | The host decision router supports member/apps/skills decisions, not an identity-bound in-progress payment approval attached to this Work. Generic waiting is shown truthfully; no payment gate binding is inferred from a title. |
| B4 | 2 | unsupported product capability | There is no producing browser-work runtime/page-read telemetry for a completed browser attempt. A stored end time and page count cannot be inferred from a still-waiting or unknown text-effect Work. |
| B4 | 12 | later B7 pane | The existing Work pane is the legacy execution/evidence view. Payment amount slots and its compact layout/copy belong to B7; no conversation/header/sidebar redesign can supply that pane layout. |
| B5 | 2 | unsupported product capability | There is no producing browser-work runtime/page-read telemetry for a completed browser attempt. A stored end time and page count cannot be inferred from a still-waiting or unknown text-effect Work. |
| B5 | 2 | unsupported product capability | No order-history connector/read route or original payment/order identity exists for this unknown payment. The existing read-back Check action remains; no order-inspection success is fabricated. |
| B5 | 2 | unsupported product capability | The immediate unknown-payment closure flow has no original payment/runtime binding. Existing expired-run/quarantine handling requires an original run ID, reason and explicit uncertainty acknowledgement; this fixture has no runtime identity. A plain cancel must not hide or settle an unknown payment. |
| B6 | 4 | unsupported product capability | The durable task/assignment model has executor/verifier stages, not the named investigation/classification/summary/table team roles and table-result metadata in this composite label. Actual assignee, state, elapsed time, assigned stage counts and verdict evidence are rendered; the missing roles/result summary are not invented. |
| B6 | 4 | unsupported product capability | The member-turn response schema emits reply/work/steer, not an identity-bound memory candidate. Existing explicit memory/Growth commands do not produce the candidate ID/version behind these save/discard buttons. No candidate is inferred from reply text. |
| B16-later | 2 | unsupported product capability | The approved scene has a new Representative acknowledgement after the defer/delegation decision. The current decision operation updates decision state only and produces no subsequent conversation message. Existing replies retain their true earlier order; a new reply is not fabricated. |
| B16-sent | 2 | unsupported product capability | Approval alone is not a sent external-agent request. The host has no owned laptop/Claude Code delegation dispatch/read-back in this slice, so it cannot truthfully emit the requested sent-at/awaiting-reply activity record. |
| B16-sent | 2 | unsupported product capability | The approved scene has a new Representative acknowledgement after the defer/delegation decision. The current decision operation updates decision state only and produces no subsequent conversation message. Existing replies retain their true earlier order; a new reply is not fabricated. |
| B18 | 4 | unsupported product capability | The durable task/assignment model has executor/verifier stages, not the named investigation/classification/summary/table team roles and table-result metadata in this composite label. Actual assignee, state, elapsed time, assigned stage counts and verdict evidence are rendered; the missing roles/result summary are not invented. |
| B18 | 4 | unsupported product capability | The member-turn response schema emits reply/work/steer, not an identity-bound memory candidate. Existing explicit memory/Growth commands do not produce the candidate ID/version behind these save/discard buttons. No candidate is inferred from reply text. |
| B21-done-hana | 2 | unsupported product capability | MembersCommand has no admission undo/remove operation. The completed admission now exposes and opens the exact stored member ID, but no unsupported undo action is enabled. |
| B26-later | 2 | unsupported product capability | Budget-waiting/deferred-budget decisions and a matching reopen command are not produced by the host. Reopening a member or rounding decision would not implement this budget action. |
