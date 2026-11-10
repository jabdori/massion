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
and preserve prior artifacts and room transcripts in the journal. New procedure
admissions reserve their original Work limit against the monthly budget, rather
than only the first pass. Successful receipts retain their original reservations;
insufficient remaining capacity blocks a revision without increasing either limit. Legacy runs
retain their original contract. Cancelled, unknown, failed-provider, quarantined,
budget-paused and expired runs do not acquire continuation authority.

Restart continuation is a host-only CAS transition, not a second Run request.
It retains original run identity, start, deadline, models, authorization and
budgets, and appends a dispatch ownership record. An admission-time configuration
hash pins identities and model descriptors even before the first assignment exists. Older dispatches are fenced
against the new ownership. Resume requires an exact still-authorized configuration
and no pending or unknown effects. A claimed call without a committed outcome
cannot be proved absent remotely; it stays unresolved for the existing owner
exception flow. This is at-most-once dispatch with durable result reuse, not a
claim of distributed exactly-once delivery.

The existing execution sequence becomes restartable at committed boundaries:
reuse successful provider receipts, completed tasks and artifact-write receipts;
perform only the next unadmitted effect. Never infer a successful output from a
task label. Startup discovers runs through the existing durable monthly reservations, reads
their Missions on the same database feed, and resumes eligible runs serially through the existing host runtime.
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

## Evidence and limits

Fixture coverage includes SIGKILL between receipt and task settlement followed by
normal host startup in a new Node process, seven committed restart boundaries,
three unresolved-effect boundaries, stale writers and competing resumers, late
steering at assembly/check/publication/verification/acceptance, clean shutdown,
drain, configuration changes, original budgets and deadlines. A member conversation
confirms late steering, resumes its revised result, and validates the full portable
journal. Only the expired-run ownership comparison changes on the client; no layout, copy
or allow-list entries change.

An unresolved provider or artifact write cannot safely resume: pending intent is
not proof that nothing happened, and a successful task label is not a receipt.
These cases keep their existing owner inspection/unknown-outcome path. The host
does not infer another process's death or remote stop from a different session ID.
Expired, cancelled, quarantined, failed-provider or budget-exhausted runs stay
stopped. There is no authorization restoration or account repair. A later host
with changed configuration cannot automatically adopt the old run.

## First Codex review corrections

Steering after provider intent but before its claim must finish that admitted
invocation under its original request hash. Only subsequent finalization is
superseded. Executor and verifier regressions reproduce the formerly stranded
pending intent. A resumed run's expired-owner review now compares the latest
dispatch ownership, while retaining the original ownership history.

The correction batch passed 61 tests with 17 environment-gated skips, plus
typecheck. Headless Chrome exercised review, cancel, re-review, closure and
reload without a second write. Desktop and 390px captures are retained locally
in `.runtime/steering-resume-review/expired-closed.png` and `expired-mobile.png`,
with accessibility snapshots beside them. No layout or copy changed.

## Main integration

Merge the credential-repair work from main without rewriting history. Completed
repair receipts are valid retained results; their original rejected attempts do
not prevent assembly or safe resume, and neither attempt is called again. An
unfinished repair still requires its original live owner-confirmed continuation.
Combined steering/restart/credential tests passed 158 cases with five gated skips;
typecheck passed. A separate regression proves that clean checkpoint reservations
remain held while resumable and settle to measured usage after the original
deadline makes resumption impossible.
