# Member lifecycle

Lost archive/restore responses retain the exact command identity in Settings.
The existing members GET accepts that commandId/action/memberId as an optional
receipt query, checks the original fingerprint without writing, and fences its
feed. Only a confirmed durable receipt clears that member's uncertainty lock;
fresh member state alone never certifies the command. No automatic resend occurs.

Owner archive/unarchive extends the existing members aggregate and command
dispatcher. Admission remains exclusively an answer to an existing decision.
Archive retains identity, home, decisions, Work, Records and conversation segments;
unarchive restores the same identity. Older journal operations omit `archivedAt`
and must replay byte-for-byte, so only archive writes this optional field.

`MembersService.act({commandId, action: 'archive' | 'unarchive', memberId})`
uses the injected drain-aware owner store and the existing load/lookup/CAS loop.
An identical command replays, a reused identity conflicts, and an unknown commit
is never resent. This is an explicit owner action, not automatic inactivity
archiving or a new admission path. Existing Work is neither stopped nor reassigned.

`read()` separates active `members` and `archived`, normalizes missing `archivedAt` to
null, and projects counts and last activity from stored Work and conversation
segments. It follows the current intake and historical Mission pins in the
Representative's conversation, without the UI Work list's 200-row truncation.
Each read checks database feed identity; no activity cache survives a feed change.
`roster()` supplies only active identities to the existing Representative turn and
Work admission path. The host can pass `members: () => members.roster()` to both
Representative and member AssistantService instances instead of using the heavier
`read().members`, which also excludes archived members.
This admission-time roster read does not provide a cross-aggregate transaction
against an archive racing after the roster was read.

Member-bound schedules, builtin skill provenance and exact saved candidate memory
are projected by the [member page producers](member-page-producers.md). Older
records without bindings remain unassociated. Conversation links retain member
identity; archive preserves stored memory, skills, schedules, Work and history.

Verification: focused reducer/service and existing member/Work tests, then static
typecheck, all under Node 24. No external provider, model, payment or secret access.

## Integration

```ts
// Construct with the host's drain-aware owner store.
const members = new MembersService(ownerStore, intakeMissionId);
// GET /assistant/members
await members.read(); // {feedId, revision, members: MemberRead[], archived: MemberRead[], decisions}
// POST /assistant/members; retain the host's caller-command and feed admission checks.
await members.act({commandId, action: 'archive', memberId}); // 'unarchive' restores
// Representative and member AssistantService options:
{members: () => members.roster()}
```

`MemberRead` is exported by `src/members.ts`. Count fields are `workCount`, `completedWorkCount` (accepted Work only),
`openWorkCount`, `unknownWorkCount`, `messageCount` and `scheduleCount`.
`lastActiveAt` is null without recorded Work/message activity. Counts follow
the stored member ID, never the displayed name; unresolved effects remain unknown.
The reader scans retained conversation segments; it is not an indexed projection.

The fixture host can call `memberLifecycleFixture(fixture)` from
`scripts/ui-contracts/member-lifecycle-fixtures.ts` once, after inheritance resolves.
Only B13/B19/B19-juno are transformed. Existing names/shapes are admitted through
real decisions, member references are remapped to derived IDs, and a third member
is archived through `MembersService.act`. Member journal replay is validated.
The source routes, feed envelope, setup metadata and unresolved gaps are retained.
The original Work snapshots lack member source pins, so their member counts stay
zero rather than inheriting unsupported assignments from presentation rows.

## Verification observations

The focused command passes 20 tests, including a failed-before-implementation
lifecycle path and fixture generator:

```sh
/Users/code/.local/share/mise/installs/node/24.21.0/bin/node --test tests/member-lifecycle.test.ts tests/members.test.ts
```

Main's combined Node 24 regression run passed every `tests/member-work.test.ts`
case, including Q13 procedure/worker execution and Q14 member-room/challenge
coverage. Individual passing test names were checked with `rg` in
`/private/tmp/massion-lifecycle-regressions.log`, including the Representative
handoff, member-group routing, deferred Work, Q13 and Q14 cases. This verified
result supersedes the earlier interrupted worker run.

Main has wired the member fixture generator and archived-chat write admission.
No additional tests were run for this documentation-only update. The worker did
not run the full suite or screen contracts.
