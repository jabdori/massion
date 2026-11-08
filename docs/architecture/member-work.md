# Member Work: handing Work to a member

- Status: implemented with fixture-class evidence (first increment: assignment, member model group routing, steering from the 1:1 conversation, host Work list, durable end time).
- Date: 2026-11-08, above `main` (#95)
- Decisions: [ADR 0003](decisions/0003-members-internal-teams-model-groups-and-apps.md) §1, §2, §3 and §6; [ADR 0002](decisions/0002-assistant-first-surface-and-independent-checks.md) §5 and §8. Screens: prototype artboards B2 (card with the member who holds it), B11 (steering line), B18 (member 1:1 conversation with its Work and a steering tag), B21 (decision card with the Work to hand, collapsed "Worked for N min" line).
- Builds on: [Members](members.md), [Family map and model groups](family-map-and-model-groups.md), [Surface skeleton 2](conversation-cards.md).

## Problem

Members exist, but every Work is the Representative's. The Representative cannot hand a Work to a member, a member's model group never runs a Work, a remark about a running Work in a member's 1:1 conversation is lost, the sidebar's Work lines and the activity list read only the shown conversation segment, and a finished Work has no end time, so the collapsed line cannot say how long it took.

## Representative output: `assistant-turn/v2`

```
{"reply":"<text>","work":null}
{"reply":"<text>","work":{"title":"<one line>","member":"<member name>"|null}}
```

- `assistant-turn/v1` (`work: {title}`) is still accepted and means no member.
- The request carries `members: [{name}]` as data; names never enter the fixed instruction.
- The settled proposal keeps the model's words: `proposal: {title, member?}` (member is a name, one line, at most 32 characters).
- A member conversation keeps its own contract: `{"reply","work":null}` (v1) or `{"reply","work":null,"steer":"<workId>"|null}` (v2). A Work in a member reply is still dropped.

## Assignment

- The host, not the model, decides whether an assignment holds. At admission the named member must exist in the members aggregate (names compared with the same locale-free folding as admission). An unknown name is refused with `member_unknown`: the Work is not created and the host does not pick someone else. Archived members do not exist yet; when archive lands, it is refused the same way.
- The Work pins the member: `assistantSource.memberId`. Lineage checks that the answered turn's proposal named a member and that the members aggregate held that member with that name at an earlier cursor.
- The Work still lives in the Representative's intake Mission and still follows every Work rule: the same admission, preflight, budget and independent check. The Representative wrote the title, so it stays a producer.

## Model group routing

- A member in the `default` group runs on the default route unchanged (the default group is the default route).
- A member in an owner group: the executor is the group's first available model within the default route's cap. The checker is, in order: a different-family model in the same group; a different-family model in any group (so the preflight rule `verifier_family_available` holds); otherwise the group's first model (a same-family check in a separate run). Producers are the executor and the Representative.
- The default route sets the per-call cap. An existing grant for the Mission scope must cover both selected models at that cap. Without one, admission is refused with `member_grant_missing`; the host never creates or widens a grant. The admitted Work still passes the full preflight.
- The owner sets a member's group (`set-member-group`, owner setting, ADR 0003 §3). The group must exist at that moment. `POST /members/group {commandId, memberId, modelGroup}`.

## Steering from a member's 1:1 conversation

- A member turn's request carries `works: [{id, title}]`: the member's eight newest open Works (not accepted, not cancelled). The member model may name one in `steer`.
- The host checks the named Work is in that list and records the owner's exact message as that Work's steering through the existing `steer` command, as the owner, through the drain-aware owner store, with command ID `assistant-steer:<turnId>`. After the write commits, the host interrupts the active run through the existing runtime intervention hook. The model only routes; the instruction is the owner's text.
- The settle then records `steer: {missionId, workId, status: 'recorded' | 'not_recorded'}`. A steer whose commit outcome is unknown is not resent and settles `not_recorded`; the next read of the Work shows the truth.
- The member message shows `↩ <title> · Steered` (B18).

## Host Work list

`GET /assistant/works` → `{feedId, works: [...]}`: every conversation Work in the intake Mission, newest admission first, at most 200.

```
{missionId, missionRevision, workId, title, memberId: string|null, execution, acceptance, unknown, started, startedAt, endedAt, turnId, segment}
```

- The sidebar's Work lines (the Representative's and each member's) and the activity list read this list, not the shown conversation segment, so Works from earlier segments and member Works appear while any conversation is open.
- The client keeps a request generation: a slower earlier answer never replaces a newer one. A changed `feedId` replaces the whole list. While any listed Work runs, the list is read again with the conversation's minute timer, so a Work that ends without an event still leaves the lines.

## Durable end time

- `Work.endedAt`: the host time recorded by the command that ended or stopped it (`verify`, `accept`, `cancel`, `block-work`, `quarantine-runtime`). The time is in the event, so lineage replays it; journals without it still replay.
- The collapsed line says `Worked for N min ›` (N = whole minutes from run start to end, at least 1). Without an end time it stays `Worked ›`.

## Decision card

- `propose-member` may carry `handoff`, one line: the Work to hand the new member. The card shows it as the row `Work to hand` (B21).

## Invariants

1. A Work is assigned only to a member that exists when it is admitted; the host never reassigns.
2. The producer never judges: a member Work keeps distinct executor and checker identities and its family relation is pinned as before.
3. Steering records the owner's exact words only; a model reply never becomes an instruction.
4. A steer or admission whose outcome is unknown is never resent.
5. Owner writes (`set-member-group`, steering) go through the drain-aware owner store.

## Not in this increment (follow-up)

- A team per Work (team lead expanding the member's procedure, role chips, the participant line with workers) — Q13.
- Model group created at admission with a host description; a group picker on the member page (B19) and Settings > Members.
- Memory candidates from the 1:1 conversation (B18 `Memory candidate: … Keep / Remove`).
- The Representative's repeat trigger that calls `propose-member` with `handoff`.
- Archive (and refusing an archived member at assignment).
- `@name` completion and avatar state marks.
- Unread marks for Works not in the shown segment use the same seen store but are computed from list labels only.

## Verification

- `tests/member-work.test.ts`: v1/v2 parsing, assignment and lineage, unknown-member refusal, group routing and grants, different/same-family checks, group-change replay and drain, cached member routing, steering interruption and unknown outcomes, HTTP reads, durable end times and B21 handoff.
- `tests/member-work-surface.test.ts`: host-list sidebar and activity, off-segment room links, feed replacement, delayed responses, polling without events, member identity, duration and steering tags. Existing surface fixtures now serve the host list.
- Checked the actual workbench HTML in Aside with loopback fixture responses: member sidebar and card, activity, `Worked for 4 min`, member-thread steering and B21 rows. This is fixture UI evidence, not a real-provider or durable-database run.
- Node 24.21.0: typecheck and runtime syntax checks pass. The full suite with four concurrent files retains the brief's known macOS failure, `portable inventory order is stable across English and Turkish process locales` (`directory realpath mismatch`). Environment-gated database/integration tests remain skipped.
- An unrestricted parallel run also hit `deadline during final acceptance acknowledgment preserves committed Record`; the runtime lifetime file passed separately, and the four-file full run did not reproduce it. No timeout or assertion was weakened.
