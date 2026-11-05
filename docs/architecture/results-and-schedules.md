# Results and schedules

- Status: implemented (first increment: the Results page over accepted text Records with a preview tab, the Schedules page with one schedule kind, the morning briefing, run by a host scheduler).
- Date: 2026-11-06, above `feat/members`
- Decisions: [ADR 0002](decisions/0002-assistant-first-surface-and-independent-checks.md) §1 (the Representative reports first; a briefing is one message) and §8 (an unknown outcome is not resent), [ADR 0003](decisions/0003-members-internal-teams-model-groups-and-apps.md) §1 (rail: results shelf and schedules; schedules are a host function, not a person) and implementation order item 8. Screens: experience plan v3.1 §5.4, §5.5 and §5.8, prototype artboards B10 (Results), B10-preview (preview beside the conversation that made it), B17 (Schedules) and B17-empty.
- Builds on: [Exact accepted text access](accepted-text-access.md) (the preview reads through the existing exact Record route), [Surface skeleton 2](conversation-cards.md) (`briefings[]` and exception cards), [Members](members.md) (one host aggregate under the reserved prefix, replayed by lineage).

## Problem

The rail's Results and Schedules opened empty placeholders. Accepted results could only be read inside a Work's evidence, and nothing reported first: `briefings[]` had no producer.

## Results

`GET /assistant/results` lists the accepted Work of the Representative's intake Mission, newest first, at most 200 rows, read-only:

```
{feedId, results: [{missionId, workId, recordId, version, sha256, kind, title, at, segment, turnId}]}
```

- A row is an accepted Record whose Work came from the conversation (`assistantSource`). Its name and its source Work are the Work title; `segment` and `turnId` name the conversation that made it. A direct answer in the conversation is not a result (experience plan §5.8).
- `at` is the run's durable start. The Record has no acceptance time, so "Last activity" approximates it (follow-up).
- The assignee is the Representative: every Work is the Representative's until member Work exists.

### Surface

- **Rail > Results** replaces the conversation with the Results page (B10). The sidebar shows `Results`, `All` and `Documents` (every readable result is text) and up to five recent names.
- Heading `All`, a Grid/List switch (a radio pair), and a table `Name · Work · Assignee · Last activity` or, in the grid, one tile per result. No results: `No results yet`.
- **A row opens the conversation that made it, with a preview tab beside it** (B10-preview): the page switches to the Representative's conversation at the result's segment, and the work pane opens a tab named after the result with `Preview` and `Original` and `Copy`.
- The preview reads the exact text through `GET /missions/:id/record-artifact` with the row's Record, version and SHA-256, and renders it literally: lines starting `- ` or `* ` as list items, other lines as paragraphs, never as HTML. `Original` shows the same bytes in a `pre`. A failed or stale read shows `Unavailable`; nothing else is substituted.

## Schedules

One aggregate `assistant-conversation:schedules` (kind `schedules`) under the reserved prefix, like members.

```ts
interface Schedule {id; kind:'briefing'; minute; offset; active; nextAt; budget:{runs}; used; runs: Run[]}
interface Run {id; slot; manual; state:'started'|'done'|'failed'|'closed'; startedAt; deadlineAt; endedAt?; turnIds?; reason?}
```

- **One kind, the morning briefing.** At most one schedule exists. Its request, assignee (the Representative) and destination (the Representative's conversation) are fixed by the kind.
- **Time.** `minute` is the minute of the day (0–1439) and `offset` the owner's UTC offset in minutes, both from the creating browser. `nextAt` is the next slot strictly after the moment it is computed. Daylight-saving changes are not followed (follow-up).
- **Cumulative budget is required.** Create carries `budget.runs` (1–366): the total number of runs the schedule may ever start. Each start counts. A due slot with no budget left records a failed run `Budget reached` and pauses the schedule; Resume and Run now are refused while it is spent. Raising the budget is a follow-up.
- **No model call.** The host writes the briefing from Work states it already has: the Work-bearing turns of the Representative's head segment that started in the 24 hours before the run, at most 12. The client renders each bullet with the turn's current state, so a briefing never carries counts of its own (conversation-cards.md). A model-written briefing would charge the same budget.

### Commands

| Command | Actor | Rule |
|---|---|---|
| `create-schedule {scheduleId, kind, minute, offset, budget}` | Owner | Only one schedule; active at once with the next slot |
| `pause-schedule` / `resume-schedule {scheduleId}` | Owner | Resume computes the next slot from now; missed slots are not run |
| `start-run {scheduleId, runId, slot, manual: false}` or `{scheduleId, runId, manual: true, retryOf?}` | Host | Active, budget left, no run of this schedule started and before its deadline. A scheduled start must be the due slot (`slot = nextAt ≤ now`) and advances `nextAt` past now. A manual one (Run now) carries no time: its slot is the observed time, so a resent command keeps its fingerprint and a clock that moved between reads does not refuse it; it keeps `nextAt`. `retryOf` names a failed run, which closes in the same step |
| `finish-run {scheduleId, runId, turnIds}` | Host | Only a started run before its deadline |
| `fail-run {scheduleId, runId, reason}` | Host | Only a started run |
| `skip-run {scheduleId, runId, slot}` | Host | Due slot with no budget left: a failed run `Budget reached`, the schedule pauses |
| `close-run {scheduleId, runId}` | Owner | A failed run, or a started run past its deadline (result unknown) |

Host command IDs are `assistant-schedule-run:<runId>` (start), `assistant-schedule-finish:<runId>`, `assistant-schedule-fail:<runId>` and `assistant-schedule-skip:<runId>`; a scheduled run's ID derives from the schedule and slot, a manual run's from the owner's command ID. An owner command never carries the prefix. Lineage replays the aggregate and checks that each actor and ID came from where it says.

### Host scheduler

- `SchedulesService.tick()` runs every 30 seconds while the host serves, one at a time, and stops when it drains or closes; drain waits for a tick already in flight before it reports `drained`. For a due active schedule it starts a run, reads the conversation, then finishes the run. A second tick for the same slot replays the same start by command ID.
- **Result unknown is never resent.** A run is `started` until it finishes or fails. A started run past its deadline (60 s) reads as result unknown: its slot is not run again, the next slot still runs, and the owner may close it.
- A read failure is a failed run with `Briefing unavailable`. A commit with an unknown outcome is left as it is: the run reads as unknown after its deadline.

### Conversation read

`GET /assistant/conversation` (the Representative's) adds:

- `briefings`: one per done run, `{id: runId, at: endedAt, title: 'Morning briefing', turnIds}`, the shape conversation-cards.md fixed.
- `exceptions`: one per run that failed or is unknown and not closed, `{id, at, title, state: 'failed'|'unknown', fact, actions, scheduleId, runId}`. `actions` is `['check', 'close']` for unknown, `['retry', 'close']` for failed, and `['close']` when the budget is spent. The client draws them like a Work's exception card: `● Morning briefing · Failed` and the fact, with `Check` (read again), `Retry` (Run now with `retryOf`, so the failed card closes with the new run) and `Close`.

### Routes

- `GET /assistant/schedules` → `{feedId, revision, schedules: [{id, title, request, assignee, destination, active, nextAt, minute, offset, budget: {runs, used}, runs: [{id, at, state, fact, turnIds}]}]}`, runs newest first.
- `POST /assistant/schedules {commandId, action, …}`: `create` with `minute`, `offset`, `budget`; `pause`, `resume`, `run` and `close` with `scheduleId` (and `runId` for close). `run` writes the host's start for the owner and runs it at once.

### Surface

- **Rail > Schedules** replaces the conversation (B17). The sidebar shows `Schedules`, then `Active` with each active schedule as name and `next · cycle`, then `Paused ›` folding the paused ones.
- No schedule: the clock icon, `Schedule a task`, and the one example card `Morning briefing` with its line `Sums up yesterday's work each morning`. Choosing it creates the briefing at 08:00 in the browser's offset with a budget of 30 runs and selects it. The other prototype examples need scheduled Work and are left out.
- Detail: the name, an `Active` switch, `Run now`, the rows `Assignee`, `Next run`, `Cycle`, `Delivers to` and `Budget` (`3 of 30 runs`), `Request`, and `Past runs`: a mark, the time, the fact and `View in conversation`.
- The yellow stays in decision cards. No explanation sentences; labels stay in the surface's English.

## Invariants

1. Nothing in a briefing is judged by its producer: it lists turns, and states come from the turn at read time.
2. A run whose result is unknown is never run again; only the owner closes it.
3. A schedule never starts more runs than its cumulative budget.
4. There is no autonomy setting: only the owner creates, pauses, resumes or runs a schedule.

## Not in this increment

- Results: Files and Images (non-text artifacts), search, the result card in the conversation (`Undo`, `View result`), an acceptance time, results of member Work, a working kind filter in the sidebar (`All` and `Documents` are the same while only text exists), and a source Work column distinct from the result name (a result is named after its Work today).
- Schedules: `New task` and the other example kinds (scheduled Work through the normal Work path, with decision cards when a run would pay or send), editing the time, raising the budget, member schedules and whose budget they spend, daylight-saving time, the briefing frequency (off, low, high) in Settings > General.
- A model-written briefing; a briefing that reads beyond the newest conversation segment.
- More than 30 open failed or unknown runs: the next start is refused until the owner closes earlier ones, so the schedule stops quietly; surface that as its own card.
