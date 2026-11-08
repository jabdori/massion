# UI contract harness

## Intent and scope

Make the owner-approved 51 prototype states reviewable and machine-checkable without changing production UI. Contracts specify accessible names, roles, regions, ordering, forbidden copy and text budgets. The Korean copy table and visual specification remain the approved source; screenshots are review evidence, not a pixel acceptance oracle.

## Design

Keep only the explicitly approved JSON inputs and artboards under `docs/product/screens`. Serve the real `workbenchPage` from a loopback-only fixture host with one JSON fixture per contract state and deterministic local endpoint responses. Navigate using real controls; missing controls or unsupported states are reported, never replaced by prototype markup. No production store, provider or external service is invoked. Unknown routes fail closed. The app-view POST is a read-only protocol and may return only an exact, bounded fixture response; all product writes are rejected.

A dependency-free checker consumes accessibility snapshots. The runner starts an isolated headless agent-browser session per state, captures snapshots and screenshots, creates ImageMagick side-by-side pairs, and writes JSON and Markdown reports. Contract failures are report-only initially; `UI_CONTRACTS_BLOCKING=1` enables the gate. Infrastructure failures remain visible and fail the run. Visual dimensions/tokens are checked where measurable; typography and composition still need pair review.

Copy lint scans the requested panel/shell/workbench sources and reports visible literals outside the approved Korean table. It is advisory and does not rewrite source. Dynamic data and static extraction limits must be documented.

## Implementation and verification plan

1. Import the allowlisted contracts, copy and visual JSON; optimize approved PNGs below 200 KiB. Record missing exact artboards explicitly rather than substituting another state silently.
2. Add failing tests for fixture coverage, loopback routing/mutation rejection, checker failures and gate behavior; implement fixture host and runner. Existing read-only test fixtures are reused where applicable.
3. Add independently tested report-only copy lint to `scripts/check.mjs` without touching UI files.
4. Add a pinned agent-browser CI job, browser/font/ImageMagick installation and artifact upload even after failures.
5. Run all states, inspect representative pairs, run typecheck, syntax/copy lint and existing tests. Include all per-screen counts and limitations in the PR.

Owner-command races, ownerStore draining, stale client writes and generation tokens are unchanged: this harness supplies read-only isolated fixtures, and admits no product writes. Existing product tests continue to cover those paths.

## Shared accessibility text occurrences

Accessible names can repeat the text of descendant nodes. Text requirements must consume a shared occurrence across those representations, not one occurrence per flattened node. Map matching descendant text spans into their ancestor's name/description in tree order; keep unmatched ancestor text and separate sibling occurrences independent. Apply the same consumption rule to direct and joined-text matches while preserving semantic control matching. Regression cases cover nested/partial aliases, repeated sibling text and joined labels.
