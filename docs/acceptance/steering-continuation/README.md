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
