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
existing fixture journey. Screen-reader review, broader
browser/platform coverage, real-provider semantic quality, remote-PC authentication,
persistent approvals and general shared conversation remain open. Empty-draft and
lock-wait edge cases also have automated client regressions; they are not newly
claimed as separately clicked browser scenarios. Computer-use-linux's AT-SPI setup
was not changed or used. No general conversation-to-Work choice is adopted.


## Keyboard focus follow-up (2026-10-05)

Tracked in [LAZ-7](https://linear.app/lazybased/issue/LAZ-7/workbench-키보드-초점-복구와-전체-tab-흐름-검증).
This follow-up changes product code above the historical `0854b96` checkpoint.
The final published commit and tested source hashes are recorded with PR #13 and
in the task-owned `keyboard-final/evidence.json`; earlier QA results above retain
their original code checkpoints.

Actual Chrome keyboard input reproduced focus falling to the document body after
instruction submission, cancellation, model/scope configuration, selection check
and explicit Run. The affected handlers now restore the corresponding instruction,
configuration/check control or closed/result Work heading. Restoration respects a
user who moved focus elsewhere while waiting. Mission rendering preserves another
Work's focused instruction, unsent draft and selection range. Evidence and snapshot
text regions support Tab, keyboard scrolling and a visible focus indicator.

The final normal CLI host used a separate disposable SurrealDB 3.3.0 and local
credential-free compatible fixture, ports 18361–18364 and dedicated browser
profiles. No real model/account, OS setting or existing user browser was used.

| Keyboard observation | Result |
| --- | --- |
| Mission/Work forms and native validation | Tab/Enter creates actual Mission/Work; empty Mission focuses required Purpose and sends zero POST |
| Owner direction/cancel | Submission focuses the same Work instruction; cancellation focuses its closed Work heading with 3px outline |
| Focus moved while request waits | Other Work's unsent direction, focus and caret survive authoritative snapshot replacement |
| Revision conflict | Independent browser wins held original request; losing draft/comparison and input focus retained with one POST; deliberate keyboard resubmission alone raises it to two |
| Model/scope configuration | Keyboard submission returns focus to model input / executor scope selector |
| Selection/error and explicit Run | Invalid zero-budget/cap check retains check-button focus; corrected check sends zero Run requests; deliberate Run sends one and displays an accepted fixture Record, two local provider calls |
| Expanded detail/Records/snapshot traversal | All 61 eligible controls/text regions visited with 366 Tab/Shift+Tab presses; no missing target or trap; fixture action reached without activating it |
| Narrow view and automated accessibility | 390px view has scroll width 390 and visible Work focus; expanded-state axe 4.12.1 reports 46 passes, zero violations/incomplete after fixing six inaccessible scrolling text regions |
| Native select dismissal / modal | Arrow-key choice and Escape exercised; no application modal/dialog exists in this surface, so modal cancellation is not applicable |

Pinned static types and affected real HTTP/SurrealDB regressions passed 64/64,
zero skips/failures. Four added client regressions cover successful direction,
conflict, cancellation and another Work's focused draft during response handling;
existing integration cases also assert scope/check/Run focus. Exact published-head
CI and independent review are tracked on PR #13 separately.

Screen-reader testing was not performed (Orca was not available). Broader browser,
platform and assistive-technology review, remote-PC authentication and live-model
quality remain open. This is bounded keyboard evidence, not full WCAG certification.

A first held-conflict harness attempt exceeded the client's request timeout and
entered its expected unknown-outcome barrier. It was released without replay and
kept as diagnostic evidence; the bounded two-client reproduction above then passed.
The test driver also corrected its admission budget/cap and waits for closed detail
state. Those driver corrections are recorded separately from product defects.


## Independent keyboard review follow-up

Codex review of `87b4740` found two P2 focus cases: moving to another Work's
summary/evidence/selection while an owner response waits, and implicit Enter
submission from a model/authorization input. Both were reproduced in actual Chrome
and in regression tests before fixing. Work controls now have stable logical focus
identities; rendering restores the corresponding target, necessary ancestor details
and evidence scroll position, or its Work heading when that target disappears.
Model/authorization forms accept implicit submission focus and restore its original
input after replacement while respecting focus moved elsewhere.

The corrected candidate passed pinned types and 67/67 affected actual-store
regressions, zero failures/skips. Actual Chrome separately verified implicit model
name/cap submission and held-request summary/pre/select focus; each target remained
visible in the new DOM. A normal selected fixture Run still made one explicit Run
and two provider calls, produced an accepted fixture Record and focused its Work
heading. Keyboard cancellation also focused the closed Work heading. The final
2-Work/accepted Record fixture state visited all 45 eligible targets with 270
Tab/Shift+Tab presses, no missing target; axe reported 46 passes, zero violations or
incomplete, and the inspected 390px layout retained scroll width 390.

Task-owned `keyboard-review/evidence.json` names the final published HEAD/source
hashes and stores before/after diagnostics, screenshots and the latest CI/review
links. The 61-target earlier fixture remains evidence for its own checkpoint rather
than being relabelled as this smaller fixture state. A stopped QA host caused one
intermediate retry to remain behind the expected reconnect barrier; that attempt
was not counted as passing. A fresh disposable DB/profile completed the final run.
No live provider, OS setting, auth policy or human browser was changed.


### Latest setup focus during response handling

A subsequent Codex P2 on `a1fd32f` showed that moving within or between setup
forms after an implicit submission could still be undone: replacement lost the
newer focused field, then restored the original submitted input. The minimal
renderer follow-up captures the active setup field immediately before replacement
and restores that stable ID before submission completion chooses a fallback.

Before-code actual Chrome and three regressions reproduced model-to-name,
authorization-cap-to-scope and model-to-adjacent-cap movement being discarded.
Corrected code preserves all three newly connected focus targets with one POST
per request; affected actual-store tests pass 70/70, zero skips/failures. The final
setup state reports axe 41 passes, zero violations/incomplete, with inspected
390px/390px layout and visible focus. No provider request or Run was made for this
setup-only follow-up. Task-owned `keyboard-setup-focus/evidence.json` names its
exact final source/HEAD and before/after artifacts. Earlier full Tab/Records/Run
journeys retain their named checkpoints; tab structure did not change in this
minimal renderer follow-up. Latest-head CI and independent review are recorded
with PR #13. Screen-reader and broader platform gates remain open.
