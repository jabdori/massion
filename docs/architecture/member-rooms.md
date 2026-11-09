# Member rooms: bounded challenge before independent checking

Q14 implements the first vertical slice of ADR 0004 on Q13 teams. The existing
runtime authorizes one member's producing model and one independent checker.
A multi-step team now publishes its first artifact, assigns a separate challenger
outside that producing subtree, records a quote-grounded challenge, and asks the
producer to answer with counter-evidence or concede. The challenger never gets
the producer's rationale. Both turns are durable provider effects with existing
claims, reservations, drain fencing and unknown-outcome handling. The checker
receives the issue as an unresolved criterion note; agreement never accepts Work.

The host retains the exact artifact text/hash, assignments, ordered transcript,
reply references and inferred flags in Work and accepted Record provenance.
Malformed or ungrounded challenges are retained as returned, never admitted as
issues. Answers cannot resolve their own issues; this bounded round escalates
them to the independent checking seat. There is one artifact and at most three
room messages, below ADR caps; no repeated debate, rewrite or effect replay.
Owner messages, pause and stop retain their existing paths and authority.

Reuse Q15's discriminator service between turns in shadow mode. Host-assembled
features and bounded author-labelled quotes are recorded with Q15's identity,
threshold, budget and timeout rules. No moderation result changes acceptance.
Absent configuration or budget uses fixed rules. No new public owner write API.

Implementation order: failing core/runtime tests; room transitions and backup
validation; runtime/host integration; existing conversation transcript rendering;
related tests and typecheck; scoped headless screen evidence; PR without merge.
Four regression risks: overlapping duplicate commands, drain-aware writes,
stale/feed-replaced Work data, and out-of-order read responses.

Follow-up: multi-member admission/routing and model-group challenger selection,
artifact revision leases, two-round issue negotiation and withdrawals, general
board-based turn scheduling/stall replanning, all four complete prototype screen
contracts, and equal-cost real-model evaluation/calibration. These require a
wider pinned organization/authorization contract; this change does not invent an
owner API or silently authorize another member's model. Same-model challenge is
explicitly recorded and is not an independent check or a quality claim. Full
suite and all screen contracts run in CI; no live model calls in unit tests.

## Budget and compatibility

New multi-step member Work budgets include two additional producing-model calls.
The admitted runtime pins `roomVersion: 1`; replay of earlier activation commands
keeps Q13's original call budget. Historical Work and Records are not rewritten.
A queued old Work with too little budget refuses preflight until the owner uses
the existing budget decision. The default text budget does not reserve shadow
calls: a configured discriminator runs only with additional available Work
budget. Q15's per-call reservation is 4,096 output tokens; this integration also
leaves room for every remaining challenge/reply/check call. No budget or grant
is widened by the discriminator. A model already assigned to a room participant
or its checker cannot fill this moderation slot.

## Verification

Node 24.21.0: typecheck passed; related tests passed 282 of 297, with 15 existing
environment-gated skips and no failures. Tests exercise actual application and
runtime transitions with mock transports, replay the journal including accepted
room provenance, and cover unknown challenge outcomes, drain, duplicate commands,
quote normalization, return/escalation, moderator identity and budget isolation.
The room/conversation tests cover literal rendering, current selection, feed replacement
and late reads; existing team tests cover deadline refresh without an event.
No real model call, full local suite, deployment or merge was performed.

Eight headless screen flows passed transcript, pane toggle, mobile overflow and
close assertions. Full prototype contracts remain failing (per theme): B18 4,
B18-room-b 40, B22-room 13, B22-room-steps 18, including pane text budgets. These
are recorded failures, not a claim of prototype parity. See
[screen evidence](../acceptance/q14-ui/README.md). The complete suite and complete
screen catalog remain CI-owned per the brief's verification budget.

After integrating main `094eca4` (desktop daemon authentication), typecheck passed
again and the affected member/runtime/fixture batch passed 100 of 103 tests,
with three environment-gated skips. The eight headless screen flows passed again
with the same recorded prototype-contract failures; screenshots were regenerated.

## Visual review correction

The initial B22-room-steps fixture opened the legacy evidence inspector. That
was not the artboard's steps view. The corrected fixture opens only the B7 Work
room pane; stored worker steps are followed by independent checking and Record
stages. B18-room-b and B22-room use the same component and real task fields.
Room transcript and collapsed moderation records now render in the conversation,
bound to the selected Work, current member thread, feed and current snapshot.
Switching Work, selecting an app tab, replacing the feed or losing a read removes
the old transcript. The Work pane never embeds the legacy state/attempt/budget
inspector. Deliberate accepted/rejected text readers and unknown-run quarantine
controls remain available without that state dump.

Review tests on Node 24.21.0: 146 total, 141 passed, five environment-gated skips;
typecheck passed. Eight dark/light room flows passed the explicit visual blocker
assertions: no transcript or legacy technical fields in the pane, B22 steps
exactly Read / Run tests / Check / Record, transcript in the conversation, Stop
present, pane toggle/close and mobile overflow. The pane text-budget checks now
have zero failures. Full contracts still have 4 / 40 / 13 / 13 failures per theme
for B18 / B18-room-b / B22-room / B22-room-steps respectively; those are broader
shell/data/order differences, not claimed as passing.

The existing Codex finding about surrogate-pair truncation was also reproduced:
moderation quotes now drop a trailing high surrogate at the bound, preserving
well-formed Unicode so shadow moderation cannot block a valid emoji-containing
turn before independent checking.

The B7/B8/B22 pane regression additionally passed all 20 headless dark/light
flows. Changed surface files have zero blocking copy-lint findings.

## Main integration and execution-selection repair

Merged origin/main `1d0d1e3` without rebasing or rewriting history. Conflict
resolution retains both the room runtime version/budget and main's tool-timeout
policy pin, validates both on restore, and preserves launcher and discriminator
imports. The existing member Work test now asserts both pins and replays its
journal.

The B7 pane now carries the existing execution-selection details node after the
step/detail content and before the check bar. It remains collapsed initially;
its original form identity, draft, handlers and stale-revision guards are retained.
A fresh queued Work can choose producing/checking connections, authorization and
output cap, check the selection, and explicitly run. Started or accepted Work
still has no selection form. The legacy evidence inspector is not restored.

Node 24.21.0: 195 related tests, 186 passed, nine environment-gated skips, zero
failures; typecheck passed. The new client-to-HTTP room variant failed before the
fix, then exercised preflight without a provider call, exact selected execution,
independent acceptance, reload and no replay using loopback mocks. Two headless
theme flows checked collapsed placement, populated controls and 1440/390px
visibility/overflow. See `verify-room-selection.mjs` and selection evidence.
