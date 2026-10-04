# Local Mission/Work interface

This increment replaces the default fixture-only screen with user-authored Mission and Work forms. It is still a local development interface, without production authentication. The controlled fixture remains an explicit, separate development action.

## Application boundary

- `POST /missions` admits purpose, scope, constraints and versioned acceptance criteria under a caller-generated Mission/command identity.
- `POST /missions/:id/work` requires expected revision and a Work identity. It persists the provider/runtime gate with the Work.
- `POST /missions/:id/commands` exposes only owner cancellation and steering. It cannot supply assignments, effect receipts, verification verdicts or accepted Records.
- `GET /missions/:id` reads the authoritative snapshot.
- `GET /providers` distinguishes configured descriptors from a usable selection.
- `GET /events?after=N&limit=L` provides bounded durable operation batches with monotonic cursors. Replay, rejected revision and rolled-back transactions do not emit another committed batch.

All commands pass through the product application service. Server-side role resolution fixes this local development user to an owner identity; no browser-supplied role grants authority. Loopback binding, Host validation, same-origin checks and bounded JSON are defensive development boundaries, not a multiuser authentication system.

## Unavailable execution is an explicit result

The provider port defines invocation identity, cancellation, output, usage and unknown/error outcomes. No real provider adapter or account is installed. User Work therefore remains `blocked` with `provider_unavailable`; the host does not substitute the deterministic fixture. Even an injected configured provider descriptor remains gated by `runtime_unavailable` until a permitted general executor and independent assurance path exist. A descriptor is not evidence of execution.

Steering appends a durable instruction. A blocked Work remains blocked until its actual gate is satisfied; an instruction does not create provider access. Cancellation prevents later effect admission without pretending to undo a prior effect.

## Reconnect and conflicts

Before transmitting a mutation, the browser persists only its nonsensitive command identity, Mission ID and reconciliation cursor. Web Locks serialize marker claim/clear across tabs. Reload restores a read-only recovery state until an exact durable receipt or definite rejection settles it. If storage is unreadable/corrupt or Web Locks are unavailable, mutations fail closed while reads remain available. An unresolved development-fixture marker also survives reload. Committed event batches trigger authoritative snapshot refresh. Two callers sharing an expected revision receive one transition and one conflict; the losing write is not automatically retried. Unknown write outcomes are reconciled from command identity in durable events. Absence of an observed event does not prove rollback.

The store serializes commits within one host/store instance because its atomic global cursor is a shared write point. Cross-store contention can produce a typed, definite rollback; this is distinct from ambiguous transport failure. There is no automatic write retry in either case.

No retention/pruning is enabled. A cursor beyond the database head requires reset and snapshot reload; production snapshot fallback/retention, identity-scoped feeds, event-stream transport, leases and multiple-host load behavior remain open.

## Same-host Mission links

A validated loaded snapshot exposes `#mission=<encoded ID>` on the current host.
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
