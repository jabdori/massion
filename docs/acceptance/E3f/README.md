# E3f blocking gate evidence

Current baseline source: origin/main `e6cd313b16def56dcc596878cadbdcf56876d6e1`,
including [PR #121](https://github.com/jabdori/massion/pull/121),
[PR #119](https://github.com/jabdori/massion/pull/119) and
[PR #122](https://github.com/jabdori/massion/pull/122),
[CI run 42653256831](https://github.com/jabdori/massion/actions/runs/42653256831),
artifact `13690982174` (`ui-contracts`). Main was merged into this branch without
rewriting published history. No UI, contract, checker, artboard, fixture or
threshold is changed by E3f relative to that main commit.

The complete main capture has 150 rows: 826 contract failures, 16 visual failures,
136 gaps and zero infrastructure errors. Main's report-only CI success is not a
claim that these contracts pass. Current copy lint has zero findings.

## Refreshed exceptions

The previous allow-list had 982 entries. Removal-only regeneration deleted 30
stale entries after E7 landed: 24 pending E7 entries and six earlier B1/B21-done
entries. The explicitly authorized addition path admitted 22 exact current
occurrences from [the pane ledger](../pane-step-times/remaining.json), with
categories, reasons, section links and source references from
[its explanation](../pane-step-times/README.md). Twenty concern unrecorded
per-step timestamps; two concern the legacy B7-fail research-role order without
worker metadata. No timestamp or role was invented to satisfy a contract.
All 22 matched the new full CI capture; scoped historical captures were not
substituted for it. PR #121's 36 room-ledger exceptions remain live and unchanged.

The result is 978 exceptions: 826 contract failures, 16 visual failures and 136
gaps. Existing E3b/E3c/E3d1/E3d2/E3e and room reason provenance is retained for
live entries. The remaining 156 lead-authorized `pending-slice` entries are 154
for E5b PR #114 and two for E8 PR #117. No E7 pending entry remains; see
[the ownership ledger](pending-slices.md).

The lead subsequently assigned the four remaining B24-connect-mail identities
(missing header button `더 보기` and conversation `연결` text without the required
button role, once per theme) to E5b PR #114 as `pending-slice`, matching the other
B24 entries. The exact approval and removal obligation are recorded in
[the ownership ledger](pending-slices.md#mail-connection-follow-up), with
[machine-readable reasons](mail-pending.json). This explicit authorization adds
four exact exceptions, not a wildcard waiver or a claim that the UI is repaired.

**The pinned baseline gate passes:** [unclassified.json](unclassified.json) is
empty. [main-refresh.json](main-refresh.json) records source, capture totals,
30 removals, 22 pane-ledger additions, four authorized E5b additions and the
final gate result: exit 0, zero unallowed, zero stale exceptions and zero
infrastructure errors. Screen-contract drift remains represented by exceptions.

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

This refresh used the explicit addition flag justified by PR #122's published
ledger, the lead's integration request and the subsequent explicit E5b approval.
Source commit/run metadata was updated
to the downloaded artifact's provenance after regeneration:

```sh
UI_CONTRACTS_OUTPUT=.runtime/ui-contracts-main-e6cd313 node scripts/ui-contracts/gate.ts --update
UI_CONTRACTS_OUTPUT=.runtime/ui-contracts-main-e6cd313 node scripts/ui-contracts/gate.ts --update --allow-additions --reasons docs/acceptance/pane-step-times/remaining.json
UI_CONTRACTS_OUTPUT=.runtime/ui-contracts-main-e6cd313 node scripts/ui-contracts/gate.ts --update --allow-additions --reasons docs/acceptance/E3f/mail-pending.json
UI_CONTRACTS_OUTPUT=.runtime/ui-contracts-main-e6cd313 node scripts/ui-contracts/gate.ts
```

Other additions require the same explicit flag, complete current identities,
category, reason and existing ledger file, plus PR justification. Missing reasons
leave diagnostics blocked. The original baseline and pending-slice bootstraps were
separately authorized; this refresh does not widen their ownership scope.

## Validation and limits

After merging main, Node 24.21.0: 135 focused harness/copy tests and TypeScript
static checking pass. The gate was run against the downloaded complete main CI
capture and produced the exact residuals above. Assertion checks verify exact
ledger matching, 30 removals, 22 pane additions, four E5b additions, 36 retained room entries,
156 remaining pending entries, zero copy findings and a passing complete capture
gate. The E5b follow-up asserts exactly four additions and no changed or removed
previous exception.
The full suite and fresh PR all-screen capture remain CI's responsibility under
the owner's verification budget. No local browser capture or new screenshot
review is claimed.

This change makes the job fail; requiring its status before merge remains an
owner repository setting. No PR merge or deployment is performed by E3f.
