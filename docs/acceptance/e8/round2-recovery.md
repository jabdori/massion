# E8: interrupted queued recovery, GLM round 2

Requested HIGH: PR #117 at `f0e0957` could clear the budget pin before runtime activation, then strand a pristine queued Work. A crash after re-reservation additionally lost the decision link and left a reserved entry that every later admission replayed as a conflict.

## Correction

- Match a released/reserved entry to the done decision either through its recorded decision ID or the deterministic monthly run ID. This also recognizes entries written by `f0e0957` without a decision ID.
- Recover only pending, unchanged, budget-paused or queued Work with no runtime, recovery, assignment, artifact, verdict, Record or effect evidence. Reuse the deterministic run ID. Runtime preflight and host capacity are checked before retrying a queued Work; a busy host leaves it recoverable for a later read.
- Atomically advance the pristine Work revision before releasing its stale reservation. An older activation either wins that CAS, in which case recovery does nothing, or loses its original revision and cannot admit effects.
- Bind cleanup to the original reservation's Work revision. A losing activation cannot release a newer reservation generation. Include the Work revision in reservation operation identity so a recovered admission does not collide with the older accepted reservation operation.
- Preserve historical release-command replay through an optional generation field; no public command route or provider retry option is added.

## Regression evidence

| Interruption or race | Check |
| --- | --- |
| After `resume-monthly-budget`, before a runtime attempt | `accepted budget recovery survives interruption after queued and starts its deterministic run once`: startup/first-read recovery accepts the original Work with its deterministic ID; later reads/drain leave exactly two provider-role calls. |
| After re-reservation, before activation | The same test's `reserved` case reproduces an entry with no decision link, then proves recovery and exact-once role calls. |
| The original activation wins the Work CAS | `recovery cannot clear the reservation when an original activation wins its Work CAS fence`: no recovery callback and the original bound remains reserved. |
| Old cleanup arrives after a new reservation | `a losing activation cleanup cannot release a recovered reservation generation`: the newer reservation survives the old revision's cleanup; journal lineage validates. |
| Host occupied during the owner answer | `accepted budget recovery waits for an occupied host and resumes after it becomes idle`: no premature transition while occupied, then both Works accept with four total role calls. This also addresses duplicate Codex finding 4514954085. |

The existing original-unsettled-run test now records an activation before throwing, so it proves that admitted execution is never replayed; a callback error with no persisted activation is intentionally eligible for this new recovery.

The requested two interruptions and the race/cleanup/busy regressions were observed failing before their fixes. Node 24.21.0 with a physical TMPDIR: 12 related files, **278 passed, 12 environment-gated skips, zero failed** (290 tests). Three affected integration files for effects/onboarding passed **51/51**. Combined: **329 passed, 12 skips, zero failed** across 341 tests. The final active-conversation context adjustment passed **5/5**. Typecheck, copy lint (zero findings) and whitespace passed. Six refreshed artboard/application pairs passed **176/176 required occurrences**, with zero contract/geometry/infrastructure failures. These are fixture and loopback HTTP checks, not live-provider or actual-database evidence.

## Integration

Main `ab5c145` was merged without rewriting history. The merge preserves monthly decisions, first-experience controls, payment/external-member decisions, current decision bindings, admission-phase refusals and all host drain participants. No additional independent reviewer was spawned. Full repository checks remain CI-owned.

## Separately reported open findings

These were read from the live PR while processing this requested HIGH and are not claimed fixed in this round:

- 4514954044 and security finding 4514966445: discriminator provider usage and caps missing from monthly accounting/admission.
- 4514954056: owner input changes between reservation and the initial Work pause can block the decision.
- 4514954074: an owner-expired run with no unresolved calls retains an accounting reservation.
- Security finding 4514966451: startup reconciliation must respect restored-journal inertness and require destination reauthorization. The reported restore-authorization blocker remains open.

No PR merge, deployment, live provider call, restore or account/credential change was performed. This correction does not approve the entire PR; the remaining findings still block merge.
