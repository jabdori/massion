# P2 #2: isolated app documents

Only an installed, pinned adapter supplies HTML. The service's `AppView` stays
unchanged. The HTTP server publishes browser documents on a dedicated ephemeral
loopback listener. Authenticated desktop replies retain HTML until main receives
them; main publishes that HTML at `massion-app://document/<random-id>` and
replaces the frame payload with a URL. The actual app panel consumes `frame.url`.
No renderer upload, arbitrary host URL, credential forwarding or network proxy
is added.

Each publisher retains at most 32 documents of 64 KiB for five minutes, evicts
oldest entries, and clears on shutdown. Documents have their own response CSP:
sandbox allow-scripts, inline scripts/styles, no network, forms, objects, nested
frames or base URL. Workbench script/style policy stays intact; only frame-src
adds the controlled document origin. Desktop request/navigation admission also
requires an exact live registered document URL in a direct subframe of the
workbench. Authentication, protocol target, sender and existing request guards
remain in place. Rejected host responses bypass local request-body JSON parsing.

The client retains sandbox allow-scripts without allow-same-origin and registers
the source window before document scripts post ready/resize. Only exact ready
and bounded resize shapes are admitted. Raw HTML/blob/arbitrary URLs cannot be
passed to the frame factory, and raw frame HTML cannot create a panel iframe.

## Browser panel verification

[Report](frame-origin-evidence/browser-report.json),
[light screenshot](frame-origin-evidence/browser-light.png),
[dark screenshot](frame-origin-evidence/browser-dark.png).

`tests/support/frame-origin-host.ts` runs the actual development workbench with
an in-memory store, a real app offer/owner install decision and an injected MCP
fixture adapter. It makes no provider/model/credential calls. Verification used
agent-browser 0.41.2 / headless Chrome for Testing 157.0.8103.38 in the separate
`massion-frame-origin-b2d8130e6192` session at 1440 x 960. In each theme:

1. Open the development workbench and click the installed app's rail icon.
2. Wait for `#app-view iframe` to reach 617px from the actual app script message.
3. Assert a different document origin, no srcdoc attribute, sandbox allow-scripts,
   parent-to-child DOM denial, and no child mutation of the parent DOM.
4. Read the fixed fixture document's script-computed probe through its heading's
   `data-probe` using agent-browser's cross-frame element ref. Verify actual
   inline script execution, opaque origin `null`, denied parent DOM and network
   fetches, no Node/desktop bridge, and own computed background color:
   `rgb(234, 235, 236)` light / `rgb(12, 34, 56)` dark.
5. Click the actual in-document resize button and wait for parent height 701px.
   Leave for the conversation and reopen through the rail in the other theme;
   the new view receives a different document URL.

Both screenshots were also inspected. Parent/document JSON, resize results and
accessibility snapshots are retained for each theme beside the report. The
installed CLI's eval remains top-level when a frame snapshot is selected; the
fixture's cross-frame attribute report avoids assuming eval entered that frame.
No production message channel or policy was changed for verification.

## Focused checks

- [Root tests](frame-origin-evidence/root-tests.log): 45 passed, one existing
  opt-in SurrealDB restart test skipped; no full-repository test run.
- [Root typecheck](frame-origin-evidence/typecheck-root.log): passed.
- [Integrated desktop checks](frame-origin-evidence/linux-integrated.log): Linux
  x86-64 Node 24.19.0 / Electron 45.2.3, desktop typecheck and ten focused tests
  passed, followed by the complete Docker/Xvfb smoke. The smoke now opens the
  real app panel through its rail icon before checking app script/style/resize,
  parent DOM/network denial, missing Node/preload bridge, and forged sources.
  Existing injected-script, navigation, permission, network, theme, Work focus,
  close/reopen and explicit-quit assertions remain enabled. System D-Bus
  diagnostics did not fail any assertion.
- [Desktop app screenshot](frame-origin-evidence/app-frame.png) and
  [assertions](frame-origin-evidence/app-frame.json): own computed background
  `rgb(12, 34, 56)` and resize 617px in the actual isolated document.
- Before/after regressions cover registry bounds/expiry, browser publishing,
  desktop policy/proxying, the panel URL integration and malformed request host
  rejection. Initial failing logs are retained alongside passing evidence.

## Main-frame request boundary follow-up

The session request guard now calls `allowWorkbenchRequest`: workbench origin
and API requests require the owned webContents ID and the exact owned main-frame
object. API/subresource requests also require that frame's committed URL to be
the workbench URL. Registered app documents retain the existing exact URL lookup
and direct-child `subFrame` admission. No CSP changed in this follow-up.

[Final Linux run](frame-origin-evidence/main-frame-final.log): desktop typecheck,
11 focused tests and complete Xvfb smoke passed. The smoke explicitly performs a
real main-frame protocol query and receives a real EventSource feed message.
For each workbench root/connect/request/events target, it passes the actual
Electron app-child frame identity to the same independent request guard and
asserts rejection, then verifies actual child fetch rejection under its unchanged
CSP. [Results](frame-origin-evidence/frame-boundary.json).

[Observed metadata](frame-origin-evidence/request-metadata.json) establishes that
initial navigation has the owned main-frame object and webContents ID, but an
empty committed frame URL. A narrow `mainFrame` resource exception therefore
allows only navigation to the workbench root without requiring an already
committed workbench URL. It does not waive frame/webContents identity; requests
with missing/null frame metadata are denied. API fetch and SSE metadata carry
the owned main frame and committed `massion://app/` URL. A document request
carries the distinct child frame with the owned main frame as parent.

DevTools frame-scoped network loading was explored for a policy-independent
child request, but Chromium enforces the document CSP on that command too. No
CSP bypass or relaxation was introduced: the final smoke separately checks the
independent guard with real frame identity and the actual unchanged-CSP fetch.
The existing security smoke assertions remain enabled.

## Existing acceptance verifier

The lead applied the hosted-document update to
`docs/acceptance/e5b-ui/verify.mjs`, removed the handoff patch artifact, and is
running that verifier. The main architecture document was updated by the lead.
This worker did not edit either file and does not claim the lead's verifier run
has passed. The panel is integrated; no pending panel patch remains.

## Files and limits

Production: `src/app-documents.ts`, `src/app-frame.ts`, `src/apps-panel.ts`,
`src/server.ts`, `desktop/main.ts`, `desktop/security.ts`,
`desktop/transport.ts`, and `desktop/build.mjs`.
Tests/fixtures: `tests/app-documents.test.ts`, `tests/app-frame-server.test.ts`,
`tests/app-frame.test.ts`, `tests/support/frame-origin-host.ts`,
`desktop/tests/frame-origin.test.ts`, `desktop/tests/shell.test.ts`,
`desktop/tests/fixture-daemon.mjs`, and `desktop/tests/smoke-app.mjs`.
Main-owned `src/apps.ts`, `src/mcp-apps.ts` and `tests/mcp-apps.test.ts` were not
edited by this worker.

Not checked: full suite, full screen contracts, packaged release, real providers
or credentials, and independent review (lead-owned). No commit, push, external
comment, dependency installation or visible Electron/Chrome window was made.
Registry eviction/expiry intentionally makes old URLs return 404; a fresh view
obtains a new document.

Reference checked during implementation:
[Electron custom protocols](https://www.electronjs.org/docs/latest/api/protocol)
and [frame navigation events](https://www.electronjs.org/docs/latest/api/web-contents#event-will-frame-navigate).


## Replacement of the old synthetic frame probe

The old `docs/acceptance/e5b-ui/verify.mjs` still verifies all connection-card
interactions. Its synthetic srcdoc frame probe is replaced by the real installed
app panel checks above, `tests/app-frame.test.ts`, `tests/app-frame-server.test.ts`
and the extended desktop smoke. These retain source validation, resize bounds,
parent isolation and network denial, while also proving independent CSP, real
scripts/styles and URL-only transport. No fixture-host CSP override or raw HTML
injection is needed in the connection-card verifier. A trial adaptation of that
obsolete probe did not complete through agent-browser; it is not claimed as a
passing test. The real panel and desktop checks are the replacement evidence.
