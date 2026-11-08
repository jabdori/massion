# Prototype screen contracts

A contract is the owner-approved description of one visible screen state, not an implementation snapshot to bless whenever the UI changes. The 51 JSON files in `contracts/` describe required accessible names and roles, their regions and order, forbidden strings, text budgets, a viewport and reference geometry. `required: false` marks example data, not a mandatory sentence. Placeholders such as `{member}` describe variable data. `copy.ko.json` holds approved Korean interface copy; `visual.json` holds design tokens and visual measurements.

The contracts, copy table and visual spec were imported unchanged from the explicitly approved prototype-contracts inputs. Their `source` and `screenshot` fields retain historical provenance, not checkout-relative links. Use `artboards.json` for the actual checked-in PNG paths. No other private research content is included. The supplied checker was moved into `scripts/ui-contracts/contract-check.mjs` without dependencies, with regression-tested corrections for semantic roles, consumed text/order and control-name budgets. Link/button, switch and tab aliases remain explicit.

## Run

Use the repository's Node 24.19 toolchain and installed development dependencies:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm install --global agent-browser@0.41.2
agent-browser install --with-deps
# Also install ImageMagick and Korean fonts (Linux: imagemagick fonts-noto-cjk).
node scripts/ui-contracts/run.mjs
# One or several states while working:
node scripts/ui-contracts/run.mjs B2 B7 B7-unknown
node scripts/check.mjs
```

[agent-browser installation](https://agent-browser.dev/installation) and [isolated sessions](https://agent-browser.dev/sessions) describe the browser setup. The runner never uses a headed browser, an existing profile or a provider. Each screen gets a unique session and loopback port. It serves the real `src/workbench.ts` page with the checked-in JSON responses, navigates using production controls, freezes the fixture clock, waits for readiness, and captures the full accessibility tree. Only the fixture origin is allowed. The host rejects product writes and unknown routes; the read-only app-view POST can return only an exact fixture response; it does not start the production server, a database or a model.

Results go to `.runtime/ui-contracts/` (override with `UI_CONTRACTS_OUTPUT`):

- `report.md` and `report.json`: per-screen counts, setup gaps and infrastructure errors.
- `snapshots/`, `checks/`, `screenshots/`, `visual/`: raw accessibility snapshots, checker output, actual UI PNGs and measured visual failures.
- `pairs/`: ImageMagick montage with prototype on the left and current workbench on the right.

The CI job `ui-contracts` runs all states and uploads these files even if a step fails. It also publishes the count table in the Actions summary. Runs containing contract failures pass initially. **Set the single switch `UI_CONTRACTS_BLOCKING=1`** (the job environment, or a local shell) to fail on contract drift, visual failures or unresolved setup/artboard gaps. Infrastructure failures always fail, including missing Chrome, broken fixture responses and failed captures. Copy lint remains independently report-only.

A required-element match is one pass. Failure counts also include forbidden-string occurrences and hard text-budget breaches, so failures are not `required - passed`. Non-shell text-budget warnings keep the supplied checker's advisory semantics. The runner checks declared colour tokens and visible region rectangles with a two-pixel tolerance; it does not use a global pixel score. Typography, component detail, motion and composition still require reviewing the pairs. OS fonts and font rasterization can differ.

## Change a contract

1. Change the UI only against an owner-approved design change. Do not remove requirements, add arbitrary copy entries or replace the prototype PNG merely to make a failing implementation pass.
2. Update the affected contract, approved copy entries and visual values together. Preserve placeholder meanings, the optional-data distinction and the unknown-outcome/no-resend rules.
3. Add or update the matching `scripts/ui-contracts/fixtures/<artboard>.json`. Every state has its own file. Reuse existing test response shapes where they fit; the `reuse` field records those sources. Provide deterministic local responses, a readiness selector and real click/fill steps. Keep unavailable state interactions in `gaps` until the product can actually render them. Do not inject prototype HTML or call production writes to simulate success.
4. Add the exact approved PNG and its `artboards.json` mapping. Strip metadata and keep it below 200 KiB, resizing only as needed. Preserve the contract's original viewport. Pairs fit images into that viewport without claiming pixel equivalence.
5. Run the affected states, inspect snapshots and pairs, then run all states and `npm run check`. Include the per-screen results in the PR. Contract/checker changes deserve review because they change what the gate accepts.

At import, six exact PNGs were absent from the supplied `final/` directory: B3-run, B19-juno, B22-room-steps, B25, B25-done and B25-later. Their contracts and fixtures are still exercised. `artboards.json` records the missing evidence; no different state is silently substituted, and no pair is claimed for them. The 45 available reference images are below 200 KiB each.

## Copy lint and limits

`scripts/check.mjs` reports visible literal candidates in `src/*panel.ts`, `src/surface-shell.ts` and `src/workbench.ts` that are not in the copy table. It uses the already installed TypeScript parser, scans direct DOM text/attribute writes, `element(tag, text)` calls, HTML-shaped literals and embedded client scripts, and prints file/line locations. It does not rewrite UI strings or fail the check for copy findings.

This is static advisory extraction: hidden markup is included; dynamic data, aliases, lookup tables and indirect helpers may be missed. Approved placeholders are matched by shape, not by runtime value. Region, role and ordering checks belong to the browser checker. Copy lint is not a substitute for running the screen.

The fixture host deliberately cannot execute owner decisions, provider calls, external apps, database writes or persistence/recovery flows. States not reachable through the current read-only UI are reported as gaps. Browser evidence from this harness is fixture evidence, never evidence of a real external effect.
