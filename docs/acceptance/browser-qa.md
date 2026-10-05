# Actual browser QA for the existing local Work path

Status: prepared, not run. No browser visual/accessibility evidence is claimed.
Agent/browser tooling installation is owned by the existing setup session; this
session does not install concurrently, change settings or select new permissions.
After its confirmed installed paths/instructions arrive, inspect those instructions
and run against the exact candidate in this same development session.

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

## Current blocker

Installed agent-browser/computer-use-linux/find-skills paths and applicable usage
instructions have not yet been delivered to this session. No setup result or
browser test is inferred from an in-progress install. General conversation and
remote identity decisions remain deferred; this plan tests already implemented UX.
