# Actual browser QA for the existing local Work path

Status: bounded actual Chrome QA executed on `6816adb0d4667131e13770c84c00c5c8a3fa9c6d`
(unchanged product code from `e1c9a34`). Tooling setup completed in the existing
setup session; this development session read the official agent-browser skill/core
guide and used the installed CLI without installation or settings changes.

## Environment and evidence

Use one owned disposable loopback host and SurrealDB 3.3.0, with a credential-free
local HTTP provider if explicit Run/connection UI is exercised. Use the normal CLI
manifest path and only existing routes. No real credential access, live/paid model
calls, persistent grants, public listener, remote authentication or shared
conversation feature is part of this QA. Fixture results stay fixture-labelled.

Record the exact HEAD, host/browser/runtime versions, start configuration with no
secret values, independent browser contexts/storage, screenshots, relevant actual
DOM/accessibility observations and HTTP command/receipt counts. Record each row
as passed, failed or not run, with its evidence and limitations. A source/DOM harness
pass is supporting evidence; it does not pre-complete a browser row. Full WCAG,
remote PC and model quality certification are separate gates.

## Scenarios

| Flow | Browser actions | Required observation |
| --- | --- | --- |
| Mission/Work and blockers | Create a Mission with criteria; admit Work without a usable provider | Labels and criteria are readable; Work is durably blocked; no fixture/model substituted; execution and acceptance differ |
| Declared connections and explicit Run | Start the selected credential-free manifest, explore/select declared models, explicitly permit fixture scope, check current revision, request Run | Managed controls and declared models match host; selection/check does not run; one explicit Run yields fixture evidence/Records; secret data absent from DOM |
| Second client link | Open the Mission fragment in an independent browser context/storage | Same authoritative Work/history; GET-only opening; no authority, private draft or command copied by the link |
| Conflict and explicit revised submission | Arrange two original-revision directions using a controlled held request if tooling supports it; compare the losing draft; edit and submit deliberately | One original winner; submitted/current text and revisions visible; draft retained; no retry/extra POST before explicit submission; new command identity |
| Lost response and receipt | With owned test transport interception, let a submission commit and lose only its response; reveal its exact durable receipt later | Unknown lock then confirmed readback; no replay; committed draft/comparison clears; edits after submit/lock wait survive. Mark not run if interception cannot reproduce the boundary |
| Cancellation and navigation | Keep a conflict draft, including empty edit; another client cancels Work; inspect another Work/Mission and return | Closed Work is read-only; historical rejected text differs from current draft; no draft leakage or detached-control writes |
| Reconnect and host restart | Stop/restart only the owned test host; preserve browser; another context updates Work; reconnect | Visible write barrier; reads/drafts available; current runtime/Mission refresh before actions; pending unknown lock independent; no restart Run/POST replay |
| Actual DOM/keyboard/viewport | Traverse forms, selection, conflict, cancel and Records with keyboard; inspect focus, labels, status, long text and narrow/wide views | Actions and disabled/recovery states understandable; no clipped essential content; focus/status observations recorded; screenshots match actual DOM |

Existing regression references: `tests/client-workbench.test.ts`,
`tests/workbench.test.ts`, `tests/host-connections.test.ts`,
`tests/provider-setup.test.ts` and the normal CLI fixture tests.

## Executed evidence (2026-10-05)

Agent-browser 0.38.2 / Chrome 154.0.8037.92, Node 24.19.0 and SurrealDB 3.3.0.
Normal CLI host used a selected credential-free compatible manifest. Dedicated
ports 18241–18244, namespace `massion13qa6816`, fresh task-owned profiles and
browser sessions `massion13-6816-a`/`-b` kept other browser/host state separate.
No user cookies/login, real keys, live/paid calls or new authentication were used.

| Prepared row | Observed result |
| --- | --- |
| Mission/Work and blockers | Actual fill/click creates Mission and blocked Work; no substitute execution |
| Declared connections and explicit Run | Local metadata discovery; selected executor/reviewer and explicit fixture scope; preflight Run requests 0; explicit Run requests 1; provider calls 2; accepted fixture Record displayed |
| Second client link | Independent fresh profile opens same Mission with initial POST 0 |
| Conflict/revised submission | Held original UI request loses to other browser; comparison and retained editable draft visible; manual new submission only |
| Lost response/receipt | Server commit then dropped response and withheld events; unknown lock; revealing exact receipt clears draft/comparison; POST stays 2 |
| Cancellation/navigation | Cancel click makes Work read-only; failed Mission navigation then actual Back restores matching original URL/Mission with POST unchanged |
| Restart/reconnect | Owned host stops/restarts; barrier shown and reads enabled; POST stays 7, revision 24 and accepted Record retained; provider calls stay 2 |
| DOM/keyboard/viewport | Wide and 390px screenshots inspected; narrow scroll width 390; no unlabelled inputs; Tab focus observed on SUMMARY; axe 4.12.1 reports 44 passes, 0 violations/incomplete in checked states |

Eight screenshots (`01-mission` through `08-back-reconnect`), final DOM/call
inventory, accessibility output, browser metadata and hashes are preserved in the
local task's `browser-qa/evidence.json` and neighbouring files. These task-owned
artifacts contain fixture data. Host/provider harness was external to the repo;
product source was unchanged during QA. Two browsers were closed and the owned
supervisor/DB were gracefully shut down.

The CLI default wait for a hidden notice timed out because it waits for visibility;
a direct DOM read confirmed the empty notice, receipt cleanup and no extra POST.
This harness observation is not presented as a product failure.

## Remaining coverage

This is actual visual/click and automated accessibility evidence for the bounded
existing fixture journey. Full keyboard traversal, screen-reader review, broader
browser/platform coverage, real-provider semantic quality, remote-PC authentication,
persistent approvals and general shared conversation remain open. Empty-draft and
lock-wait edge cases also have automated client regressions; they are not newly
claimed as separately clicked browser scenarios. Computer-use-linux's AT-SPI setup
was not changed or used. No general conversation-to-Work choice is adopted.
