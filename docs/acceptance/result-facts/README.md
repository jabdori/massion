# R-M: typed business-result facts

The Work-list and conversation reads now project explicit `massion-facts/v1`
observations and validated table counts before a Work pane is opened. Churn,
pricing and cause/evidence counts are bounded and never parsed from prose.
Worker observations do not accept Work. Final assembly retains its original
JSON bytes as both the immutable artifact and the executor result; a separate
checker still checks those bytes.

The original R-M scope is in [the design note](../../architecture/result-facts.md).
No new command, persistence field, backup shape or dependency was needed.
Result renderers retain exact Copy/Original bytes and show counts as inert text.
Checking-seat task text cannot override producer observations.

## Verification

- Node 24.21.0: 142 related tests passed, zero failures or skips. This includes
  explicit red/green regressions for malformed worker/assembly counts, missing
  list projections, checking-seat contamination and the card's accessible status.
- Runtime tests retain immutable checking bytes and validate a real application
  journal. Task-command tests reject invalid facts, overlap identical settlements
  and retain one original result without manufacturing acceptance.
- Client tests cover newer list replacement, late responses, feed replacement,
  exception priority and rendering before any Mission/pane read. Existing drain,
  deadline and thread-selection regressions remain in the related test batch.
- `npm run typecheck`, `node scripts/check.mjs` and copy lint passed.
- [Scoped capture](report.json): 20 affected screens in both themes. The final
  printer captures also verify that the invisible status stays inside its card's
  containing block and does not shift the composer. Browser screenshots/checks
  retain observed output; gap metadata is refreshed from the final fixture
  producer because it is source metadata rather than rendered content.
- [Scoped diagnostic gate](scoped-gate.json): no new/stale/infrastructure
  diagnostics after removing **28** resolved occurrences. [Remappings](remapped.json)
  preserve ten pricing-label order diagnostics and sixteen corrected fixture-gap
  identities. The total allow-list shrinks from **264 to 236**.
- `node scripts/ui-contracts/verify-result-facts.mjs`: B9, B7-done and B7-fail in
  dark/light, 1440px/390px, pane open/widen/narrow/close, retained failed check and
  no horizontal overflow. [Interaction report](interactions/interactions.json)
  records zero product commands. Screenshots are
  `interactions/{B9,B7-done,B7-fail}-{dark,light}-{compact,expanded,mobile}.png`;
  matching `.snapshot.txt` files retain names and roles.
- The procedure generator was run from source. Its four generated fixtures keep
  synchronized list projections. Read-time producers extend legacy B2/B3/B5,
  B7-done/B8/activity and member screens using actual procedure, assigned effect,
  receipt and settlement commands. Failed checks retain no accepted Record.

All business inputs are controlled fixtures. No real providers, customer data,
market research, browser purchases or deployment were exercised. CI owns the
full test suite and all 75 screen contracts; final-head receipts are on the PR.

## Remaining

- The prototype's five printer step clocks in B7-done depend on browser/payment
  observations owned by PR #127. The printer is a Representative-authored Work
  without a named member procedure pin; existing team admission requires
  `assistantSource.memberId`. Assigning it a fabricated member or copying churn
  timestamps would change provenance. Its background churn/pricing Works now
  have actual procedures; the printer clocks remain explicitly unsupported.
- Page-read counts and order-history evidence also belong to PR #127. Typed
  business-result counts cannot establish that a page was read or a payment
  succeeded. File-read counts/completion belong to the parallel read-telemetry
  slice. Their allow-list reasons are narrowed accordingly.
- Cause/evidence counts (one/two in the fixture) are displayed beside the actual
  failed check. The retained criterion/verdict does not establish the prototype's
  threshold of three grounds. A producer count cannot invent that checking rule.
- Pricing labels now exist in the activity list and conversation. Ten diagnostic
  occurrences concern their existing order rather than missing facts. Unrelated
  layout, connection, memory, procedure-edit, Record-event and steering/restart
  residuals remain with their owners.

No merge, release or deployment is part of this delivery.

Additional runtime/conversation/telemetry regression batch: 79 tests, 76 passed,
three existing environment-gated skips, zero failures. This batch does not overlap
the 142-test batch above. The skips are disposable real-SurrealDB tests; no live
provider or existing database was used.

## Review corrections

Codex identified that generic table rows could be mislabeled as pricing plans.
The red/green regression now retains their generic table count with no business
facts. Only an explicit, validated `business:"pricing"` table discriminator or
an explicit facts envelope supplies pricing meaning. Controlled pricing producers
were updated at source and their fixtures regenerated.

The first CI suite also caught two older visual-test assumptions: structured
facts render semantically inside the existing disclosure, and authoritative list
facts remain usable when an unrelated pane revision changes. The updated tests
still require closed disclosures and reject stale pane fallbacks. Accepted
results retain their counts while unknown/stopped status takes priority.

The review-fix batch passed 124 tests with no failures/skips; it overlaps earlier
batches and is not an additional aggregate count. Typecheck passed. Final-head
full-suite and screen evidence is reported by CI on the PR.

## Main integration

Merged `origin/main` at `486b422` (credential repair, PR #142) without rebase or
force-push. The conversation slot retains both newer result facts and the typed
credential exception. The allow-list identity union preserves all removals from
both branches: current main has 262 entries; this branch has 234 (the same 28 R-M
removals). B6-token was recaptured in both themes against its current production
credential fixture and the combined scoped gate remains clean.

The merged result/credential/conversation/fixture batch passed 187 tests, zero
failures/skips; typecheck passed. The final pricing table discriminator was also
checked through both themes' real headless table interactions, including exact
Copy/Original data, expansion and mobile visibility.
