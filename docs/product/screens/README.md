# Prototype screen contracts

A contract is the owner-approved description of one visible screen state, not an implementation snapshot to bless whenever the UI changes. The 75 JSON files in `contracts/` describe required accessible names and roles, their regions and order, forbidden strings, text budgets, a viewport and reference geometry. `required: false` marks example data, not a mandatory sentence. Placeholders such as `{member}` describe variable data. `copy.ko.json` holds approved Korean interface copy; `visual.json` holds design tokens and visual measurements.

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

[agent-browser installation](https://agent-browser.dev/installation) and [isolated sessions](https://agent-browser.dev/sessions) describe the browser setup. The runner never uses a headed browser, an existing profile or a provider. Each screen/theme run gets a unique session and loopback port. It serves the real `src/workbench.ts` page with the checked-in JSON responses, navigates using production controls, freezes the fixture clock, waits for readiness, and captures the full accessibility tree. Only the fixture origin is allowed. The host rejects product writes and unknown routes; the read-only app-view POST can return only an exact fixture response; it does not start the production server, a database or a model.

Results go to `.runtime/ui-contracts/` (override with `UI_CONTRACTS_OUTPUT`):

- `report.md` and `report.json`: per-screen/theme counts, setup gaps and infrastructure errors.
- `snapshots/`, `checks/`, `screenshots/`, `visual/`: raw accessibility snapshots, checker output, actual UI PNGs and measured visual failures, each under `dark/` and `light/`.
- `pairs/`: ImageMagick montage with the same-theme prototype on the left and current workbench on the right, under `dark/` and `light/`.

The CI job `ui-contracts` runs all 75 states in both themes (150 runs) and uploads these files even if a step fails. It also publishes the count table in the Actions summary. Runs containing contract failures pass initially. **Set the single switch `UI_CONTRACTS_BLOCKING=1`** (the job environment, or a local shell) to fail on contract drift, visual failures or unresolved setup/artboard gaps. Infrastructure failures always fail, including missing Chrome, broken fixture responses and failed captures. Copy lint independently blocks unkeyed copy in all migrated panels, the shell, the workbench, and the two source-draft UI helpers.

A required-element match is one pass. Failure counts also include forbidden-string occurrences and hard text-budget breaches, so failures are not `required - passed`. Non-shell text-budget warnings keep the supplied checker's advisory semantics. The runner checks declared colour tokens and visible region rectangles with a two-pixel tolerance; it does not use a global pixel score. Typography, component detail, motion and composition still require reviewing the pairs. OS fonts and font rasterization can differ.

Text matching, ordering, forbidden hits and budgets share a [canonical occurrence model](../../architecture/ui-contract-harness.md#canonical-accessibility-text-occurrences). Text is identified by its source tree position, so ancestor aliases collapse while equal sibling labels remain distinct. Standalone placeholders match a complete label or a segment separated by `·`, `•`, `|`, `;` or a newline; spaces inside titles are preserved. Literal/template matches consume whole touched segments, including when a semantic container carries the accessible name. Budgets count each canonical text occurrence, never each distinct string value. Forbidden patterns charge each affected occurrence once, including cross-node matches carried by a container name.

## Change a contract

1. Change the UI only against an owner-approved design change. Do not remove requirements, add arbitrary copy entries or replace the prototype PNG merely to make a failing implementation pass.
2. Update the affected contract, approved copy entries and visual values together. Preserve placeholder meanings, the optional-data distinction and the unknown-outcome/no-resend rules.
3. Add or update the matching `scripts/ui-contracts/fixtures/<artboard>.json`. Every state has its own file. New states may use `extends` with an existing screen name; scalar/array fields replace the parent fields, and `routes` overrides whole responses by exact route key. Parent names are path-validated and cycles are rejected. Reuse existing test response shapes where they fit; the `reuse` field records those sources. Provide deterministic local responses, a readiness selector and real click/fill steps. Keep unavailable state interactions in `gaps` until the product can actually render them. Do not inject prototype HTML or call production writes to simulate success.
4. Add the exact approved PNG and its `artboards.json` mapping. Strip metadata and keep it at most 200,000 bytes, resizing only as needed. Preserve the contract's original viewport. Pairs fit images into that viewport without claiming pixel equivalence.
5. Run the affected states, inspect snapshots and pairs, then run all states and `npm run check`. Include the per-screen results in the PR. Contract/checker changes deserve review because they change what the gate accepts.

## Themes

Contracts share semantic requirements across dark and light, with provenance for
both in `themes`. `visual.json` maps role tokens (for example `--bg-0`) to palette
tokens (`--palette-bg-0`), and supplies the two palettes. The runner resolves the
chosen palette, normalizes expected and actual CSS colors through the browser,
and checks role values and region rectangles. Missing roles still fail.

Every browser command forces `--color-scheme dark` or `--color-scheme light` in
a fresh session. The runner checks the corresponding `matchMedia` result after
navigation and interactions; a failed preference setup is an infrastructure
error. It does not pin a DOM theme, write local storage or inject theme CSS.
This exercises the app through its browser system-preference environment.
The workbench uses the generated `src/ui-tokens.ts` layer and follows the browser
system preference in both themes. Regenerate with `node scripts/generate-ui-tokens.mjs`;
`node scripts/check.mjs` rejects source drift. Geometry and later component work
remain independently visible in this report-only harness.

`artboards.json` maps each screen to `dark.file` and `light.file`, with paths
`artboards/<theme>/<screen>.png`. Every approved screen now has both exact
references: 150 PNGs, each at most 200,000 bytes, with metadata stripped and
resizing only as needed. Contract viewports remain unchanged.

## What changed from v1

- 51 → 75 contracts and 241 approved Korean strings. Approved proposals P1–P20
  and P22 are represented; P21 is deferred. P13 adds no invented source URLs.
- Added first-work/mail-unavailable/calculation states, retained-draft offline
  and failed-send states, general/restart and usage settings, connection
  update/restart/expiry, profile device statuses, post-admission member scenes,
  connector/token-pane/deferred/independently-connected scenes, and budget waiting.
- Both palettes now use role-to-palette indirection. Geometry reflects the
  approved responsive widths, including the 480px conversation minimum beside a
  widened pane. Palette/focus/motion/status/keyboard/composer and navigation
  requirements describe the prototype, not completed production behavior.
- References incorporate the approved visual review (75 artboards: 49 unchanged,
  26 fixed, none awaiting an owner decision). In particular: consistent exception
  rows and settings navigation, white light-theme toggle knobs, centered detail,
  compact result links, briefing separators and neutral budget waiting.
- The six missing v1 references (B3-run, B19-juno, B22-room-steps, B25, B25-done,
  B25-later) now have exact PNGs in both themes. The old single-theme PNGs are
  replaced, not retained as alternate evidence.
- The original 51 fixtures are reused; only 24 small inherited JSON fixtures are
  added. Unsupported production states have explicit gaps. A connected or
  admitted fixture is loaded independently; no successful write, OAuth exchange,
  token storage, notification or budget increase is simulated.
- Reports identify screen **and** theme, and all snapshot/check/screenshot/
  measurement/pair paths include the theme. CI remains report-only; infrastructure
  failures still fail, and the existing blocking switch retains its meaning.

Only the explicitly allowlisted generated contracts, copy, visual JSON and
screenshots were imported from the private source. Extension and visual-review
notes were read as context and are not copied into the repository.

## Visible text and accessible names

The runner preserves raw `.txt` snapshots and writes `.json` snapshots containing
independent rendered-text budget evidence (`visibleTextBudget`). Required names,
roles, ordering and forbidden-copy checks still use the AX tree. Only text
budgets use the measured visible DOM text, matching the artboard extraction;
accessible-only icon names and placeholders are not extra visible copy. Hidden
text is excluded and equal visible siblings are counted separately. Invalid or
incomplete evidence fails closed. Old snapshots keep the AX-based fallback.
See [the harness contract](../../architecture/ui-contract-harness.md#visible-text-budgets-and-accessibility-evidence).

## Copy lint and limits

`scripts/check.mjs` reports visible literal candidates in `src/*panel.ts`, `src/surface-shell.ts`, `src/workbench.ts`,
`src/accepted-result-source-draft.ts` and `src/owner-file-document-draft.ts` that are not in the copy table. It uses the already installed TypeScript parser, scans direct DOM text/attribute writes, `element(tag, text)` calls, HTML-shaped literals and embedded client scripts, and prints file/line locations. Migrated files must use `copy(key, values)` rather than visible literals, including
otherwise approved Korean literals. The check fails for their findings, unknown
static keys, or missing and unknown static placeholder names. The screen runner remains report-only.

This is bounded static extraction: hidden markup is included; dynamic data, aliases, lookup tables and indirect helpers may be missed. Approved placeholders are matched by shape, not by runtime value. Region, role and ordering checks belong to the browser checker. Copy lint is not a substitute for running the screen.

Offline fixtures use agent-browser network emulation and the real offline listener.
The failed-send fixture clicks Send only after disconnection, so no product write
reaches the fixture host, then reconnects before capture to distinguish a failed
message from a disconnected transport. Draft identity and explicit resend are also tested in
the client harness. The fixture host deliberately cannot execute owner decisions, provider calls, external apps, database writes or persistence/recovery flows. States not reachable through the current read-only UI are reported as gaps. Browser evidence from this harness is fixture evidence, never evidence of a real external effect.
