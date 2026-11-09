# Browser runtime (R-B)

## Blocking visual correction

B15/B4 now display the adapter's sanitized PNG, not a reconstruction from text or readonly app inputs. The browser pane has one tab strip, a domain-only address pill and the captured page. B15 shows the observed three pages; B4 retains its single contract browser tab. The duplicate Work/browser header row, visible metadata dump and start/count lines under the address are gone. The contract's known actor appears as a small corner marker; no cursor or action coordinates are invented.

B4's decision seller is `오피스몰 · shop.example.com`. B7 adds the recorded chat activity line `작업 중 · 페이지 N개 읽음` and separates its time, count and browser control. R-A-owned named steps are unchanged.

## Verification

- Node 24.21.0, canonical private TMPDIR: 231 related core, lineage, screenshot, UI, effect and fixture tests passed. Typecheck and copy lint passed; the design detector returned no findings. CI owns the full suite and all 150 screen/theme contracts.
- The final local B15/B4/B7 capture covers both themes, with zero new contract, geometry or infrastructure failures. B4 passes 35/35 required elements; B15 34/35 and B7 39/40. The existing residuals below remain. [Targeted gate](visual-gate.json), [report](report.md).
- `node scripts/ui-contracts/verify-browser.mjs`: 12 states across themes and desktop/mobile, including actual 584×764 PNGs, domain-only pills, keyboard page tabs, authoritative tab reselection, readonly image content, zero product commands, no horizontal overflow, and B7 chat/row spacing.
- Screenshots: [B15 dark](screenshots/dark/B15.png), [B15 light](screenshots/light/B15.png), [B4 dark](screenshots/dark/B4.png), [B4 light](screenshots/light/B4.png), [B7 dark](screenshots/dark/B7.png). Prototype/app pairs are under `pairs/`; interactions and mobile images are under `interactions/`.

## Security correction

Every form value is masked by default. Only explicit benign meanings may expose values; payment/security/code markers in the label, name or autocomplete override them. Korean `보안 코드`, English `Security code`, `name=csc` and `autocomplete=cc-csc` are tested in the sanitizer and committed Work/journal path. Passwords, hidden inputs and other authentication fields stay masked.

The production capture routine scrubs the DOM and reflected private values before the only screenshot operation. The harmless page-script sentinel must not execute. Two sets of distinct per-field private values, absent from the URL, produce identical masked PNG bytes, while the benign quantity remains visible: [report](redaction-report.json), [masked image](redaction.png). No unmasked screenshot is written. PNG type, dimensions, canonical base64, per-image size and cumulative session size are validated.

The original Blink launch flag stalled screenshots in a minimal local reproduction. A retained CDP session now disables page scripts before navigation while allowing image capture. It accepts only the isolated loopback debugger with a fresh blank page, closes any browser-created new-tab page, and remains held until cleanup. The DOM also receives a restrictive CSP before capture.

## Provenance

`node scripts/ui-contracts/capture-browser-pages.mjs` serves the local reference HTML/CSS under `scripts/ui-contracts/browser-pages/`, then invokes the same `captureBrowserPage` routine used by the opt-in adapter. Generated PNGs and observed metadata are hash-bound to those sources. The fixture's local documents map to declared example-domain identities; no example domain was contacted. No prototype HTML is injected into the workbench.

The Work producer uses the existing Application CAS/idempotency boundary, drain-aware store and journal replay. Earlier reviews added regressions for one-time-code fields, late-response supersession at commit admission, current deadline checks and target-Mission tab/revision binding. The original scope removed 52 obsolete diagnostic identities and replaced two combined B7 gaps with narrower descriptions: net 50 fewer exceptions. This visual correction adds no exceptions and relaxes no screen contract.

## Remaining contracts and limits

- B5 order-history inspection still needs its connector and exact remote order identity. Unknown payment is never retried.
- B15's generic library decision lacks a typed form-submission effect binding to the Work; the sidebar does not claim decision-pending. The image grants no submission authority.
- B7's named order-history/business steps and their timestamps remain R-A's scope. Browser timestamps do not replace them.
- Tests use fixtures and loopback-only browsers. No third-party browsing, live models, payment or submission occurred. Authenticated profiles, interactive filling and autonomous browser planning remain out of scope. The PR is not merged by this task.

## Visual-review correction 1

Codex reproduced a split-text reflection leak and early browser-drain completion on `9f36270`. Private matching now spans DOM text nodes, including visible text separated by hidden nodes or whitespace, while replacing only the affected text ranges. Metadata uses rendered text. The actual PNG invariant passes for the expanded fixture: different private codes still produce identical masked pixels. CI now runs this production screenshot/redaction check before its screen-contract capture.

The browser service separately tracks adapter settlement, so cancellation of the caller-facing read cannot finish host drain before the adapter's async `finally`. Tests cover successful cleanup and bounded timeout reporting as unsettled. All 30 affected tests and typecheck pass; the four reference page PNGs remain unchanged. The six CI jobs on the previous head passed; final-head CI is required again after this correction.

The split-node regression also covers CSS `visibility:hidden` separators and `display:contents` wrappers. The visibility pass handles those cases, and a final rendered-text check refuses capture if a recognized private value remains. The expanded real-browser test passed with distinct per-field values and no private query parameters; the four reference screenshots stayed byte-identical.

## Integration with PR #117

Merged the monthly-budget mainline without dropping either slice's Work fields, command/backup validation, conversation notices or drain tasks. The allow-list merge preserves the union of both slices' removals. A new test pauses/resumes a Work with a retained browser observation and validates its complete journal. All 216 related browser, budget, effect, lineage and UI tests passed, followed by the focused runtime-actor version of the new test and typecheck. Twelve browser/budget screen-theme captures add no failures: [scoped merge gate](monthly-merge-gate.json). PR #132's MCP E2E correction remains included.

## E2E target binding after integration

The MCP journey failed twice on `49b541a`, with a blank screenshot and evaluation origin `about:blank`, rather than a workbench application error. Agent-browser 0.41.2's unpinned mode follows discovered page targets. A local loopback reproduction created a background blank target: the unpinned session switched away, while pinning after browser launch retained the owned page ([result](e2e-tab-binding.json)). Passing the pin only at launch did not retain the page in the reproduction.

The E2E setup now explicitly resets its own session pin while launching the viewport, then pins the existing browser before driving the workbench. It does not retry any owner command or relax an assertion. The existing MCP journey remains the regression gate in Linux CI; its Electron portion is not launched visibly on macOS. PR #132's context-error handling remains intact. The report also stops describing the now-merged monthly-budget feature as unmerged; that separate owner journey is still outside this E2E suite.

## Integration with PR #129

Merged R-A's Work telemetry, named-step presentation, observed counts/times, step notes and worker messages without substituting browser facts for them. Browser session fields and validation coexist with admission timestamps. The browser activity row and chat page count remain additional observations. The B7 fixture's combined old gap now states only its actually missing pinned business procedure; duplicate pre-merge gap descriptions are removed, not turned into new capabilities.

All 254 related browser, budget, effect, telemetry, room and lineage tests passed, as did typecheck. Twelve scoped screen/theme captures (browser panes, B7, R-A room variants and budget) have no new/stale/infrastructure diagnostics: [merged gate](telemetry-merge-gate.json). The E2E post-launch tab pin remains included. Final integrated CI and head-specific review remain required.

## Generated-content privacy and E2E isolation

The latest security review found attribute-backed CSS generated content. The capture now scrubs arbitrary attributes, removes event handlers/refresh navigation, suppresses `::before`, `::after` and `::marker` content in an early important cascade layer, and refuses capture when suppression fails. A retained CDP document check rejects author Shadow DOM (including closed roots) before any screenshot and checks the same document again after redaction. The fixture includes `content:attr(code)!important`; its private-value PNG invariance passes, and the closed-shadow fixture is refused before the screenshot command.

The remaining MCP E2E blank-page failure was isolated to agent-browser 0.41.2's renderer-injected domain controls and opaque sandbox frames. Its failure path closes the browser, so same-command retry can continue on a fresh blank page. A minimal fixture using the production app-frame and document-host code fails with those controls, but works with a deny-only local HTTP proxy. E2E now uses that proxy with only exact `127.0.0.1` bypass, rejects HTTP/CONNECT/upgraded traffic to other hosts, retains the non-proxied-UDP WebRTC restriction, and uses a fresh owned session. Product CSP/sandbox tests and all owner-command assertions remain unchanged. [Local proxy/frame proof](e2e-proxy-verification.json); unit tests exercise all three denial paths. The production browser adapter retains its original domain restriction.

## Final mainline integration

Merged main through PR #128 (growth/memory), #133 (monthly-budget E2E) and #134 (release preparation), retaining #117/#129/#132. The browser producers compose with the growth/memory fixture producers; both sets of services, controls, copy and backup validation remain. The new budget E2E journey is preserved and its former gap is cleared. The deny-only browser egress proxy remains around the complete E2E suite.

All 206 related browser, privacy, memory, growth, effect, lineage, fixture and UI tests passed; typecheck passed. Twelve affected screen/theme captures have no new/stale/infrastructure diagnostics: [growth/release merge gate](growth-release-merge-gate.json). The source version is the mainline release candidate; this task performs no tag, release publication or PR merge.

## Uninspectable visual sources and PR #135

The latest security finding demonstrated a private code encoded in an SVG data URL. Captures now neutralize image/picture/SVG paint while retaining their boxes; remove CSS background, border, mask and list images plus uninspectable filters/clipping; and use trusted system font families. Computed styles are checked before capture. The actual PNG test includes encoded data-URL pixels in image, SVG and CSS-background sources; independent private values still produce identical sanitized bytes. The source-page layout and ordinary text remain, while uninspectable graphics (including the reference printer glyph) are intentionally omitted.

PR #135's production first-resize fix is merged. Related tests: 91 passed plus typecheck; all 12 browser interaction states pass. The final six browser screen/theme captures have no new/stale/infrastructure diagnostics. This is still fixture/loopback evidence, not real-site or payment delivery evidence.

## Text pseudo-element correction and remaining security blocker

Merged current main through PR #131 while preserving both browser and schedules/results/GitHub producers. The merge-related tests passed 128/128. The text-pseudo regression failed on unequal private-value PNGs before the fix and passed afterward: the early important layer now neutralizes and verifies image paint and fonts for first-letter, first-line, placeholder, selection and backdrop as well as generated content. Related tests passed 87/87; typecheck and all 12 browser interaction states passed. The final six screen/theme captures have no new, stale or infrastructure diagnostics: [gate](final-pseudo-gate.json).

Security review subsequently identified CSS primitive drawings, which remain unresolved. A separate local reproduction masks all four private fields and removes their reflected text, yet differently colored DIV/SPAN segments still produce different PNGs: [reproduction result](css-primitive-proof.json). Those ordinary colors, borders and geometry are intentionally retained by the current page renderer, so image-source and text-pseudo neutralization does not establish arbitrary-page pixel confidentiality. This finding remains a merge blocker; the optional real-page adapter is not claimed safe for adversarial documents. Addressing it needs a constrained paint policy or capture refusal that also preserves the required page-image contract. The task's review-loop limit has been reached; no exception or test assertion was relaxed to hide this issue.
