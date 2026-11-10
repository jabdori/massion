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
