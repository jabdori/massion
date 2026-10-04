# Owner quarantine of interrupted configured Work

## Customer outcome and acceptance (before implementation)

An owner can inspect a stranded configured run, explicitly acknowledge uncertainty,
and permanently quarantine its original Work through the owner interface. A durable
CAS command names the original run and records the owner, reason, and effects that
were pending or unknown. Pending effects become unknown without inventing provider
receipts. Previously settled effects, reservations, artifacts, criteria and run
identity remain unchanged. Unknown usage is never presented as zero.

Acceptance requires regression-first checks for receipt-commit failure, late
callbacks, concurrent owners, wrong run/revision, duplicate command identity,
unknown-outcome persistence, independent acceptance fencing, and fresh-client readback/portable
restoration with actual SurrealDB. The owner-facing control must state that this
is permanent local handling, not proof a provider stopped or resumed completion.

## Deliberate boundary

No successor, replay, automatic reconciliation, fabricated receipt, refund, budget
release or accepted Record is created. An already admitted effect can still execute
remotely; local cancellation is best effort and cannot prove a worker or provider
stopped. Recovery does not settle the unresolved effect or clear its run identity.
Full continuation needs worker ownership/fencing and external outcome evidence and
remains a separate gate. This loopback development API is not production owner
authentication. Only mock/local provider fixtures are authorized for this increment.

## Durable protocol

POST `/missions/:id/commands` with a stable `commandId`, the inspected
`expectedRevision`, and the command fields `type: quarantine-runtime`, `workId`,
original `runId`, a nonblank `reason`, and `acknowledgeUncertainOutcome: true`.
The host derives actor identity and affected effect IDs. Extra command fields,
wrong run IDs, missing acknowledgement, accepted Work, and Work without unresolved
effects reject. Already-cancelled Work with pending/unknown effects is supported.

The transaction atomically journals the command, state and audit event with no
new effect outbox entry. Identical command readback is idempotent; revision conflicts
require a fresh owner decision. Quarantine retains the original runtime identity,
criteria, assignments, attempts, artifacts, existing receipts, and reservations.
A missing receipt becomes an `unknown` effect without a receipt; separate
`runtimeRecovery` metadata explains exactly which effect IDs changed and why.
Pending receipt usage forces the total measurement to null. No refund is inferred.

The fence rejects later original-Work receipts, owner reconciliation, artifact
publication, task progression and acceptance. Unlike ordinary cancellation,
provider responses arriving after quarantine are not persisted by this path.
Inspect provider-side evidence separately; a future evidence attachment protocol
must not reopen this run implicitly. Provider interruptions are best effort.
Previously admitted effects may still dispatch from another worker: the guarantee
is no new effect admissions or Work progression, not external cessation.

Portable validation preserves this state and enforces receipt-free unknowns only
when the exact recovery metadata explains them. It also retains the configured
runtime's historical `enabled`/`capabilities` descriptor metadata in assignments;
those values are validated historical evidence, never restored permissions.

## Remaining gates

Continuation/supersession, durable worker leases and stop proof, late evidence
attachment, production authentication, live-provider quality and actual browser
visual/accessibility review remain open. UI tests use a JavaScript/DOM harness.
Provider selection is unchanged; quarantine is provider-independent.
