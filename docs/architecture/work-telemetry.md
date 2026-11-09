# Work step and check telemetry (R-A)

Expose actual procedure steps, host times and independently validated check
predicates in the existing Work room. Reuse Q13 team planning, Q14 room turns,
the application journal and the current Mission/Work read boundary.

New commands record a versioned host time observation (`telemetryVersion: 1`).
Replay without that version preserves historical snapshots exactly. `Work.admittedAt`
records handoff/criteria pinning; `Task.startedAt` records effect admission and
`Task.endedAt` records settlement (a skipped step has no start). `Verdict.checkedAt`
records verification. Steering and owner/room messages carry `at`. No client or
model supplies these times. A repeated command returns its original snapshot.
Revised attempts clear current task times; historical operations remain intact.

The configured independent checker already returns `checks`. Preserve validated
`{criterion, passed, quote, reason}` items as `Verdict.predicates`, bound to the
same artifact and criteria. Invalid responses remain failed without fabricated
predicates. The existing accepted Record carries the exact verdict. Team names,
dependencies, skips and result text continue to come from pinned procedures and
the host-validated plan, never from inferred progress strings.

## Implementation and verification plan

- [x] Extend runtime/application tests first for host times, predicates, original
  replay, unknown outcomes, and journal restore; watch the new assertions fail.
- [x] Extend domain/application, room/conversation validation and backup shapes;
  keep ownerStore, CAS/idempotency and no-resend behavior unchanged.
- [x] Render times/predicates and Work-bound messages in B7/B8/B18/B22 using existing
  copy keys and components. Test feed replacement, timer expiry and late responses.
- [x] Regenerate affected fixtures from command producers, run scoped headless
  flows and remove only allow-list entries demonstrated resolved by the gate.
- [x] Run typecheck and related tests.

Publish one PR and run the CI/Codex review loop (at most four rounds). No merge
or real providers/payments. Head-specific receipts remain on the PR.

## Limits

No browser/page/file-read counters, payment/order data, arbitrary business oracle,
new owner command, or steering continuation. Full prototype parity remains open
where these independent producers are absent. Historical missing times stay absent.
One role/procedure text field does not establish an external business fact.

## Core evidence

The new application/runtime assertions first failed on absent admission, task and
message times. With the implementation, 67 related core tests passed (nine
environment-gated skips). The member/product/admission regression batch passed
82 tests (four skips); the final runtime/predicate batch passed 27 (three skips).
The batches overlap and are not an aggregate count. Tests use deterministic
command fixtures and credential-free loopback mocks, never real providers.

Journal replay validates the optional new fields and rejects a modified message
time. Existing expiry admission clocks retain their exact validation context.
Accepted verdicts and room transcripts retain original timestamps after replay;
legacy journals without the telemetry version produce no new fields. Room drain
leaves the interrupted step unfinished and never records a late message/check.

Final integrated local batch: 216 tests, 205 passed, 11 environment-gated skips,
zero failures; typecheck passed. Twelve affected screens in both themes were
recaptured after the final UI changes. The scoped diagnostic gate reports zero
new, stale or infrastructure diagnostics after removing 94 resolved occurrences
and remapping 30 existing residuals. Eight room interaction flows passed.
[Screen evidence and remaining limitations](../acceptance/work-telemetry/README.md).

## Visual gate correction (2026-11-10)

The review found that the room evidence driver injected an unrelated challenge
transcript and that selected room fixtures lacked observations. Replace that
injection with actual command-produced selected Work states. Keep R-E's PR/file
view and R-D's memory proposal outside this change; the pricing table remains a
separate unsupported producer.

Add bounded assigned-worker progress observations (`Task.progress`: done, total,
host time and optional literal detail), using the existing command/CAS/journal
boundary. Runtime worker calls report their actual one-call progress; tool hosts
may report finer units without granting execution or acceptance. Retain the
actual worker instruction in the validated plan. Worker instruction/result
messages project from that plan and Task start/end, not fabricated room turns.

An optional `stepNote` on the existing owner Work message names an exact step and
a proposed procedure title. It is discussion awaiting checking, never adoption,
current-plan mutation or a new decision kind. Existing ownerStore/drain and
conversation provenance rules apply. The pane and chat show its recorded time.

Verify row status/time/count, skipped and waiting states, note rows, participant
chips, duration, and direction-labelled worker messages against the supplied
B18/B22 artboards, in both themes and mobile. New data gets boundary/replay tests;
the existing delayed-read and feed tests cover the new projections. Recapture
without synthetic challenge injection, remove newly resolved allowances and run
the PR's CI/current-head Codex loop again.
