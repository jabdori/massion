# E3e evidence

> **Historical evidence:** The forty captures and Q13-open statements below describe
> `b8f1f20`. Main 1d0d1e3 (including Q13 and the secret launcher) is now integrated. See
> [the current blocking visual-gate ledger](residuals.md#main-integration-and-blocking-visual-gate-2026-11-09)
> and [main-integration/](main-integration/) for this round; old counts are not
> current-merge acceptance claims.

The requested remaining conversation states and supported polish are implemented
above current main without new commands, dependencies, providers or owner grants.
This is a reviewable UI slice, **not full visual/workflow fidelity**. Open Q13
(#113), absent host producers and deferred composition remain explicit.

The baseline has 1,042 / 1,292 required matches and 250 contract diagnostics.
The final candidate has **1,014 / 1,292**, **278 contract diagnostics**, **four
geometry diagnostics**, and **zero infrastructure errors** across twenty states
in both themes. Required matches decrease because unsupported payment/remote
approvals and the automatic greeting were removed from fixtures; the baseline
was overclaiming supported outcomes. See the exact per-state differences below.

Production changes: member Work cards project from the existing same-feed,
source-bound Representative turn before opening a pane; retry remains draft-only
and Close reuses the same durable command boundary. Stale feeds discard the
projection. Cards/panes share child-task counts; failed rows show real bound
verdict evidence; wide check rows show 맞음/아님; the pane glyph changes to neutral
collapse while expanded. Native checks retain all actually available flow times.

## Validation

Node 24.21.0, physical TMPDIR, existing installed dependencies:

```sh
TMPDIR=/private/tmp/massion-e3e-tests node --test tests/work-room-visual.test.ts tests/conversation-cards.test.ts tests/ui-contract-fixtures.test.ts tests/members-surface.test.ts tests/member-work-surface.test.ts tests/surface-shell.test.ts tests/conversation-work-panel.test.ts tests/conversation-visual-gate.test.ts tests/ui-copy.test.ts tests/ui-copy-lint.test.ts
npm run typecheck
node scripts/ui-contracts/copy-lint.mjs
```

226 tests passed, four existing tests skipped, zero failed. Typecheck passed;
copy lint and the design detector each found zero issues. New regressions were
observed failing before their implementations. The copied-dependency/symlink
and TMPDIR environment issues were corrected without modifying test boundaries.

`node scripts/ui-contracts/verify-work-pane.mjs`: twenty both-theme desktop/mobile
browser checks passed. Check-bar toggling, source data, current verdict/evidence,
shared counts, actual flow times, neutral glyphs, expansion, 390px overflow,
keyboard focus and no product commands are recorded in
[work-pane-interactions.json](work-pane-interactions.json). A separate headless
B21 walk checked empty-name disabling, name/shape preview, Cancel, Escape and
reopen reset in both themes with zero product commands:
[member-interactions.json](member-interactions.json).

The unchanged scoped contract command was run before and after:

```sh
UI_CONTRACTS_BLOCKING=0 node scripts/ui-contracts/run.mjs B3 B3-run B4 B6 B6-token B16 B16-sent B16-later B18-room-b B21 B21-name B21-done B21-done-hana B26 B26-later B7 B7-fail B8 B8-done B8-fail
```

Changed fixture-ready selectors and the member/date/shape corrections were
recaptured using the same runner for the affected states. `after.json` combines
the final forty rows and their matching snapshots/checks/pairs. Initial selector
errors were not suppressed or allow-listed; each was corrected and recaptured.
The full suite and all 75 contracts are left to CI under the owner's verification
budget. No real provider, external delegation, payment, credentials or deployment
were exercised. No merge is authorized.

## Per-state evidence

Artboard left, actual app right. Every pair was inspected in both-theme contact
sheets; failure evidence, expanded verdicts and member admission were also viewed
at full pair size. Some approved business workflows remain visibly absent, as
listed in [capabilities.md](capabilities.md).

| State | Required matches, before → after (both themes) | Contract failures, before → after | Dark pair | Light pair |
| --- | ---: | ---: | --- | --- |
| B3 | 44 → 44 / 44 | 0 → 0 | [PNG](pairs/dark/B3.png) | [PNG](pairs/light/B3.png) |
| B3-run | 44 → 44 / 46 | 2 → 2 | [PNG](pairs/dark/B3-run.png) | [PNG](pairs/light/B3-run.png) |
| B4 | 60 → 56 / 70 | 10 → 14 | [PNG](pairs/dark/B4.png) | [PNG](pairs/light/B4.png) |
| B6 | 60 → 58 / 68 | 8 → 10 | [PNG](pairs/dark/B6.png) | [PNG](pairs/light/B6.png) |
| B6-token | 56 → 48 / 56 | 0 → 8 | [PNG](pairs/dark/B6-token.png) | [PNG](pairs/light/B6-token.png) |
| B16 | 44 → 34 / 44 | 0 → 10 | [PNG](pairs/dark/B16.png) | [PNG](pairs/light/B16.png) |
| B16-sent | 38 → 36 / 42 | 4 → 6 | [PNG](pairs/dark/B16-sent.png) | [PNG](pairs/light/B16-sent.png) |
| B16-later | 40 → 36 / 42 | 2 → 6 | [PNG](pairs/dark/B16-later.png) | [PNG](pairs/light/B16-later.png) |
| B18-room-b | 58 → 66 / 138 | 80 → 72 | [PNG](pairs/dark/B18-room-b.png) | [PNG](pairs/light/B18-room-b.png) |
| B21 | 42 → 42 / 42 | 0 → 0 | [PNG](pairs/dark/B21.png) | [PNG](pairs/light/B21.png) |
| B21-name | 66 → 66 / 66 | 0 → 0 | [PNG](pairs/dark/B21-name.png) | [PNG](pairs/light/B21-name.png) |
| B21-done | 40 → 38 / 40 | 0 → 2 | [PNG](pairs/dark/B21-done.png) | [PNG](pairs/light/B21-done.png) |
| B21-done-hana | 42 → 42 / 44 | 2 → 2 | [PNG](pairs/dark/B21-done-hana.png) | [PNG](pairs/light/B21-done-hana.png) |
| B26 | 54 → 50 / 54 | 0 → 4 | [PNG](pairs/dark/B26.png) | [PNG](pairs/light/B26.png) |
| B26-later | 52 → 52 / 54 | 2 → 2 | [PNG](pairs/dark/B26-later.png) | [PNG](pairs/light/B26-later.png) |
| B7 | 78 → 78 / 80 | 2 → 2 | [PNG](pairs/dark/B7.png) | [PNG](pairs/light/B7.png) |
| B7-fail | 78 → 78 / 156 | 78 → 78 | [PNG](pairs/dark/B7-fail.png) | [PNG](pairs/light/B7-fail.png) |
| B8 | 46 → 46 / 62 | 16 → 16 | [PNG](pairs/dark/B8.png) | [PNG](pairs/light/B8.png) |
| B8-done | 48 → 48 / 72 | 24 → 24 | [PNG](pairs/dark/B8-done.png) | [PNG](pairs/light/B8-done.png) |
| B8-fail | 52 → 52 / 72 | 20 → 20 | [PNG](pairs/dark/B8-fail.png) | [PNG](pairs/light/B8-fail.png) |

## Blocking gates and remaining work

[residuals.md](residuals.md) records every still-failed occurrence with code evidence.
[allow-list-candidates.json](allow-list-candidates.json) has 278 contract and four
geometry candidates, none applied; repeated amounts/order occurrences and both
themes remain distinct. The lead must decide those exceptions before enabling
blocking contracts. The B6-token ancillary state mismatch and B18-room-b geometry
are explicit fixture/composition debt. Copy lint needs no exception.

The Q13 dependency, skipped-step/role work, typed events/tables, unsupported owner
decisions and admission undo remain open. B1*, B24/B25, desktop, secret launcher,
core/runtime schemas, permissions and provider setup were not changed. Detailed
validation and resolved environment/capture errors are in
[verification.json](verification.json). The lead owns the single independent
review; no second worker review was requested.
