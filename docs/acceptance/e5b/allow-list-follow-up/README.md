# Remove resolved B24/B25 blocking-gate exceptions after #114 lands

PR #118 (`ci/blocking-contracts`) is still open; its allow-list file is not in
main or this branch. The attached patch is prepared against its observed head
`85b7b2a064735b4ffd810b2327bb333ecf9690d9`. It must be applied in the gate branch
when #114 has landed, before accepting the resulting blocking gate. It has not
been applied prematurely to another open PR.

The current [22 screen/theme captures](../p2-contracts/report.md) have 542/542
required matches, no contract/visual/infrastructure failures, and no unsupported
transition gaps. Both B24-connect-mail captures specifically include the header
More button and a native conversation Connect button. Connection transitions are
also exercised separately; reading a connected/deferred fixture is not itself a
missing product capability, so those old fixture-gap annotations were removed.

`remove-resolved.patch` removes exactly **154** existing B24/B25 allowances:
140 contract occurrences, four visual occurrences and ten obsolete gap entries.
All **824 other entries** and the original source metadata are unchanged.
`resolved.json` lists the precise diagnostic identities. The patch was applied
to a temporary copy and its resulting JSON compared with the expected deletion.
No contract, threshold, or unrelated exception is changed.

After #114 merges, merge main into #118 (no rebase/force-push), apply this patch,
and run the blocking gate on fresh capture evidence. If #118's list has changed,
regenerate only these resolved removals against that evidence; do not delete new
unresolved diagnostics merely because their screen starts with B24/B25. The gate
rejects stale resolved entries as well as new failures, so leaving these entries
behind is not acceptable.

The separate data-driven Work/PR-table/total-count residuals remain documented
in [the product residual ledger](../residual-ledger.md); passing required-role
contracts does not turn those absent producers into completed functionality.
