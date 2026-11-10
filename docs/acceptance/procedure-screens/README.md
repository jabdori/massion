# Procedure screens (R-G)

Removed **90** diagnostic occurrences: B7-churn 32, B7-fail 56, B6 2.
The allow-list shrinks from 428 to 338; no occurrence is added or remapped.
`removed.json` keeps each original identity. `scoped-gate.json` has zero new,
stale or infrastructure diagnostics for the seven captured screens in both themes.

## Product and producer evidence

Both conversation reads and the global Work list project pinned worker labels,
status and progress from the same Work. Worker instruction/result bodies stay out
of that bounded summary. A card has its real roles before a Mission is selected,
and a newer list replaces earlier facts without restoring stale card counts.

Churn scenarios use an owner procedure, validated plan, ready parallel workers,
effect admission/receipts, task settlement and the existing independent verdict.
The failed scenario retains five settled workers, a failed check and no Record.
Pricing retains its procedure, skipped summary and observed worker messages.
These are controlled fixture outputs, not real business or provider evidence.

Worker messages have copy buttons, direction and their recorded host time.
Expanded inspection keeps result text in closed disclosures, uses the real step
name for each worker effect and retains failed-check evidence. Compact messages
are hidden in expanded inspection to avoid showing their text twice.

The generators read inherited source data before dynamic fixture overlays. Four
fixtures regenerated twice produce identical bytes; read-time Growth decisions
are not serialized into the source and duplicated on the next capture.

## Validation

- `npm run typecheck`: passed on Node 24.21.0.
- Related integrated batch: 261 tests, 260 passed, one environment-gated skip,
  zero failures (`member-work`, `member-work-surface`, `internal-teams-surface`,
  `ui-contract-fixtures`, `work-room-visual`, `assistant-conversation`).
- Failing-first assertions observed absent worker summaries/copy controls and
  absent failed-procedure steps. Existing tests also caught ambiguous worker
  effect labels and missing expanded result disclosures before their fixes.
- `UI_CONTRACTS_OUTPUT=.runtime/rg-integrated UI_CONTRACTS_BLOCKING=0 node
  scripts/ui-contracts/run.mjs B7-churn B7-fail B8-fail B18-room-b
  B22-room-steps B6 B6-token`: fourteen captures, no infrastructure errors.
  Compare each prototype/app pair in `pairs/{dark,light}/*.png` with its check
  output in `checks/{dark,light}/*.txt`. `capture.json` retains all residuals.
- Six headless interaction runs: B7-churn, B7-fail and B18-room-b, both themes;
  copied a worker message, opened/closed checking, widened/narrowed inspection,
  opened/closed a result disclosure, checked 1440px and 390px overflow, closed
  the pane. No product command was sent (`interactions.json`).
- Screenshots: `{B7-churn,B7-fail,B18-room-b}-{dark,light}-{compact,expanded,
  mobile,mobile-expanded}.png`; matching accessibility snapshots are
  `{screen}-{theme}.snapshot.txt`. Mobile screenshots retain the scroll position
  reached while exercising disclosures and the checking bar.
- Full suite, durable-store checks and all 75 screen contracts remain CI-owned.

## Remaining

No browser/page counters, payments, steering continuation, typed pricing-table
results or new business oracle is introduced. Actual task text is not a typed
business-result count or a threshold predicate. The following contract gaps stay:

- Activity summaries and compound cards need structured business outcomes/progress.
- Business-specific check-bar captions need the matching pinned criteria/oracle.
- Expanded flow lacks a separate accepted/skipped-Record event.
- Existing B18 pricing-table and B22 app-pane layout residuals remain.
- Steering and memory proposals retain their existing producer and scope limits.

This is a bounded R-G slice. It does not establish complete prototype parity,
real-provider quality, business correctness or production browser/payment support.

## Review correction

Codex identified that the settled-worker check caption could overwrite an unknown
outcome before a Mission was loaded. The caption now uses the existing running
Work predicate, preserving unknown, blocked, cancelled and budget-waiting labels.
The new regression first reproduced the overwrite, then the related surface batch
passed all 124 tests; typecheck passed. No producer, criterion or allowance changed.

## Lead review corrections

The two identical first flow rows were distinct admission and runtime-start
observations. Their host times remain unchanged; their real labels are now
`작업 접수` and `실행 시작`. When only admission is observed, no start row is
inferred from the header's fallback time. One new regression first reproduced
the duplicate labels, then passed both the equal-minute and admission-only cases.
The related integration batch passed all 92 tests and typecheck passed.

The CLI `node scripts/ui-contracts/regenerate-work-telemetry.ts` now owns only
`B7-churn`, `B7-fail`, `B18-room-b` and `B22-room-steps`. It no longer regenerates
B5 or printer/payment B7 variants, nor scans unrelated artifact readers. Running
the committed command twice produced identical bytes and left all 71 unowned
fixtures unchanged. The one changed owned fixture, B7-churn, now retains main's
typed pricing output from its existing producer.

Merged main without rebasing, retaining main's table parser, predicate observation
times, member attribution and diagnostic removals. The current baseline is
398 entries on main and 308 on this branch: the original 90 removals survive.
Two existing B7-churn pricing-card residuals change from missing-card to
card-order diagnostics because the typed card now exists. `lead-remapped.json`
records the old/new identities; the inherited request history is preserved.
No extra occurrence is allowed. `lead-scoped-gate.json` has zero new, stale or
infrastructure failures for eight screens in both themes; outputs are in
`lead-checks/` and `lead-capture.json`.

Headless flow interactions passed in both themes at 1440px and 390px. The updated
`B7-fail-{dark,light}-{expanded,mobile-expanded}.png` screenshots show the two
distinct labels together, with matching `B7-fail-{theme}-flow.snapshot.txt` and
`lead-flow-interactions.json`. Main's typed-table verifier now also asserts actual
visibility in compact, expanded and mobile views, rather than only reading hidden
DOM cells. It first caught a merge regression hiding the expanded table; the
merged styles preserve visible tables and keep ordinary compact messages hidden.
Both table interaction runs pass.

The optional `확인 실패 / 아님` copy polish is deferred because `아님` is pinned
by the existing B8-fail contract; changing that vocabulary is outside these fixes.
