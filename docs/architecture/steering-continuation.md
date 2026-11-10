# Confirmed steering during procedure execution

## Design (R-F)

Continue the same Work when its owner confirms a direction while the pinned text
procedure is still planning or running worker steps. The final assembly and its
independent check must receive the current owner instructions. Completed calls
and their receipts remain immutable; in-flight text workers finish once, and
later steps consume the updated instructions. Earlier results are inputs, never
proof that the changed request is satisfied. No procedure is silently edited.

New configured team runs opt into this contract with `steeringVersion: 1`.
Legacy runs retain their stopping behavior. The existing `steer` command records
the instruction, its host time and the new input binding atomically. It keeps an
eligible Work active without recording an end time. Continuation is refused once
final assembly has been admitted, or when blocked, cancelled, expired, recovered,
unknown, or budget-paused. Those cases retain the existing waiting/interruption
path; no new command, endpoint, permission or retry decision is introduced.

Every provider admission binds its actual prompt to the current input hash in the
same domain transition as the effect intent. A concurrent steer therefore cannot
admit an obsolete assembly/check. Revision conflicts before intent may refresh
that data; an ambiguous or previously admitted effect is never reissued. The
original dispatch ownership, deadline, total budget and provider claims survive.
A restarted host reads the journal and refuses to reclaim an admitted run; this
slice does not introduce a recovery scheduler or replay uncertain calls.

The existing conversation system link and Work pane project stored confirmation,
steps and telemetry. Fixtures must obtain confirmation through AssistantService
and continued Work through real application/runtime commands. Only proven screen
allowances are removed; later-stage steering and unrelated screen gaps remain.

## Implementation plan

- [ ] Add failing runtime tests for owner steering during a worker, duplicate
  confirmation, admission races, late steering, unknown effects and journal replay.
- [ ] Extend domain/run validation and backup lineage; preserve legacy journals.
- [ ] Bind fresh runtime prompts and owner interruption decisions to committed
  state. Reuse ownerStore and existing feed/request-generation UI guards.
- [ ] Produce confirmed active/settled fixtures and run scoped headless screen
  flows; remove exact resolved allowances and record the count.
- [ ] Run related tests and typecheck. Push the PR and resolve CI/Codex findings
  on the current head (up to four rounds). Do not merge.

## Scope

Own steering domain/application behavior, configured text runtime, confirmation
integration, lineage tests and affected screen producers. Do not change connection,
app/member lifecycle settings, browser runtime, app-frame behavior, procedure
editing or unrelated telemetry. No real model/network execution is required.
