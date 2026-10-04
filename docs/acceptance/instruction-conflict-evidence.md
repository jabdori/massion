# Owner-instruction conflict comparison

## User outcome and boundary

Two already authorized clients of one loopback host can compare an unrecorded
Work direction with the authoritative direction and deliberately submit against
its current revision. This is the existing #4/SUR-01 owner/Work contract, not a
new shared conversation, identity system, approval policy or network listener.
The canonical owner instruction remains a durable Work input. The unrecorded
submission and editable draft remain volatile and private to the open client.

## Acceptance

- Same-revision submissions commit one direction and reject the other. The losing
  client shows its submitted text, attempted revision, latest canonical instruction
  and current snapshot revision while preserving an editable draft.
- Repeated conflicts preserve edited drafts and refresh the comparison. No extra
  POST occurs before a deliberate current-revision submission; the new submission
  uses one new command identity and does not replay an earlier operation.
- Actual HTTP clients with separate storage preserve separate Work drafts across
  conflict and host restart. While disconnected writes remain locked. Another
  client commits a direction; reconnect refreshes canonical state with no POST.
- Cancelled Work shows its retained conflict/draft read-only; detached earlier
  controls cannot submit. Fresh clients read identical committed history, with no
  private rejected draft or write. No effect or model call is admitted.
- A same-Work-ID/different-Mission regression prevents draft/comparison leakage.

## Reproduction

Use pinned Node 24.19.0, strict TypeScript and SurrealDB 3.3.0. The affected suite
is `tests/workbench.test.ts` and `tests/client-workbench.test.ts`; run the latter
with a disposable initialized database through `scripts/with-surreal.py`.
Actual database coverage must have no skips. Remote CI and independent review
must name the exact published HEAD; historical PR #12 results do not establish
this increment's completion.

## Local candidate evidence

Pinned strict TypeScript passed. The affected suite with actual SurrealDB 3.3.0
passed 45/45, zero failures/skips. The same-revision conflict comparison initially
failed its scope regression because snapshot installation skipped rendering when
the revision was unchanged; the conflict path now explicitly rebuilds the view
after successful authoritative read. This was corrected before publication.
Final-head remote CI and independent review are separate pending gates.

## Remaining product decisions

The charter separates conversation, Work, Task, Agent and execution session.
Whether lightweight conversation can exist without Work, how a conversation links
to Work, message identity/history/retention and authenticated remote-PC access
remain undecided here. Browser visual/accessibility conformance, general live
model quality, permanent approvals and flexible bot collaboration remain open.
