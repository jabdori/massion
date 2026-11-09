# Member Work: handing Work to a member

- Status: implemented with fixture-class evidence (first increment: assignment, member model group routing, steering from the 1:1 conversation, host Work list, durable end time).
- Date: 2026-11-08, above `main` (#95)
- Decisions: [ADR 0003](decisions/0003-members-internal-teams-model-groups-and-apps.md) §1, §2, §3 and §6; [ADR 0002](decisions/0002-assistant-first-surface-and-independent-checks.md) §5 and §8. Screens: prototype artboards B2 (card with the member who holds it), B11 (steering line), B18 (steering system line only; in-thread Work cards are follow-up), B21 (decision card with the Work to hand, collapsed "Worked for N min" line).
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
- When automatic start is deferred, selection-less manual preflight, Start and each Work in a run sequence re-resolve the pinned member’s current model group through the same host group selector. A missing member or missing group authorization refuses the start; no default execution route substitutes for an unauthorized group. An explicitly supplied owner selection keeps its existing behavior.
- Groups reserved for the discriminator cannot produce member conversation text or execute/check Work; they are excluded from checker fallback.
- The default route sets the per-call cap. An existing grant for the Mission scope must cover both selected models at that cap. Without one, admission is refused with `member_grant_missing`; the host never creates or widens a grant. The admitted Work still passes the full preflight.
- The owner sets a member's group (`set-member-group`, owner setting, ADR 0003 §3). The group must exist inside the connection settings write fence. If a referenced group is later removed, future conversations and Works use the default group; existing run pins do not change. `POST /members/group {commandId, memberId, modelGroup}` is currently the host/test seam for routing; no group picker is delivered in Q12.

## Steering from a member's 1:1 conversation

- A member turn's request carries `works: [{id, title}]`: the member's eight newest actively running Works (`runtimeRun` present and `execution: active`). The member model may name one in `steer`.
- The member model may only propose a target from the active Work list. The answered turn records `steer: {missionId, workId, status: proposed}`. Model output and conversation reads never write an instruction or interrupt a run.
- A gray line offers `Apply to <title>`. This explicit owner action posts `POST /assistant/steering {member, segment, turnId}` with the current feed. The host derives the exact original owner message and proposed target from the stored turn; the caller cannot supply replacement text or a different target.
- Confirmation rechecks that the Work is actively running and assigned to this member. An owner-only segment command records the confirmed intent and the current Work revision through the drain-aware owner store. Only its fresh commit permits one existing `steer` command, also through that store, followed by local interruption on confirmed success.
- Before posting, the client stores a pending confirmation receipt bound to feed, member, segment and turn; a browser reload cannot offer Apply again while that receipt remains unresolved. The host also retains uncertain attempts for its session, so an invisible confirmation receipt is not interpreted as permission to send again.
- The confirmation command is deterministic per turn. Overlapping confirmations replay; an uncertain confirmation or steering write is never resent. Outcome recording and read-only operation reconciliation survive deadlines/crashes. A newly confirmed steering receipt can interrupt its still-owned local run only when the intent has explicit owner provenance. Legacy unconfirmed intents remain historical data, not permission for a new interruption.
- The line becomes `Steered: <title>` after success or `Result unknown: <title>` with read-only Check while uncertain. Stopped Work needs attention and is not a running sidebar line or a reason to keep polling. No automatic resume path is added.

## Host Work list

`GET /assistant/works` → `{feedId, works: [...]}`: conversation Works in the current intake Mission and the Missions pinned by the latest 32 Representative segments, newest admission first, at most 200.

```
{missionId, missionRevision, workId, title, memberId: string|null, execution, acceptance, unknown, started, startedAt, endedAt, turnId, segment}
```

- The sidebar's Work lines (the Representative's and each member's) and the activity list read this list, not the shown conversation segment, so Works from earlier segments and member Works appear while any conversation is open.
- The global Work list keeps its own request sequence, independent of conversation/thread generations: a slower earlier answer never replaces a newer one, and switching threads cannot discard a valid same-feed Work list. A changed `feedId` replaces the whole list. While any listed Work runs, the list is read again with the conversation's minute timer, so a Work that ends without an event still leaves the lines.

## Durable end time

- `Work.endedAt`: the host time recorded by the command that ended or stopped it (`verify`, `accept`, `cancel`, `block-work`, `quarantine-runtime`, running `steer`, and runtime deadline/shutdown/owner closures). The first end at or after the current run start is preserved; later cancellation or quarantine does not extend the duration. The time and `workEndVersion: 2` are event context. Unversioned end-time events replay the original overwrite rule, and journals without time still replay unchanged.
- The collapsed line says `Worked for N min ›` (N = whole minutes from run start to end, at least 1). Without an end time it stays `Worked ›`.

## Decision card

- `propose-member` may carry `handoff`, one line: the Work to hand the new member. The card shows it as the row `Work to hand` (B21).

## Invariants

1. A Work is assigned only to a member that exists when it is admitted; the host never reassigns.
2. The producer never judges: a member Work keeps distinct executor and checker identities and its family relation is pinned as before.
3. Steering records the owner's exact words only after explicit owner target confirmation; a model reply alone never authorizes an instruction or interruption.
4. A steer or admission whose outcome is unknown is never resent.
5. Owner writes (`set-member-group`, steering) go through the drain-aware owner store.

## Not in this increment (follow-up)

- Representative handoff notification lines and Work cards inside the member 1:1 thread (the remaining B18 scope).
- Internal teams now expand pinned member procedures into worker steps; see [Internal teams](internal-teams.md) (Q13). Room messages and mutual challenge remain Q14.
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
- Node 24.21.0, physical macOS `TMPDIR`: typecheck and runtime syntax checks pass. Full suite (`node --test --test-concurrency=4 tests/*.test.ts`): 1,651 tests, 1,310 passed, 340 environment-gated tests skipped, and the brief's known failure `portable inventory order is stable across English and Turkish process locales` (`directory realpath mismatch`).
- Review regressions cover stopped active runs over HTTP, ineligible queued Work, a deadline crossing the steering commit, a crash before the outcome record, confirmed/unconfirmed lost acknowledgments, another host changing intake during a run, removed groups and concurrent group writes, closure timestamps, gray steering lines and missing member identities.

## PR #96 review repair scope

Findings 1–3 retain requested steering with active-only eligibility, durable intent and read-only outcome reconciliation, and attention rather than running display. Findings 5/9 reuse gray system lines and show no invented member identity. Findings 6–8 retain old intake pins, use the default group after removal, fence member-group validation, and preserve the actual run end. Finding 4 is explicitly deferred above. Finding 10 retains steering and the B21 `Work to hand` field because the Q12 request explicitly includes both; repeat detection and a group picker remain follow-up, with no claim that these producers/screens exist.

## Owner confirmation and sequence review verification

- Selection-less run sequences resolve the implicit route separately for each Work, through the same member-aware resolver as Start. Explicit owner selections and the original configuration/freshness/no-replay guards remain intact.
- The model only proposes steering. Tests verify no instruction or interruption before owner confirmation, exact stored-message/target binding, duplicate confirmation races, stale feeds, host drain, unobservable receipts, browser reloads and detached/late UI events.
- `agent-desktop` ran the required `scratchpad/ui/verify.sh` with a loopback fixture, then headless semantic clicks in an isolated Chrome app profile. PNGs were opened and compared with prototype B18. Member name/avatar, selected sidebar row, right-aligned owner message and gray system/action line match the established structure; in-thread cards remain the documented follow-up.
- Final screen evidence in `scratchpad/ui/`: `q12-apply-final-check.png` (verify.sh capture), `q12-representative-final.png` (member Work under the Representative view), `q12-member-proposal-final.png` (the same line remains after opening Quill; Apply visible), and `q12-member-applied-final.png` (only the explicit Apply produces Steered and removes the stopped Work from running lines). Corresponding JSON accessibility snapshots retain the actual names and button roles. The fixture recorded exactly one confirmation POST, after the explicit click.

## Round-five outcome and configuration audit

The confirmation path has two owner writes (confirmation intent, then Work steering) and a host outcome record. Only a fresh, committed intent authorizes the Work write. The audit applies these rules at each boundary:

| Result | Owner intent | Work steering / outcome read | Client receipt |
|---|---|---|---|
| Committed | Apply once | Recorded; interrupt the owned run | Clear after a known recorded result |
| Definite conflict or validation/drain refusal | Release the attempt; expose a known refusal or the already-stored result | Not recorded; never interrupt | Clear the refused attempt; a refreshed proposal needs another explicit click |
| Idempotent replay | Read only; never apply from replay | Reuse the exact stored result | Follow the stored result |
| Unknown, including a lost receipt | Retain pending; read only | One read-only reconciliation; unresolved stays unknown | Persist pending and offer Check only |

Outcome-record failure cannot erase an already known Work result in the current host session. Restart uses the durable intent and exact operation identity; absence alone never proves a lost write failed. The shared segment dispatcher must recheck command identity after loading and replay a stored result on an idempotency conflict, just as Mission commands do.

The configuration audit covers implicit and explicit preflight/Start, every sequence stage, group definition edits/removal and member-group reassignment, including changes during asynchronous reads and changes made by another host. A sequence keeps its originally reviewed routing state, including model-group definitions and member assignments; it stops instead of adopting changed models for remaining Work. Single Start must also reject a routing change between its own resolution and admission. Existing grants, family checks, Work/input/revision pins, capacity, drain and no-replay rules remain required.


### Round-five verification and limits

- Confirmation regressions cover fresh commits, definite revision conflicts, exact idempotent replay/readback, unknown receipts before and after storage, proven transaction rollback, outcome-record failure and post-write snapshot failure. A positive receipt is not erased by a later unavailable or stale negative read; only a new database identity discards that local fact.
- `tests/routing-fences.test.ts` covers 34 cases: explicit/implicit sequences under local/remote group edits, removal and member reassignment; preflight/Start/sequence changes during initial reads; late changes at activation; unchanged routes; standalone runtime adapters; and drain. The fence includes model-group definitions, Representative settings and the members aggregate revision and travels through adapters to the final activation check. A sequence never refreshes its original fence between stages. This retains the existing separate-read/CAS model; it is not a new atomic transaction across host settings, members and Work.
- The unrestricted full run also reproduced the existing `deadline during final acceptance acknowledgment preserves committed Record` timeout under parallel load. Its file passed separately (12 passed, 2 skipped); the bounded full suite retained only the known portable-inventory locale failure. No deadline or assertion was weakened.
- The final UI check uses agent-browser headless, session `massion-ef7f7daf3b12`, never a visible Chrome window. The flow opens and cancels the member dialog, opens Quill, retains its Work line, opens/closes the Work pane, observes a definite refusal with a fresh Apply, then explicitly applies again. A separate unknown flow performs one POST and read-only Check. The post-write read-failure flow keeps Steered without exposing Apply/Check.
- Headless PNGs and snapshots are in `scratchpad/ui/`: `q12-r5-before-apply`, `q12-r5-definite-refusal`, `q12-r5-recorded`, `q12-r5-unknown`, `q12-r5-reconciled`, `q12-r5-post-read-failure`, and `q12-r5-work-pane`. PNGs were opened and compared with B18. The canonical full B18 contract remains unmodified and reports 43 differences in `q12-r5-B18-contract.txt`, covering broader Korean copy, fixture scenario and previously deferred surfaces. The owner explicitly kept this PR to the audit scope; those differences are reported separately, not claimed to pass.
