# E3f blocking gate evidence

Baseline source: origin/main `395193e62be6cb53990a6146fef59220156e6137`,
[CI run 42640505441](https://github.com/jabdori/massion/actions/runs/42640505441),
artifact `13685920783` (`ui-contracts`). The complete unchanged main capture has
150 rows: 874 contract failures, 18 visual failures, 146 gaps and zero infrastructure
errors. Current copy lint has zero findings.

The committed allow-list contains 794 occurrences: 662 contract failures, four
visual failures and 128 gaps. Contract/visual reasons match existing E3b, E3c,
E3d1, E3d2 and E3e residual records by screen, theme and normalized diagnostic.
Gap reasons match exact historical report occurrences and link the corresponding
published capability/residual ledger. Historical explanations remain provenance;
they do not reassert old claims that Q13 is still open or that named tasks do not
exist. Current diagnostics, not historical occurrence counts, determine membership.

**The baseline is deliberately red:** [unclassified.json](unclassified.json) lists
244 occurrences with no matching ledger reason (212 contract, 14 visual, 18 gaps).
They have no waiver. The PR body lists each occurrence for owner/lead triage.
E3f does not invent a reason, change UI/fixtures or weaken a contract to pass CI.

Initial generation used the explicit addition path with reason entries matched
to those published ledgers:

```sh
node scripts/ui-contracts/gate.ts --update --allow-additions --reasons <reason-entries.json>
```

The JSON argument is an array of complete allow-list entries (same fields as
`scripts/ui-contracts/allow-list.json` entries). Only current occurrences supplied
with a category, reason and existing ledger file are added; other new diagnostics
remain blocked. This flag's initial justification is bootstrapping existing,
documented debt at the pinned main commit, not permitting new UI regressions.

After intentionally resolving items, obtain a fresh complete capture using the
normal runner (its nonzero exit for stale exceptions is expected), then run:

```sh
node scripts/ui-contracts/gate.ts --update
node scripts/ui-contracts/gate.ts
```

The first command only removes exceptions. The second independently checks new,
stale, copy and infrastructure diagnostics. Set `UI_CONTRACTS_OUTPUT` if evidence
is outside `.runtime/ui-contracts`. Missing/duplicate screen-theme rows, missing
checker output, inconsistent counts and infrastructure errors prohibit an update.
Review the list diff before committing. There is no baseline auto-update in CI.

Local validation on Node 24.21.0: 135 focused harness/copy tests and TypeScript
static checking pass. The real downloaded main capture returns exit 1 with
244 new/unallowed occurrences, zero stale exceptions and zero infrastructure
errors. Full tests and a fresh all-screen capture belong to CI under the owner's
verification budget. No UI, contract, artboard, fixture or threshold was changed.

The `main` branch protection API returned HTTP 404 (branch not protected).
This PR makes the job fail; requiring its status before merge remains a repository
setting for the owner, outside this code change. No merge or deployment is made.
