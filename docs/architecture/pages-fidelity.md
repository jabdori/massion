# Pages fidelity (E3d2)

The supplied E3d2 brief is the implementation plan. Approved B9, B9-restart,
B9-update, B10, B10-preview, B12, B15, B17, B17-empty and B22 contracts and
artboards in `docs/product/screens` govern both themes. E3a, E3b and the E3c
Work-pane note remain authoritative. No new visual direction is needed.

Baseline and every diagnostic classification are recorded in
`../acceptance/E3d2/baseline-classification.md` before implementation.

Reuse the existing Results, Schedules, Settings memory and app renderers, shell
activity list and their commands. Changes reach their existing client tests,
supported screen fixtures, keyed copy and generated visual tokens. Keep other
settings sections, conversation rendering and the Work pane outside this slice.
Standalone page geometry must not change conversation or other settings layout.

Add only local search/filter/navigation/copy controls supported by existing data.
Results open the exact producing conversation using the same-feed Work binding;
previews keep Record/version/hash identity. Schedules retain cumulative budgets,
unknown outcomes and overlapping-command guards. Memory retains immutable
versions, independent Growth evidence and the exact retirement/revert commands.
App views remain untrusted text and contain no stored secret values.

Repair fixture omissions only for states produced by existing host paths. A
browser session, typed business summary, device updater or unsupported schedule
kind cannot be simulated. Every remaining diagnostic needs explicit producer
evidence in the final residual ledger. A demonstrated checker defect gets a
failing regression before correction; order, occurrence, budgets and fatal
infrastructure behavior remain unchanged.

Run the scoped baseline, focused failing-then-passing regressions, source checks,
typecheck and full test suite. Before every push run the exact CI command across
all 75 contracts in both themes. Inspect and retain all twenty artboard/app pairs,
record before/after counts and residuals, open the requested PR, post the baseline
classification and request `@codex review`. Do not merge.
