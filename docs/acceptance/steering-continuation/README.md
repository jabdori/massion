# R-F steering continuation evidence

The owner-confirmed enterprise direction now reaches continued active/settled
Work through real commands. `steering-fixture.ts` supplies data-only model text,
uses AssistantConversation/AssistantService for confirmation, and produces Work
steps, effects, telemetry and failed-result reads through the application boundary.
The first exchange and confirmation are produced in chronological order.
It reuses the existing fixture's source pointers; full portable-journal evidence
comes from the runtime tests, which also produce the original admissions.

The scoped gate removes 20 occurrences: all 14 requested steering occurrences,
plus six time/worker-role occurrences supplied by the new producer. Two existing
B7-fail Record-row gaps remain, re-keyed from missing to out-of-order because the
team renderer supplies that row before the requested later pane sequence. No new
capability allowance is added. Other business/telemetry/layout gaps remain.

## Checks

- Five screens (B6, B7-churn, B7-fail, B8-fail, B18-room-b), dark and light.
- `node scripts/ui-contracts/verify-steering.mjs`: four headless flows open the
  exact Work from its confirmed direction link, inspect telemetry, widen/collapse,
  open independent check details, and inspect 390px layout without horizontal
  overflow. [Interaction assertions](interactions.json).
- [Active dark](B7-churn-dark.png), [active mobile](B7-churn-dark-mobile.png),
  [failed light](B7-fail-light.png), [failed mobile](B7-fail-light-mobile.png).
- Local capture reports/snapshots: `.runtime/rf-ui-publish/`; reproducible driver
  `scripts/ui-contracts/run.mjs` with the five screen arguments above.
- Compare with `docs/product/screens` contracts and rendered prototype artboards.
  This proves the requested steering flow, not full artboard parity. In
  particular the legacy failed fixture now has an explicit research step;
  reference layouts and business-specific message sequences remain incomplete.

Runtime tests prove changed instructions in remaining workers/assembly/check,
no duplicate calls, confirmation and progression races, retained deadlines and
budgets, journal replay, legacy behavior and restart without reclaim. Both
initial-state and Mission reads are asserted to contain identical produced Work.
Existing legacy-child UI assertions explicitly retain their original fixture;
team procedure/check behavior is exercised by the produced fixtures and browser.

## Review correction

A steer racing a worker receipt originally stranded the completed outcome.
Three tests first reproduced failure at receipt, task settlement and progress.
Definite CAS revision refusals now retry only journal progression (including team
registration), bounded to three attempts. Provider calls and ambiguous writes
are never retried. Cancellation before invocation is tested at the store commit
boundary rather than a private runtime helper.

CI's unknown/drain journey observed the durable unknown card before the previous
send response had finished. Its next send now waits for the actual enabled Send
control. This changes only the test driver's readiness predicate.

No live models, paid providers or production storage were used locally. CI owns
the full suite and durable-database/E2E checks; head-specific results remain on
PR #137. No merge or release is authorized here.

The second review also reproduced a steer racing the worker dispatch claim.
A definite revision refusal now retries that same claim with the original effect,
request hash and ownership, bounded to three attempts. Invocation still requires
a fresh committed response. Lost and replayed claim acknowledgments each have a
regression proving zero worker calls and no restart reclaim. The affected
claim/steering/lifetime batch passed 42 tests with six environment-gated skips;
the two ambiguous-acknowledgment regressions passed separately.

## Main integration after lead approval

Merge `bb07ab4` (PR #140 typed tables/telemetry v2, with PR #138 already in the
ancestry) without rewriting history. Retain final/worker table validation and
predicate host observation times alongside the steering input binding and
continuation rules. The existing end-to-end steering regression now produces a
typed table, asserts its exact artifact bytes and predicate times, and replays
the combined journal.

The allow-list combines both branches' deletions: base 428, steering 408, main
412, integrated 392. Ten screen/theme captures have zero new, stale or
infrastructure diagnostics: [scoped gate](main140-gate.json). The pricing table
and confirmed steering coexist in the [B18 comparison](B18-main140-pair.png).
Four steering browser flows and both table interaction flows passed. Typecheck
and the related batch passed: 197 tests, three actual-DB skips, no failures.
Full checks and current-head Codex review remain recorded on PR #137.
