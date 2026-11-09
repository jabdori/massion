# E3f blocking gate evidence

Current baseline source: origin/main `dd0c48b7311560e9eb0576e2624b6c605d59de13`,
including [PR #121](https://github.com/jabdori/massion/pull/121),
[CI run 42647827305](https://github.com/jabdori/massion/actions/runs/42647827305),
artifact `13689216372` (`ui-contracts`). Main was merged into this branch without
rewriting published history. No UI, contract, artboard, fixture or threshold is
changed by E3f relative to that main commit.

The complete main capture has 150 rows: 840 contract failures, 18 visual failures,
146 gaps and zero infrastructure errors. Main's report-only CI success is not a
claim that these contracts pass. Current copy lint has zero findings.

## Refreshed exceptions

The previous allow-list had 970 entries. Removal-only regeneration deleted 24
stale entries. The explicitly authorized addition path then admitted 36 exact
current occurrences from [the room ledger](../room-residuals/remaining.json),
with categories, reasons, section links and source references from
[its explanation](../room-residuals/README.md). All 36 matched the new full CI
capture; scoped historical captures were not substituted for it.

The result is 982 exceptions: 818 contract failures, 18 visual failures and 146
gaps. Existing E3b/E3c/E3d1/E3d2/E3e reason provenance is retained for live entries.
The 176 lead-authorized `pending-slice` entries remain: 150 for E5b PR #114,
24 for E7 PR #119 and two for E8 PR #117. Their owning slices must remove entries
resolved when they land; see [the ownership ledger](pending-slices.md).

**The baseline is still red:** [unclassified.json](unclassified.json) contains
22 contract occurrences, all in B7, B7-done, B7-fail and B7-unknown. Twenty are
pane-time requirements now reported as found in the conversation; two are the
second `조사` order occurrence in B7-fail (one per theme). Existing historical
reasons for the first occurrence do not automatically waive a second one. These
exact new identities have no matched occurrence reason and are listed individually
in the PR body. No B22-room/B22-room-steps/B15 diagnostic remains unclassified.

[main-refresh.json](main-refresh.json) records the source, capture totals,
24 removals, 36 additions and final gate result: exit 1, 22 unallowed, zero stale
exceptions and zero infrastructure errors. No reason was invented to pass CI.

## Regeneration

After intentionally resolving items, obtain a fresh complete capture using the
normal runner (its nonzero exit for stale exceptions is expected), then run:

```sh
node scripts/ui-contracts/gate.ts --update
node scripts/ui-contracts/gate.ts
```

The first command only removes exceptions. The second independently checks new,
stale, copy and infrastructure diagnostics. Set `UI_CONTRACTS_OUTPUT` if evidence
is outside `.runtime/ui-contracts`. Incomplete/duplicate screen-theme coverage,
missing checker output, inconsistent counts and infrastructure errors prohibit
an update. Review the list diff before committing; CI never auto-updates it.

This refresh used the explicit addition flag justified by PR #121's published
ledger and the lead's integration request:

```sh
UI_CONTRACTS_OUTPUT=.runtime/ui-contracts-main-dd0c48b node scripts/ui-contracts/gate.ts --update
UI_CONTRACTS_OUTPUT=.runtime/ui-contracts-main-dd0c48b node scripts/ui-contracts/gate.ts --update --allow-additions --reasons docs/acceptance/room-residuals/remaining.json
UI_CONTRACTS_OUTPUT=.runtime/ui-contracts-main-dd0c48b node scripts/ui-contracts/gate.ts
```

Other additions require the same explicit flag, complete current identities,
category, reason and existing ledger file, plus PR justification. Missing reasons
leave diagnostics blocked. The original baseline and pending-slice bootstraps were
separately authorized; this refresh does not widen their ownership scope.

## Validation and limits

After merging main, Node 24.21.0: 135 focused harness/copy tests and TypeScript
static checking pass. The gate was run against the downloaded complete main CI
capture and produced the exact residuals above. Assertion checks verify that the
176 pending-slice entries remain and B22/B15 classification is complete. The full
suite and fresh PR all-screen capture remain CI's responsibility under the owner's
verification budget. No repeated local browser capture or UI review is claimed.

The earlier main branch-protection API returned HTTP 404 (branch not protected).
This change makes the job fail; requiring its status before merge remains an
owner repository setting. No PR merge or deployment is performed by E3f.
