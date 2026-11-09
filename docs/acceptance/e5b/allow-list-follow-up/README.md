# Resolved B24/B25 exceptions removed in this PR

After integrating main's blocking gate (#118, `ac99f1d`), this PR removes the
154 resolved B24/B25 entries from the actual
`scripts/ui-contracts/allow-list.json`. The removal therefore lands atomically
with #114. The earlier prepared patch is superseded and has been removed.

Fresh [22 screen/theme captures](../p2-contracts/report.md) match 542/542 required
elements with zero contract, visual, infrastructure or transition-gap failures.
Both B24-connect-mail captures contain the header More button and native
conversation Connect button. Read-only fixture loading is documented as test
scope, while the production connection transitions are checked separately.

The removal covers 140 contract occurrences, four visual occurrences and ten
obsolete gap annotations. At the removal checkpoint, the 824 other entries and
original source metadata were preserved exactly. `resolved.json` retains the
precise identities and original #118 head used during preparation.

The unchanged production gate exports are used by
`../check-scoped-gate.mjs`: fixed coverage of all 22 E5b captures, checker-count
validation, affected-source copy diagnostics, and both new/stale exception
checks. Before removal it failed on 154 stale entries with zero new diagnostics;
after removal it passes with zero new/stale/infrastructure diagnostics. No
exception was added, no justify/additions flag was used, and no contract or
threshold was relaxed. Full-repository gate evaluation remains CI work.

[Removal evidence](../p2-contracts/scoped-gate-removal.json) ·
[Final scoped gate](../p2-contracts/scoped-gate.json).

The separate data-driven Work/PR-table/total-count residuals remain in the
[product residual ledger](../residual-ledger.md); required-role success does not
manufacture absent producers.
