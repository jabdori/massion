# Members: admission, identity and 1:1 conversations

- Status: implemented (first increment: admission decision, member identity, one 1:1 conversation per member, sidebar list, Work room participants).
- Date: 2026-11-06, above `feat/v3-shell-2`
- Decisions: [ADR 0003](decisions/0003-members-internal-teams-model-groups-and-apps.md) §1, §2, §3 and §8, implementation order item 7; [ADR 0002](decisions/0002-assistant-first-surface-and-independent-checks.md) §5 (first kind of decision). Screens: experience plan v3.1, prototype artboards B21 (admission decision card), B21-name (name and look), B18 (member 1:1 conversation) and B7 (Work room).
- Builds on: [Surface skeleton 2](conversation-cards.md) (decision cards and `POST /assistant/decisions`), [Assistant conversation](assistant-conversation.md) (segments and the turn path), [Family map and model groups](family-map-and-model-groups.md) (`chooseGroupModel`).

## Problem

The organization is the Representative alone. ADR 0003 adds named members: the owner admits one through a decision card, gives it only a name and a look, and then talks to it in its own 1:1 conversation from the sidebar. Surface skeleton 2 drew decision cards but no host produced or answered one.

## Members aggregate

One aggregate `assistant-conversation:members` (kind `members`) beside Missions and conversation segments. It holds members and admission decisions, nothing else.

```ts
interface Member {id; name; look: {shape, color}; home: 'members/<id>'; modelGroup: 'default'; skills: []; procedures: []; decisionId; admittedAt}
interface MemberDecision {id; at; topic; works: {title}[]; count; modelGroup: 'default'; state: 'open' | 'later' | 'done'; answeredAt?; memberId?}
```

- **Identity lives in the member**: name, look, the home folder that will hold its memory, skills and procedures (empty slots now), and the model group it routes through. The home path is a name only; nothing is written to disk.
- **Context lives in the Work.** A member holds no Work state. Concurrent requests to one member will run as separate teams, one per Work, never sharing context (ADR 0003 §2); the Work path for members is a follow-up, so today every Work is still the Representative's.
- Bounds: at most 32 members and 32 open or deferred decisions (done decisions are bounded by the member count; 32 deferrals still block later proposals until pruning exists); names are 1–32 characters on one line, unique ignoring case (locale-free folding), and never the Representative's name. Eight shapes (`round`, `square`, `drop`, `hex`, `diamond`, `cloud`, `clover`, `tri`). The host gives the colour, `agent-1` to `agent-7` of the design tokens in admission order.

### Commands

| Command | Actor | Rule |
|---|---|---|
| `propose-member {decisionId, topic, works, count}` | Representative (host step) | Only one decision open at a time. A topic deferred with Later is not proposed again for 30 days (compared ignoring case). |
| `defer-member {decisionId}` | Owner | `open` → `later` |
| `reopen-member {decisionId}` | Owner (`Ask again`) | `later` → `open`, only while no other decision is open |
| `admit-member {decisionId, memberId, name, shape}` | Owner | `open` → `done`; creates the member. There is no other way to create one (ADR 0003 invariant 2). |

There is no autonomy setting and no automatic admission: `act` without a name and a shape is refused.

Lineage checks where each ID came from: a proposal's command ID is the host's (`assistant-member-proposal:<hash of topic and Work IDs>`) and its decision ID is derived from it; an owner answer never carries that prefix, and an admission's member ID is derived from the answer's command ID. A backup therefore cannot pass off a caller's command as the Representative's proposal.

### Producer

`MembersService.propose({topic, workIds})` is the host-only step the Representative uses; there is no HTTP route, so no caller can write a Representative proposal. The same topic over the same Works is one proposal: asking again replays it. The host, not the caller, writes the rows: each named Work must be a Representative-made Work (it has an assistant source) in the Representative's intake Mission whose run started in the current calendar month (host time, UTC), at least two of them. The card says the count and up to two titles. When the Representative should call it (the "same kind repeats" trigger) is a follow-up: today only tests and the host call it.

## Decision card

The conversation read adds `decisions` in the shape fixed by [conversation-cards.md](conversation-cards.md):

```
{id, at, title: topic, question: '<topic> came up <n> times this month. Add a member for it?', rows: [['This month', '<title> · <title> and <k> more'], ['Model group', 'Default']], action: 'Add member', form: 'member', state, line?: 'Added: <name>'}
```

- `form: 'member'` is the one addition to the card shape: the client asks for a name and a shape before it sends `act`.
- `POST /assistant/decisions {commandId, decisionId, answer}`: `later` defers, `ask` reopens, `act` must carry exactly `member: {name, shape}` and admits; a colour or any other field is refused. The member ID is derived from the command ID, so a replayed answer admits once.
- **Add member** opens the name-and-look dialog (B21-name): a preview avatar, the name field, the eight shapes, Cancel and Create. Create sends `act`. Cancel sends nothing; the card stays open.

## Member 1:1 conversation

- Each member has exactly one conversation: the same segment aggregate and reducer as the Representative's, under its own prefix `assistant-conversation:member:<memberId>:<n>`. No new storage form, and no "new chat". Store command IDs are global, so a member thread's segment close is `assistant-close:member:<memberId>:<n>`.
- The members aggregate is `assistant-conversation:members`: under the reserved prefix, so no Mission can take the ID and Mission routes refuse it. Lineage and portable backup replay it; it holds no artifacts.
- `GET /assistant/conversation?member=<id>` and `POST /assistant/messages` with `member` reach it. A turn routes through `chooseGroupModel(member.modelGroup)` with the Representative's output cap; the request names the member as data, never as instruction text.
- A member reply is a conversation reply. A Work proposal in a member's reply is dropped before settle: member Work, steering a running Work and memory candidates from this conversation are follow-ups.
- Lineage replays member segments like the Representative's; the thread comes from the aggregate ID.

## Surface

- **Sidebar**: the Representative, then members in admission order, each a button with its look as avatar and its name. Selecting one opens its conversation in the page; the header shows its avatar and name (the Representative's too); the input says `Message <name>`.
- **Work room participants**: a Work tab shows one participant line above the detail: the Representative avatar and name, and `Check` last (B7: a Work the Representative holds alone has no role chip).
- **Sidebar while a member conversation is open**: the Representative's Work lines and the activity list keep the Representative conversation's last read, so open decisions still lead.
- **Admission**: `Add member` on the yellow card opens the `New member` dialog (B21-name): the shape preview with the name's first letter in the colour the host will give, the name field, eight shape buttons as a radio group, `Cancel` and `Create`. Escape and the close button cancel. A refused Create (taken or invalid name) committed nothing: the dialog stays with its input and marks the name invalid; nothing is resent.
- No titles, no explanation sentences, labels stay in the surface's English. Yellow stays only in the decision card.

## Invariants

1. A member exists only after the owner's `admit-member` on an open decision.
2. Only one admission decision is open at a time; a deferred topic waits 30 days.
3. The producer of a member reply never judges anything; a member conversation admits no Work.
4. Each member has exactly one conversation thread, keyed by its ID.

## Not in this increment

- The Representative's trigger for proposing (repeat detection) and calling the producer step.
- The B21 card's row for the Work to hand the new member.
- Member Work: assigning Work to a member, a team per Work with role chips, Work lines under members in the sidebar, steering a running Work from the 1:1 conversation, memory candidates.
- A model group created at admission with a host description (ADR 0003 §3); members use the default group.
- Archive, merge, rename. (Settings > Members and the member page with skills and procedures came with [settings](settings.md) and [self-made skills](self-made-skills.md); the `skills` and `procedures` slots on a member stay empty, the skills aggregate holds them.)
- Avatar state marks (working dots, unread dot) and `@name` completion.
- Organization version (ORG-01) widened to members; Work pins it.
- `Undo` on a decided line.
