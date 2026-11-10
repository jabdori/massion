# Steering revisions and safe restart continuation (R-O)

## Contract

New configured text procedures opt into `continuationVersion: 1`. Confirmed
steering can supersede an admitted assembly or check. The current call finishes
once and retains its receipt. The host then starts a new assembly revision with
the current owner instructions and independently checks that exact artifact.
Planning and completed workers are retained as inputs, not treated as proof that
the changed request was satisfied. No worker effect is resent. At most four
assembly revisions fit inside the original Work budget and deadline.

Each revision binds its input hash before assembly. A changed input fences
artifact publication, room progression, verdicts and acceptance. Revision changes
retain effects, reservations and attempt history, reset only finalization tasks,
and preserve prior artifacts and room transcripts in the journal. Legacy runs
retain their original contract. Cancelled, unknown, failed-provider, quarantined,
budget-paused and expired runs do not acquire continuation authority.

Restart continuation is a host-only CAS transition, not a second Run request.
It retains original run identity, start, deadline, models, authorization and
budgets, and appends a dispatch ownership record. Older dispatches are fenced
against the new ownership. Resume requires an exact still-authorized configuration
and no pending or unknown effects. A claimed call without a committed outcome
cannot be proved absent remotely; it stays unresolved for the existing owner
exception flow. This is at-most-once dispatch with durable result reuse, not a
claim of distributed exactly-once delivery.

The existing execution sequence becomes restartable at committed boundaries:
reuse successful provider receipts, completed tasks and artifact-write receipts;
perform only the next unadmitted effect. Never infer a successful output from a
task label. Startup discovers stored Missions, reads them on the same database
feed, and resumes eligible runs serially through the existing host runtime.
Drain fences startup writes and waits for its work. No new public endpoint,
owner command, permission, model dependency or background polling is needed.

## Implementation and verification

1. Extend the domain and portable journal schema with revision and dispatch
   continuation metadata; keep legacy replay and claim provenance valid.
2. Reuse durable results in configured execution, fence stale finalization, and
   pass resume through the configured profile router and normal host startup.
3. Exercise steering during assembly/check/acceptance races, crash boundaries,
   overlapping resumers, unknown receipts, budgets, deadlines, configuration
   changes, journal replay and drain using fixtures only.
4. Run related tests and typecheck locally; CI owns the full suite. Open the PR,
   resolve CI and current-head Codex findings for at most four review rounds.

Own only continuation domain/runtime, affected lineage, startup and their tests.
Browser execution, connection repair, activity facts, file telemetry, procedure
editing, UI redesign, real-provider evaluation and merge are outside this batch.
