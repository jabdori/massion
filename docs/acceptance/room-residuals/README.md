# Room residuals and pane regressions

RoomFix scope: main `395193e`, compared with blocking-contract PR #118
(`6d9007a25345ac390c148182ece197df26fcd214`). Only B7-churn, B8-done, B8-fail,
B15, B22-room and B22-room-steps were captured, in dark and light. These are
fixture results, not browser-work, payment, file-read or real-provider evidence.

The scoped contract run remains **failing**: 162 contract diagnostics and eight
geometry diagnostics remain. No contract, matcher, tolerance, token or blocking
policy was relaxed. B15 geometry was already failing before Q14; it is not
repaired by this PR.

| Screen | Contract failures before / after, per theme | Geometry failures after, per theme |
| --- | ---: | ---: |
| B7-churn | 33 / 30 | 0 |
| B8-done | 13 / 12 | 0 |
| B8-fail | 11 / 10 | 0 |
| B15 | 16 / 16 | 2 |
| B22-room | 13 / 6 | 1 |
| B22-room-steps | 13 / 7 | 1 |

Across twelve rows, required matches increase from 346/540 to 378/540; contract
failures decrease from 198 to 162. Both runs have eight geometry failures and
zero infrastructure errors. Forty-eight diagnostic occurrences disappear and
twelve order-cascade occurrences appear; that is a net reduction of 36, not 48
new product capabilities. [Before](before.json), [after report](after/report.md),
[resolved identities](resolved-diagnostics.json), [added identities](added-diagnostics.json).

## Repairs

- Compact legacy procedures list the child tasks counted by their progress.
  The root Work remains the heading/status rather than a duplicate procedure
  row. This restores the B7-churn `절차` and progress ordering.
- Non-worker execution results remain literal text behind initially closed,
  individually labelled flow disclosures. Their long internal receipts/hashes
  no longer appear as normal expanded-pane copy. The B8 78-character hard
  budget failures disappear; deliberate accepted/rejected readers remain.
- Room participants are named list items, with independent Check last. The
  handoff uses the current exact-revision Work summary's turn when the fixture
  has no assistant-source pin; old pinned-source read guards remain intact.
  The Check stage shows its actual 0/1 or 1/1 separately from worker progress.
- App items link back to their installed app using the existing navigation
  path and generation guard. No app or owner write is added.
- B22 fixtures include the supported sibling Work already represented in B18,
  with matching Mission and global Work rows. The price task is an independent
  active snapshot without its waiting instruction, not a resumed waiting Work
  or an observed execution. B22-room-steps inherits the shared B22-room data.

## File-read telemetry

The five file-status requirements per B22-room theme have no host-owned
producer. [AppView](../../../src/apps.ts:18) provides generic rows, diff metadata
and state strings; [Task](../../../src/domain.ts:31) has no file-read events,
per-member read counts or read timestamps. The real fixture item has two file
diff rows, not eleven observed file reads. Neither a worker's title nor model
text proves that a file was read. No `읽음`/`읽는 중` receipt is invented.

## Ordered step telemetry

The B22 steps screen has real read/test labels, task status, generic worker
progress, Check progress and Record. It lacks the artboard's per-file reading
progress (4/11), per-step times and an active procedure-edit event. The matcher
consumes the later Check 0/1 for the missing read-progress slot, so existing
execution, Record and check-bar text subsequently fails strict ordering. The
remaining ledger identifies these as cascades, not missing Record rendering.
Passing a generic count match is not credited as file-read telemetry.

B7-churn still contains only root/executor/verifier tasks, without named worker
steps. Removing the duplicate root changes one `조사` order occurrence; it does
not manufacture a research role from the Work title. Existing B7 business-team,
room and timestamp gaps remain covered by the earlier E3c ledger.

## Procedure edit

The B22 fixture stores one member reply; the artboard's second reply promises
an edit to an in-flight procedure. [Admission](../../../src/assistant-service.ts:253)
pins procedures, [steering](../../../src/domain.ts:344) puts execution into
waiting, and [task settlement](../../../src/domain.ts:316) refuses waiting Work.
Ordinary member replies are supported, but do not establish an active pinned
procedure edit and continued execution. No second confirming reply/Copy control
is fabricated. This is an unsupported scenario, not absence of a generic reply
or Copy producer.

## Browser pane

B15's fixture explicitly has no browser tab or embedded library form. Its Work
list contains the unrelated churn Work, not a library browser Work, and its
setup opens no pane. The hidden pane leaves main at `[300,44,1140,856]` and the
composer at `[530,808,680,78]`. Both exact mismatches occur in the pre-Q14
[E3c](../e3c/full150.json) and [E3d2](../E3d2/full150.json) B15 rows. The fixture
last changed in `c3468c3`, before Q14. Reserving empty space or opening the
unrelated churn Work would hide the missing browser producer.

## Composer geometry

B22's shared conversation has 24px inline padding in
[the conversation styles](../../../src/assistant-conversation-panel.ts:7);
these two artboards use 20px. The resulting `[324,808,492,78]` versus
`[320,808,500,78]` differences also occur in the pre-Q14 E3c/E3d2 reports.
This is **retained visual drift**, not an unsupported telemetry producer or a
fixed layout. The other scoped pane contracts require the shared 24px padding.
No screen-name CSS exception or global padding change is used to conceal it.

## Residual identities and the incoming blocking gate

[remaining.json](remaining.json) records all current B22 failures, the four B15
geometry occurrences, and the new B7 role-order occurrences with exact screen,
theme, kind, diagnostic and occurrence, plus category, reason, ledger and code
sources. Thirty-six entries include existing visual drift explicitly; they are
not all capability gaps. Other B7/B8/B15 requirements retain their earlier
ledgers and are outside this residual ledger's scope.

The PR #118 gate's actual `readCapture`, `updateAllowList` and `evaluateGate`
functions were run against these twelve rows and the existing allow-list,
without modifying that branch or the production allow-list. After removing
resolved entries and supplying these reasons, all 194 scoped diagnostic/gap
occurrences classify with zero new, stale or infrastructure entries. See
[scoped-gate.json](scoped-gate.json). This checks reason coverage only; it is not
a passing full gate or a passing screen contract. The E3f integrator must refresh
its allow-list from CI's complete capture when these branches meet.

## Verification

Node 24.21.0, with the brief's physical TMPDIR:

```sh
npm run typecheck
node --test tests/work-room-visual.test.ts tests/internal-teams-surface.test.ts tests/apps-surface.test.ts tests/surface-shell.test.ts tests/ui-contract-fixtures.test.ts tests/owner-work-sources-panel.test.ts tests/owner-record-artifact-panel.test.ts tests/rejected-text-panel.test.ts tests/member-work-surface.test.ts
UI_CONTRACTS_OUTPUT=.runtime/room-residuals-final node scripts/ui-contracts/run.mjs B7-churn B8-done B8-fail B15 B22-room B22-room-steps
node scripts/ui-contracts/verify-room-residuals.mjs
```

Typecheck passed. Related tests: 205 total, 197 passed, eight environment-gated
skips, zero failures. New regressions failed before their implementation, then
passed. Existing source-read invalidation, late app reads, independent verdict
binding, Stop and deliberate result-reader checks remain in the batch.

The contract runner is report-only here; its zero process exit does **not** mean
the contracts passed. Exact failures, visible-text budgets, snapshots and region
measurements are retained under [after](after/report.md). Both themes' six
prototype/app PNG pairs were visually inspected, along with expanded result
and mobile evidence. No hard text-budget or palette failure remains in these
captures; the eight geometry failures above remain open.

Twelve headless interaction flows passed at 1440px/390px, with zero product
commands: result disclosure open/close, room/app tab switching, participant and
handoff visibility, pane widening/narrowing/closing and horizontal-overflow
checks. [Interaction receipt](interactions/report.json),
[result disclosure](interactions/B8-done-dark-result.png),
[mobile result](interactions/B8-done-light-mobile-result.png),
[mobile room](interactions/B22-room-steps-dark-mobile.png).
The mechanical design detector returned no findings on the two changed UI files.

Full-suite, full-catalog and blocking-copy checks belong to CI under the brief's
verification budget. No real model, external app action, browser-form submission,
deployment or merge was performed. Full prototype parity remains follow-up.
