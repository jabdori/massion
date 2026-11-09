# Settings fidelity (E3d1)

Match B13, B13-devices, B13-general, B13-general-restart, B14,
B14-expired, B14-restart, B14-update, B14-usage, B19, B19-juno,
B20, B20-coding, B23, B23-github and B23-github-expired in both
system themes. The execution brief and approved artboards are the design.
Use `copy.ko.json` and generated `visual.json` tokens. Preserve the existing
conversation, Work pane and E3d2 pages.

1. Save the unmodified 32-state baseline and classify each diagnostic before
   editing. Post the classification on the PR. Keep infrastructure failures fatal.
2. Extend the existing Settings client tests first for local section search,
   model-group navigation/editing, overlapping submissions, unknown outcomes
   and stale reads. Reuse existing `/model-groups` CAS writes and request scopes;
   do not add commands or change server admission. A lost response is never
   automatically sent again. Default/checking routes remain outside group edits.
3. Correct Settings-only geometry, typography, copy and supported reads. Repair
   fixtures only from actual host shapes. Show unavailable data as unknown;
   absent host commands remain capability residuals, including controls that
   cannot safely be offered. Keep connection setup available under Advanced,
   without its explanatory paragraphs on the approved Connections surface.
4. Correct only the Settings functions in `apps-panel.ts`; preserve app pages,
   rail behavior and Work tabs. Never display or round-trip secret values.
5. Run focused tests, typecheck, `scripts/check.mjs`, aggregate tests and the
   complete CI runner (75 contracts, both themes) before every push. Inspect
   all 32 artboard/app pairs. Retain a per-diagnostic residual ledger with code
   evidence under `docs/acceptance/E3d1/`.
6. Push `feat/fidelity-settings`, open the English PR to main, publish the
   classification and `@codex review`, and leave it unmerged.

Change reach: `settings-panel.ts`, the existing Settings markup in
`workbench.ts`, Settings-only app functions/styles, their client tests,
supported screen fixtures, additive copy and visual measurements plus generated
tokens. No dependency, provider call, credential write or new host API is needed.

The existing `/model-groups` endpoint accepts exact fields and a configuration
hash, not a command ID. Preserve that API's CAS conflict fence and single-send
client behavior rather than inventing an idempotency field the host rejects.
Fixture captures are not evidence of real provider or connection outcomes.

Theme reference: [MDN prefers-color-scheme](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-color-scheme).

## PR 109 review corrections

Synchronize the existing replacement-feed background Work read in the owner-relations test; retain its exact request-count, private-draft/CAS, journal and no-POST assertions. A lost group save stays readonly until a later current-scoped catalog read adopts host values, without resending. Apply owner visual feedback A1–A8 with measured tokens and preserve unavailable A9 states as evidenced residuals. B23’s two heading strings follow the owner-approved count spacing; roles, ordering, occurrence and budgets remain unchanged. Run the CI durable-store command against actual SurrealDB 3.3.0 and recapture all 75 contracts × both themes before pushing.
