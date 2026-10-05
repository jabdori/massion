# Local Mission/Work interface

This increment replaces the default fixture-only screen with user-authored Mission and Work forms. It is still a local development interface, without production authentication. The controlled fixture remains an explicit, separate development action.

## Application boundary

- `POST /missions` admits purpose, scope, constraints and versioned acceptance criteria under a caller-generated Mission/command identity.
- `POST /missions/:id/work` requires expected revision and a Work identity. It persists the provider/runtime gate with the Work.
- `POST /missions/:id/commands` exposes only owner cancellation and steering. It cannot supply assignments, effect receipts, verification verdicts or accepted Records.
- `GET /missions/:id` reads the authoritative snapshot.
- `GET /missions/:id/impact?entity=<encoded ID>&version=N` reads exact-version inverse relation impact and original provenance from one SurrealDB snapshot/feed boundary when the host enables the reader. The normal CLI enables it; other hosts return explicit unavailability. This adds no Relation mutation or automatic invalidation. See [bounded query evidence](../acceptance/relation-impact-evidence.md).
- `GET /providers` distinguishes configured descriptors from a usable selection.
- `GET /events?after=N&limit=L` provides bounded durable operation batches with monotonic cursors. Replay, rejected revision and rolled-back transactions do not emit another committed batch.

All commands pass through the product application service. Server-side role resolution fixes this local development user to an owner identity; no browser-supplied role grants authority. Loopback binding, Host validation, same-origin checks and bounded JSON are defensive development boundaries, not a multiuser authentication system.

## Unavailable execution is an explicit result

The provider port defines invocation identity, cancellation, output, usage and unknown/error outcomes. No real provider adapter or account is installed. User Work therefore remains `blocked` with `provider_unavailable`; the host does not substitute the deterministic fixture. Even an injected configured provider descriptor remains gated by `runtime_unavailable` until a permitted general executor and independent assurance path exist. A descriptor is not evidence of execution.

Steering appends a durable instruction. A blocked Work remains blocked until its actual gate is satisfied; an instruction does not create provider access. Cancellation prevents later effect admission without pretending to undo a prior effect.

## Reconnect and conflicts

Before transmitting a mutation, the browser persists only its nonsensitive command identity, Mission ID and reconciliation cursor. Web Locks serialize marker claim/clear across tabs. Reload restores a read-only recovery state until an exact durable receipt or definite rejection settles it. If storage is unreadable/corrupt or Web Locks are unavailable, mutations fail closed while reads remain available. An unresolved development-fixture marker also survives reload. Committed event batches trigger authoritative snapshot refresh. Two callers sharing an expected revision receive one transition and one conflict; the losing write is not automatically retried. Unknown write outcomes are reconciled from command identity in durable events. Absence of an observed event does not prove rollback.

The store serializes commits within one host/store instance because its atomic global cursor is a shared write point. Cross-store contention can produce a typed, definite rollback; this is distinct from ambiguous transport failure. There is no automatic write retry in either case.

No retention/pruning is enabled. The loopback event route returns a database-local
feed identity and validates the client's `X-Massion-Feed` header. A changed identity
or cursor beyond head closes the write barrier before read-only recovery through
`GET /read-state?mission=…`, which binds the selected snapshot to one feed/cursor
boundary. The barrier remains closed until current host permissions/setup and a
fresh matching read boundary are available. If the selected Mission is absent,
recovery adopts the validated new feed boundary and clears that selection; Mission
creation becomes available after permissions refresh. Unresolved command/fixture
markers independently retain their write locks and are never cleared by absence.
Equal Mission revisions with changed snapshot contents are rendered again.
Private drafts and unresolved command/fixture identities remain; a fresh snapshot
does not settle a command. Pending receipt catch-up starts at zero after fresh
synchronization and only its exact receipt permits clearing the command marker.
No mutation or model dispatch is automatically replayed. See
[bounded recovery evidence](../acceptance/cursor-recovery-evidence.md).
Routine Mission refreshes also use the atomic read endpoint once feed identity is
known; a different feed or newer connection closes the write barrier. Commands and
fixture requests carry `X-Massion-Feed`; the host rejects a stale identity before
admission and tags acknowledgements with the checked originating feed. Before a
successful acknowledgement can settle a marker, the client reads the current
snapshot/feed boundary again. This also detects replacement before event polling
has noticed it. Delayed fixture responses retain their unknown marker on either
feed mismatch or failed current-Mission read. A read boundary is not a replay or
an authorization for a new effect.
The host's initial feed check is backed by an atomic expected-feed condition in
every request-scoped application/runtime/fixture commit. Replacement after that
initial read cannot write into or admit a provider effect on the new database.
If a multi-commit request has already started, mismatch remains an unknown overall
outcome: earlier effects are not undone or replayed and its marker is retained.
Production retained-feed fallback/retention, identity-scoped feeds, event-stream
transport, leases and multiple-host load behavior remain open.

## Explicit owner-instruction conflict comparison

A rejected owner instruction retains its submitted text and editable draft in
browser memory, scoped by Mission and Work together. Its Work card compares the
unrecorded submission and attempted revision with the latest authoritative owner
instruction and snapshot revision. A new action requires deliberate submission
against the displayed revision with a fresh command identity; no conflict is
merged or retried automatically. Repeated conflicts update the comparison.
A direct success or exact durable operation receipt clears that submission's
comparison and unchanged draft. Edits made after transmission remain a new unsent
draft; unknown outcomes retain their lock and are never replayed.

Durable events and reconnect reads refresh the canonical side while preserving
local drafts. Closed Work retains the comparison/draft for reading and has no
resubmit controls. Detached controls cannot submit to a different Mission or a
newer/closed Work snapshot. Another Work's draft remains independent. Drafts are
volatile browser memory, not shared conversation state or persisted server input;
reload/new clients reconstruct committed instructions, not rejected private drafts.
Existing owner resolution, revision admission, no-replay and effect gates apply.
This advances #4/SUR-01 without choosing conversation/session or identity/auth
semantics. General shared conversation remains a separate product decision.

## Reconnection synchronization barrier

Startup, an offline notification or a failed/invalid event read pauses new writes.
Mission reads and input drafts remain available. Before enabling actions again,
the client validates a durable event page, refreshes current provider/runtime
metadata and connection setup, and reads the selected authoritative Mission.
A failed permission or Mission read keeps the barrier closed. Successful refresh
rebuilds execution controls so an old selection check cannot authorize a Run.

This barrier covers Mission/Work admission, owner intervention, fixture execution,
model connection/permission changes and Run; it is a client synchronization rule,
not a new authentication system. Existing server owner resolution, scope grants,
revision/idempotency checks and effect admission remain authoritative. Losing a
connection does not cancel an already admitted effect or authorize retry.

A later offline notification fences an older refresh response. Durable pending
command/fixture markers remain separate locks even after successful synchronization;
only their existing exact-receipt/definite-rejection path can clear them. Reconnection
never resends commands. The development runtime still has no remote multi-PC
identity, persistent approval or publicly exposed listener.

## Same-host Mission links

A validated loaded snapshot exposes `#mission=<encoded ID>` on the current host.
Installing a validated snapshot replaces the current address fragment with that
Mission, so explicit form navigation and reload cannot reopen a stale reference.
Opening that link in a browser with separate storage loads the authoritative
Mission and durable events using reads only. The link carries no command,
credentials, grants, selected model or execution authorization. Invalid or
oversized fragments are rejected rather than becoming transport paths. A missing
or failed snapshot exposes no continuation link.

On initial load, a valid pending-command recovery marker takes precedence over a
link. Later link navigation may inspect another Mission, but cannot clear that
marker, resolve an unknown outcome or unlock writes. Normal revision conflicts
and explicit Run boundaries remain authoritative. Sharing a reference does not
grant access; clients must already reach the same authorized host.

This advances #4/SUR-01 second-client continuation without altering loopback
binding or Host/origin defenses. Authenticated multi-PC networking, shared
conversations and flexible agent collaboration remain open. Actual HTTP and
SurrealDB tests with isolated client storage are not browser rendering or
multi-device authentication evidence.

## Upgrade boundary

The cursor schema is version 2. A nonempty foundation database without cursor metadata is deliberately refused. It needs an explicit, reviewed migration/cutover plan; historical total ordering is not invented, and data is not deleted. Disposable test databases are new for every acceptance run.

## Verification limits

Actual SurrealDB tests cover user Work persistence, a fresh HTTP host/transport reading the same snapshot, and event catch-up after restart. JavaScript/DOM-harness tests exercise client logic. `tests/client-workbench.test.ts` also connects the actual inline client to a real loopback HTTP host, selected local HTTP fixture adapters, and optional actual SurrealDB, then checks host restart/client reload without provider replay. This is client/HTTP integration evidence, not browser rendering evidence. The real cloud browser cannot open the loopback URL in this environment; visual layout, browser behavior and accessibility remain unverified. Real model quality, credential configuration, execution spend, OS/VM isolation and production deployment remain separate gates.


Keyboard owner actions restore focus to the same Work instruction or its result/
closed heading after DOM replacement. Model/scope setup and selection checking
restore the relevant control. Pending responses respect a user who moved focus;
rendering preserves a focused Work instruction and its caret, as well as stable
Work summary, evidence and selection targets. Implicit Enter submission from
model/scope inputs restores the submitted input after replacement. Scrollable evidence
and authoritative snapshot text are keyboard reachable with visible focus. See the
[bounded Chrome keyboard evidence](../acceptance/browser-qa.md); screen-reader and
broader platform coverage remain open.
