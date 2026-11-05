# Surface skeleton 2: cards and lines inside the conversation

- Status: implemented (client, plus four read-only fields on the conversation read).
- Date: 2026-11-06, above `feat/v3-shell-1`
- Decisions: [ADR 0002](decisions/0002-assistant-first-surface-and-independent-checks.md) §5 and §8, [ADR 0003](decisions/0003-members-internal-teams-model-groups-and-apps.md) §6 and implementation order item 6. Screens: experience plan v3.1 §5.4, §5.6, §7 and §8, prototype artboards B2 (decision card, briefing), B3 (Work card), B5 (result unknown) and B6 (failed).
- Builds on: [Surface skeleton 1](surface-skeleton.md), [Assistant conversation](assistant-conversation.md)

## Problem

The conversation showed every Work the same way: one bordered row with a title and a state word, even after the Work had finished or failed. The experience plan asks for a quiet conversation where normal progress is one card that changes in place, finished work folds into one line, exceptions get one card with the one action that is safe, and owner decisions get the only yellow on the screen.

## What the conversation shows

Each Work-bearing turn has one slot after the Representative's reply. The slot changes in place as the Work moves; it never duplicates and never moves.

| Work state | Slot |
|---|---|
| Not started, or running | **Work card**: state ring, title, state word, assignee avatar and name, elapsed minutes while running, role chips (`Write`, outlined `Check`), step counter `done/total`, and `Start` when the owner can start it |
| Done | **Folded line** `Worked ›` |
| Result unknown, also after a plain cancel | Folded line, then an **exception card**: `● title · Result unknown`, fact `Not resent`, button `Check` |
| Check failed or stale, or stopped after starting | Folded line, then an exception card: `● title · Failed`, fact (the card label), buttons `Retry` and `Close` |
| Cancelled or quarantined, no unknown outcome left open | Folded line, then the grey line `Closed: title` |
| No Work, outcome unknown | An exception card `● title · Result unknown`, fact `Unknown whether created`, button `Check` |
| No Work, refused | The existing card with `Not created · reason` |

- The card, the folded line, a sidebar Work line and an activity row all open the same tab (surface skeleton 1, "One entry to a Work").
- **Role chips.** Every Work today has one writer and an independent check by construction (ADR 0002 §5), so the chips are `Write` and outlined `Check`. Named roles arrive with internal teams.
- **Step counter.** `done/total` counts the settled tasks under the root task against all of them; the root task only contains the steps, and the check is one of them. Before the run plans its tasks the total is 0 and no counter shows.
- **Elapsed.** Minutes since the run's durable start (`runtimeRun.ownership.startedAt`), read again each minute while a running card shows. A finished Work has no durable end time, so the folded line reads `Worked ›` without minutes (follow-up).
- **Result unknown is answered only by quarantine.** A plain `cancel` does not stop an unknown or pending effect (`domain.ts` lets it through and a later expiry keeps `cancelled`), so it is not the answer ADR 0002 §8 asks for: the exception card stays until the Work pane's quarantine, which takes a reason and an explicit acknowledgement, records the owner's handling. Unknown Work ranks as an exception in the activity list and is never a sidebar Work line, whatever its execution state.
- **Retry keeps what is there.** Retry fills the input only when it is empty or already holds the original request, and never over a draft whose result is unknown: that draft's command ID is what lets Send replay the message instead of sending it twice.
- **Rereads move nothing in place.** The log removes nodes that left and inserts new ones before their neighbour, so a slot that changes kind or an entry placed in between never detaches another entry: focus stays and the live log announces only what is new.
- **Exception placement.** The exception card sits in its Work's slot. The host keeps no time of the exception itself, so "the time it happened" is approximated by the turn's place.

### Exception buttons

| Button | Does | Never does |
|---|---|---|
| `Check` | Reads the conversation again | Send, retry or close anything (ADR 0002 §8: an unknown result is not resent) |
| `Retry` | Puts the owner's original message back in the input and focuses it, so the owner can change the conditions and send it as a new message | Send by itself, or replay the failed run |
| `Close` | Records the owner's existing `cancel` command for that Work at the card's Mission revision | Retry after an unknown answer; the card label from the next read says how it ended |

Closing a result-unknown Work stays in the work pane, because the existing quarantine needs a reason and an explicit acknowledgement.

## Decision cards, briefings and grey lines

The conversation read may carry two optional arrays. The host emits neither yet, and the shapes below exist only here and in the client check: the producers in steps 7 and 8 must emit exactly them or change both. The first producers are the member decision (step 7) and the morning briefing schedule (step 8). The client renders them when present and ignores malformed entries.

```
decisions: [{id, at, title, question, rows: [[label, value]], action, state: 'open'|'later'|'done', line?}]
briefings: [{id, at, title, turnIds: [turnId]}]
```

- **Decision card** (`state: 'open'`): the only yellow surface. Head: the question and its time, no category label. Body: label/value rows. Buttons: the action name and `Later`. No "don't ask again": rules belong to Settings > Permissions. A decision's Work title is its activity row title, and its question is the row summary; open decisions rank first in the activity list.
- `Later` leaves the grey line `Later: question` with `Ask again`. A decided card leaves the host's `line` (for example `Rounding changed`).
- The buttons send `POST /assistant/decisions` `{commandId, decisionId, answer: 'act'|'later'|'ask'}` and read the conversation again. A lost answer is not resent; the next read shows the state. The route and the first producer, member admission, are in [Members](members.md); a card with `form: 'member'` asks for a name and a shape before `act`.
- **Briefing**: one grey card, `title | date time`, then one bullet per named turn: the Work title as a link to the same entry as a card, then its current state word. Counts and states come from the current turn, never from the briefing.
- **Grey system lines** are centred, muted and in `Label: subject` form.
- Decisions and briefings carry no segment, so an earlier segment shows none of them; the latest segment shows them all.

## Time

The conversation read adds `at` to each turn that has a recorded start (`ownership.startedAt`). A centred date line (`Thu, Nov 5`) precedes the first entry of each day. Decisions and briefings are placed before the first owner message that started after them. Times use 24-hour `HH:MM`.

## Read additions

`GET /assistant/conversation` adds, read-only and without writes or calls:

- `turn.at`: the turn's recorded start, when it has one.
- `work.startedAt`: the run's durable start or `null`.
- `work.unknown`: an effect's outcome is unknown and the Work is not closed.
- `work.steps`: `{done, total}`, settled tasks and all tasks.

## Other changes

- Sidebar Work lines show running Work only. Exceptions and finished Work live in the conversation and the activity list.
- Activity priority: decision waiting → exception → running → done.

## Kept

- The direct-answer versus Work rule (ADR 0003 §6) stays in the Representative instruction unchanged.
- Labels stay in the surface's English, no explanation sentences, no "assistant", no titles. Yellow appears only in decision card rules.

## Not in this increment

- Durable Work end time, so the folded line can say `Worked for N min` and exception cards can show their time.
- Expanding the folded line in place (prototype B5: `›` turns `⌄` and lists the steps with times). Tasks record only `{id, parentId, status, result}`, with no step name or time, so there is nothing truthful to list yet; the line opens the Work tab instead. It also sits after the reply, not before it as in B5.
- Placing an earlier segment's decisions and briefings by segment (needs a segment or time span on them).
- Host decision records and `POST /assistant/decisions` (step 7, first producer: adding a member). Changing the check model as a decision card (Q4 follow-up) waits for those records.
- The morning briefing schedule (step 8).
- `Undo` on a decided line, and `Ask again` behaviour beyond sending the answer.
- Single-step Work by the Representative alone showing only the folded line even while running (needs members to tell the cases apart).
- Avatar state marks in the sidebar (working dots, unread dot).
