# R-N: file delivery, procedure notes and Record flow

## Verified

Related local tests: 233 total, 226 passed, seven environment-gated skips,
zero failures. Typecheck, runtime syntax, generated token check and copy lint
passed. Tests use fixtures and credential-free loopback mocks, not real models,
GitHub accounts, browsers performing outside effects, or payments.

The runtime integration reads selected full file bytes, acknowledges a future
step note during another worker's call, preserves admission procedure/plan pins,
passes the effective instruction to the next worker, and accepts an independently
checked Record. Journal replay retains file claims and acknowledgements. Boundary
tests reject wrong paths/hashes, duplicate or malformed file claims, oversized
sources, wrong actors and changes to started steps. Existing overlap, drain,
late-response and feed-replacement tests cover the reused command/read paths.

The headless interaction driver is
`scripts/ui-contracts/verify-read-telemetry.mjs`. In both themes it checks four
read receipts and one pending file delivery, the copyable member acknowledgement,
clicking a note to focus its exact step, wide/mobile layout and deadline expiry
without a feed event. After expiry the pending file is unknown; completed receipts
remain read. The Impeccable mechanical detector reported no findings.

Screen captures were compared with the committed B22 and B8 artboards. The
five-screen/two-theme scoped gate removes 22 resolved occurrences and reports
zero new, stale or infrastructure diagnostics. Existing composer geometry drift
and unrelated scenario residuals remain in the allow-list. Required element
results are 40/40 for B22-room, 49/49 for B22-room-steps and 36/36 for B8-fail,
in both themes. B8-done and B8-unknown retain their unrelated source gaps.

| State | Dark | Light |
| --- | --- | --- |
| Exact PR file delivery and acknowledgement | [PNG](dark-files.png) | [PNG](light-files.png) |
| Applied future step | [PNG](dark-steps.png) | [PNG](light-steps.png) |
| Mobile expanded Work | [PNG](dark-mobile.png) | [PNG](light-mobile.png) |
| Failed check and Record flow | [PNG](dark-failed-flow.png) | [PNG](light-failed-flow.png) |

See [interaction results](interactions.json) and [scoped gate](gate.json).
Full-suite and all-screen results belong to the PR's CI run, not these local counts.

## Remaining

Eight B8-unknown ordered-time occurrences (four per theme) require original
browser/payment activity not produced by that legacy fixture. The Record and
flow headings now exist. An unresolved outcome still has no independent verdict,
accepted Record or invented check/receipt time. R-B owns those outside facts.

GitHub snapshots contain at most 11 small UTF-8 files and 12,000 bytes of serialized
file data within the existing 16 KiB document bound. Binary, removed, unreadable,
oversized and out-of-bound files are omitted and never acquire read badges from
names or diff counts. This is selected-file delivery evidence, not proof of full
PR coverage or a model's comprehension. The app continues to use its existing
one-repository, first-page and sandbox request/time limits. The Contents API is
queried at the original head SHA ([GitHub API documentation](https://docs.github.com/en/rest/repos/contents)).

Procedure changes apply only to the selected Work's not-yet-started steps. Owner
notes on already started/skipped steps remain discussion. Global skills,
dependencies, checking rules, permissions and admission pins do not change.
Legacy Records without a creation observation remain untimed.

No merge, release, real-provider run, browser/payment implementation, token repair,
business-result activity summary or steering/restart continuation was performed.

## Main integration

Merged main after #142 without rebasing. The two import conflicts retain both
credential-repair validation and file/procedure observations. A repaired invocation
cannot acknowledge a new note for its already started step; the proposal stays
discussion. Typecheck and 185 related integration tests passed (182 passed,
three environment-gated skips), including token-repair and member runtime paths.
