# PR 110 review follow-up: CI and A1–A16

The CI failure in run 42584324473 is reproduced with `TZ=UTC`: the fixed
next-run instant renders at 23:00 UTC and 08:00 Asia/Seoul. The approved B17
artboard distinguishes **Next run** from **Cycle**. The regression now checks
creation minute 480, the browser offset, active state, daily 08:00 in the Cycle
row and the cumulative 30-run budget. Sidebar checks retain active/title/daily
without substituting the cycle time for a separately stored next-run instant.

| Item | Correction | Boundary |
| --- | --- | --- |
| A1 | Icon-bearing profile pill buttons and a device card with stacked name/readiness text. | Readiness still comes from the observed host; restart/update facts remain unavailable. |
| A2 | Document/file/image glyphs replace the empty outline; recent results use the same glyph selection. | Metadata determines the glyph; no binary result or reader is fabricated. |
| A3 | Magnifier pill search controls; no autofocus. Capture flows blur after query/clear; focus-visible rings remain available. | Keyboard focus is retained and checked separately. |
| A4 | Single-line month/day/time result dates, without weekday. | Preserve actual stored timestamps, not example times. |
| A5 | Result titles use the approved medium weight. | No title or Record identity changes. |
| A6 | B10-preview fixture uses the approved E3b square letter-chip choice. | Production owner-chosen member shapes remain authoritative. |
| A7 | Memory content returns to the artboard's 640px column, 44px top offset and 22/30 heading; row titles use medium weight. | Other settings layouts are untouched. |
| A8 | Advanced is hidden only while Memory is selected; disabled off toggles retain visible thumbs. | Disabled controls remain disabled. |
| A9 | New task has a plus glyph and quiet styling even when current. | Singleton admission and cumulative budgets remain. |
| A10 | Regular detail values, 44px fact-row pitch and Paused chevron; request copy follows the artboard's hover/focus control below the request. | Copy remains accessible; no command changes. |
| A11 | GitHub changes are shown without the invented field label. | Preserve the host counts. |
| A12 | Zero deletions are omitted in file rows. | Nonzero counts remain visible. |
| A13 | Per-file add/delete bars use only valid safe integer counts from the existing metadata. | Unparseable metadata stays literal; generic apps and Work app tabs retain their original renderer. |
| A14 | Muted PR number, status and branch glyphs, and date from the same selected row in the existing app-page read. | Existing generation/feed checks remain; no new read or URL inference. |
| A15 | Repository glyph and chevron added to the existing repository control. | No new repository-selection API. |
| A16 | Two-line regular PR titles with ellipsis marker and an App settings glyph. | Check status has no current producer; see below. |

## Missing check status (A16)

The bundled GitHub handler reads only pull requests and changed files:
[`src/app-catalog.ts:10–12`](../../../src/app-catalog.ts#L10). Its item view emits
`Changes` and file rows; it never reads check runs/statuses and never emits a
check verdict. The host's strict [`AppView`](../../../src/apps.ts#L18) validation
[`checkView`](../../../src/app-sandbox.ts#L18) also has no typed check-status
field. Therefore the `verify 통과` check chip remains absent, with this explicit
code evidence; neither PR openness, file counts nor an accepted Work is used as
proof that the PR checks passed.

## Independent GLM findings

1. `validateAssistantSource` permits only Representative segment IDs
   ([source](../../../src/assistant-conversation.ts#L123)); `memberTurn` clears
   proposals ([source](../../../src/assistant-service.ts#L325)). Therefore the
   result row's `memberId` is an assignee, not the source thread. Result navigation
   opens the Representative at the stored segment; the row keeps its assignee.
   A regression starts on a member thread with an unrelated turn at the same
   segment number, then checks the actual Representative source messages/turn.
   The B10-preview read fixture includes that originating turn. The artboard's
   member-thread composer remains a documented capability mismatch with the
   currently enforced source model, rather than navigating to an unrelated turn.
2. Schedule rows apply the current query to their rendered title/time/cycle
   before insertion. A regression filters, re-renders and rereads a schedule
   event; all replacement rows retain the filter and no command is sent.

Both regressions were observed failing before the fixes and passing afterward.
