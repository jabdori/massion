# Member page producers (R-J)

The member page reads stored identity bindings, never guesses from a name,
source string or Mission membership. Existing aggregates retain CAS, exact
command receipts, unknown/no-resend and legacy journal replay.

## Builtin skill provenance

The existing owner skills endpoint accepts `{commandId, action: 'builtin',
memberId, builtinId}`. The fixed host catalog currently contains `read-sources`,
`summarize-evidence`, `read-code` and `run-tests`. The service resolves its name and
body, validates the admitted active member and records a normal `write-skill`
with optional `{builtin: {id, version}}`. The reducer checks the exact catalog
body and provenance. The stored version retains its ordinary body hash, owner
and timestamp. An owner edit is a distinct ordinary version without builtin
provenance; adoption checks and owner-replacement decisions remain unchanged.

`MembersService.read()` exposes `builtinSkills` from currently active stored skill
versions, including catalog identity/version and body hash. The skills reader
also exposes the optional provenance. A matching name alone is never provenance.
Older writes omit the field and replay unchanged. Catalog version 1 remains an
immutable definition; a changed builtin requires retaining the old definition.
These instruction skills do not create tools or permission grants. The existing
runtime's procedure loading and independent checks remain authoritative.

## Saved member memory

The existing member candidate journal already retains member, exact segment,
turn, immutable proposal and save intent. Reuse it instead of adding a second
binding or changing old save-command fingerprints. Reads follow each saving
candidate's original Mission, compare the exact current effective memory bytes
with `candidateMemory`, and require the original save operation receipt. Proposed,
discarded, definitely failed and unresolved saves never become saved memory.
A copied source string or unrelated same-Mission memory establishes no binding.

Each projected memory includes the original Mission/revision, exact version,
source segment/turn and owner message time. The source link opens that member's
original segment. Delete uses existing explicit-memory retirement and the read
Mission revision: applicability ends, journal/history remain. Old intake Missions
are discovered from candidate pins. Every read fences database feed replacement,
including replacement during receipt lookup; no projection cache survives it.

## Member schedules

Schedule creation accepts optional immutable `memberId` through the existing
endpoint and cumulative run budget. Only an active admitted member can receive
one. Morning briefings stay Representative-only. Owner create/start uses the
drain-aware store; original identities replay before checking current membership.
Archived members receive no fresh manual or timed dispatch, including budget-skip
writes, while an already-started run retains its original outcome.

The existing Representative producer calls `AssistantService.send` with a
host-only second argument naming the member. Before settlement the host binds any
Work proposal to that exact active member's name; the normal Work admission,
member group, independent checker and budgets still apply. A direct answer makes
no completed scheduled Work. The producer verifies the resulting Work's stored
member ID; mismatched or uncertain results remain unknown, with no resend.

Notifications and exceptions belong only to the schedule's member conversation.
The original Work admission remains in the Representative thread. Optional
`sourceThread` on the finished run keeps these identities distinct, even when the
two threads share a segment number. Past-run links open the actual source thread.
Member reads expose bound schedules and count both active and paused schedules.
The existing schedule form lets the owner select an admitted member.

## Client and fixture evidence

Use existing settings cards, inline source links and switches. Every new member
control captures feed, selection, epoch and the exact loaded member object;
stale controls cannot write. Existing lifecycle request locks prevent overlapping
writes and resend after a lost reply. Late replies cannot select another member.

`member-page-fixtures.ts` supplies real builtin writes, candidate/save commands and
member schedule creates to the existing member lifecycle fixture. Journal replay
is validated before unrelated recorded background snapshots are imported. B19
and B19-juno retain their other recorded improvements and app bindings. Twenty-two
resolved member-producer allow-list entries are removed; other areas remain.

Verification uses Node 24 with `TMPDIR=/private/tmp`: focused reducer, service,
HTTP, client and fixture tests; portable backup export/parse and fresh-store
reconstruction; static types. CI runs the full suite and actual durable-store
checks. Headless B19/B19-juno dark/light checks pass all required elements and
measured visual checks. The live fixture host verifies schedule pause/resume,
member-selected creation, original memory conversation and retirement.

Local evidence: `.runtime/member-producers-final/report.md`,
`.runtime/member-producers-final/pairs/{dark,light}/{B19,B19-juno}.png`,
`.runtime/member-producers/live-paused.png`, `live-created-schedule.png`,
`live-memory-source.png` and `live-memory-retired.png`.
No real providers, models, payments or credentials are used. Connection repair,
devices, learned-memory adoption and executable builtin tools are outside R-J.
