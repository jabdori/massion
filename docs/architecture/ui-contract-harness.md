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

## Canonical accessibility text occurrences

All four checks use one occurrence model, built before matching:

| Rule | Meaning |
| --- | --- |
| Identity | A text occurrence is identified by its source tree path and label field/range, never by string value. Equal sibling labels remain separate. |
| Aliases | A container name that repeats descendant text is a view of those descendant occurrences. Use non-overlapping label spans, preferring longer labels when they overlap. Canonical child order survives even when the container name reorders its aliases. Unmatched text in a name-only control or semantic text element remains a fallback occurrence. Structural landmark names create no extra rendered text. |
| Segments | An occurrence may contain segments delimited by `·`, `•`, `|`, `;` or a newline. Whitespace inside a title is not a delimiter. Segments retain the source occurrence identity for budgets and forbidden checks. |
| Required matching | Standalone placeholders match a whole label/segment. Literal/template matches may occur inside a larger label, but consume whole touched segments. Joined labels use adjacent text occurrences without a fixed node-count cap. A view match must be fully backed by occurrence spans (apart from separators); unrepresented landmark/description text cannot supply a match. Roles are carried by semantic views; a single control/heading cannot satisfy two structural requirements. |
| Order | Every match advances through the canonical occurrence/segment order. An ancestor alias cannot move a descendant occurrence earlier. No consumed segment can satisfy another requirement. |
| Forbidden copy | Scan canonical labels and fully represented semantic views, including overlapping matches, charging each affected occurrence once per pattern. Ancestor aliases add no hit; identical siblings do. |
| Budgets | Count every canonical occurrence once: characters, strings, sentences and longest label. Never deduplicate by string value. Existing hard/advisory regions and numeric tolerances remain unchanged. |

The accessibility snapshot is the evidence boundary: name-only controls are a text fallback, not a claim about pixels. Explicit text children take precedence over aggregate accessible names. Descriptions can alias existing text; they do not manufacture rendered text when no text occurrence represents them.

Table-driven regression cases cover the standalone-title and repeated-sentence reproductions, sibling identity, nested/partial aliases, semantic and joined labels, separator consumption, order, and forbidden-hit multiplicity. Recheck the same 51 stored snapshots before/after so count changes reflect checker semantics rather than new browser captures.
