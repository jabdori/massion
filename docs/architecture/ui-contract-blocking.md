# Blocking screen and copy diagnostics (E3f)

Use the complete 150-row CI capture from origin/main as baseline evidence. Keep
the contracts, checker, thresholds, fixtures and UI unchanged. An exception is
one occurrence, identified by screen, theme, kind, normalized diagnostic and an
ordinal among identical diagnostics. Copy identity uses file, context, reason
and text, never source line/column. Infrastructure failures cannot be waived.

Store exceptions in `scripts/ui-contracts/allow-list.json`, each with category,
reason and a repository residual-ledger link. Historical candidates are evidence
to match against current diagnostics, not a baseline to copy wholesale. Current
diagnostics without an existing reason remain unallowed and are listed in the PR.
The lead also authorized `pending-slice` for specific existing occurrences owned
by open E5b, E7 and E8 slices. Their exact screen scope, PR references and removal
obligation are recorded in [the ownership ledger](../acceptance/E3f/pending-slices.md).

The gate checks complete screen/theme coverage, checker counts and infrastructure
errors, then compares occurrences in both directions. New diagnostics and stale
exceptions fail. Copy lint includes advisory findings as well as keyed findings.
Keep the existing scoped copy-lint API for its callers; CI runs the full copy gate.
The runner writes evidence before gating; reports/artifacts publish on failure.

`node scripts/ui-contracts/gate.ts --update` removes resolved exceptions only.
`--allow-additions` additionally admits new diagnostics only when an explicit
reason entry is supplied in `--reasons <json>`; justify additions in the PR.
Never regenerate from incomplete or infrastructure-failed captures.

Implementation and verification:

1. Add failing gate tests for allowed/new/stale/infra occurrences, multiplicity,
   copy location stability, missing capture evidence and removal-only updates.
2. Implement the shared gate and update CLI; wire the blocking runner and CI.
3. Generate the committed baseline from the pinned main CI capture, matching
   existing residual ledgers. Record unclassified diagnostics without waivers.
4. Run focused harness/copy tests and typecheck locally. CI owns full captures
   and the full suite per the owner's verification budget. Commit, push and
   create the requested PR; request @codex review, never merge.
