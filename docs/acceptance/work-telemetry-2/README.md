# R-H: typed tables and check observation times

This PR delivers a bounded table producer and per-predicate host observation
times. Remaining producer families are explicitly deferred below, as permitted
by CODEX-BRIEF's smallest-complete-slice rule. It does not claim all of R-H done.

## Table results

The typed envelope is stored as exact immutable text bytes. Task settlement and
independently accepted artifacts retain their existing identities and journal
paths. A worker table is pending until independent checking succeeds. Rendering
never extracts prices from prose or evaluates cell contents. Original/Copy keep
the original bytes. Controlled fixture prices are not live market evidence.

## Check observations

Application telemetry version 2 records a predicate's `checkedAt` at the same
host observation as its verification report. Version 1 journals keep their old
shape. Neither a provider nor a caller may supply the time. These observations
do not imply separate model calls or independently timed subchecks.

## Residuals

- `dependency`: B3-run and B6 require compound conversation cards with specific
  research/summary roles and business progress. The current renderer already
  uses exact pinned TeamStep dependencies in Work detail; these legacy fixtures
  have no corresponding command-produced named plan. They need a scenario
  producer, not a dependency renderer or inferred roles from task strings.
- `unrecorded step timestamp`: B7-done expects five named business step clocks.
  `admit-effect` and `settle-task` already record actual start/end times; this
  fixture has only executor/verifier tasks and no corresponding business plan.
  R-G owns B7 scenario composition. Work/message times cannot fill those slots.
- `check-time-and-predicates`: B8-unknown has an unresolved external outcome.
  It has no independent verdict, payment/browser read receipts or timed business
  steps. The remaining occurrences concern duplicate Record headings and the
  ordered business flow. Adding a checked verdict would falsely resolve the
  unknown outcome; a report observation cannot establish missing activity times.
- `unsupported file-read telemetry`: GitHub's item handler fetches file names
  and diff counts. `github-review/v1` pins repository/PR/head identity only.
  The bounded text worker has no file-reading tool, patch delivery receipt or
  per-file read event. A future actual host file-read path must produce these
  marks; app listing, task progress and elapsed time cannot stand in for reads.
- `unsupported active procedure-edit scenario`: the owner note records a
  proposed procedure change, not adoption. Procedures are pinned at admission;
  this slice adds no in-flight plan mutation or member acknowledgement producer.
  R-F owns steering continuation; R-G owns business procedure scenarios.
- `Typed table preview / fixed example budget`: B10-preview's original accepted
  text exceeds the prototype pane budget. A typed-table capability alone does
  not justify replacing or truncating an existing accepted result. Keep its
  allowance until a genuine accepted table scenario fits the approved surface.
- `pricing-table-and-memory-proposal`: only the table producer belongs here.
  R-D's memory-candidate scenario is separate and must retain its own allowance.

## Verification

Before edits, eight scoped screens were captured in both themes with
`UI_CONTRACTS_BLOCKING=0 node scripts/ui-contracts/run.mjs B18-room-b B10-preview
B7-done B8-unknown B22-room B22-room-steps B3-run B6`. `baseline.json` records exact
pre-change diagnostics. Final capture and allow-list removal counts follow below.

Tests are credential-free fixtures and loopback mocks. Full checks, actual
SurrealDB aggregate checks and the complete screen catalog run in CI. The known
macOS-only `portable inventory order is stable across English and Turkish process
locales` failure is retained in the local report; it is not a product regression
introduced by these changes.

Table semantics follow [MDN's HTML table guidance](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/table):
column headers carry explicit scope, cell data stays in text nodes.

Final scoped gate: zero new diagnostics, stale allowances or infrastructure
errors across the eight screens in both themes. Removed **16** monthly-table
occurrences (count, plan and six amounts per theme). Four existing occurrences
were narrowed/remapped, not newly waived: the table card now exists but is out
of the business-message sequence (R-G), and the combined table/memory gap now
names only R-D's memory scenario. Other residual allowances stay in place.

Integrated local batch: **213 tests, 210 passed, 3 actual-DB skips, no failures**;
typecheck passed. A separate backup batch retained the documented local Turkish
locale test failure. The table tests cover malformed/oversized envelopes, inert
HTML-looking cells, exact Original/Copy, late responses, unchanged artifact
bytes through independent checking, malformed worker outputs and no resend.
Check tests cover host times, concurrent command replay, forged times, legacy
v1 replay and journal tampering.

`node scripts/ui-contracts/verify-table-results.mjs` passed both themes: all 24
literal cells and scoped column headers, expanded view, 390px mobile without
horizontal overflow, Close and input focus. Screenshots are in `table/`:
`dark-compact.png`, `dark-expanded.png`, `dark-mobile.png` and matching `light-*`;
`dark-pair.png` and `light-pair.png` compare the artboard with the branch.
The original conversation ordering and shifted fixture times are visible in the
pairs and remain outside this slice. Prices are controlled examples, not URLs
or market observations. The existing B10-preview plain text and its budget
allowance were preserved.

After merging main's skipped-step glyph/time correction (#136), the affected
40-test batch and typecheck passed. B18 contracts and table interaction PNGs were
recaptured on the merged implementation; the scoped gate still has no new,
stale or infrastructure diagnostics. The two additional B7-churn allowances from
main are retained. Relative to that main, this PR removes 16 entries (428 -> 412).
