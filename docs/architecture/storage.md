# Authoritative storage: bounded SurrealDB adapter

Status: focused adapter and actual local storage conformance evidence, 2026-10-03. This is not a production-readiness claim or completion of the full durable product slice.

## Runtime and tested configuration

The authoritative-store direction remains a separate SurrealDB service. The adapter uses Node 24's built-in `fetch`, HTTP `POST /rpc`, and JSON request variables. No database SDK or alternative database is installed by the project. `InMemoryStore` is a test-only reference, not a fallback for the host.

The actual tests ran on Node **24.19.0**, official SurrealDB **3.3.0**, Linux amd64, one local server with a new **SurrealKV** directory, and `127.0.0.1` binding. The server had no credentials and was started with `--unauthenticated --deny-net --deny-scripting`; these are disposable development-test settings, not deployment guidance. Every test server was stopped afterward.

Binary provenance:

- [Official 3.3.0 release](https://github.com/surrealdb/surrealdb/releases/tag/v3.3.0)
- [Official Linux amd64 archive](https://github.com/surrealdb/surrealdb/releases/download/v3.3.0/surreal-v3.3.0.linux-amd64.tgz)
- Published archive SHA-256, matched before execution: `44aeab565f7e7e39d2d0bf0583c8aae648babc91373c70b2658288d95bbbcd55`

Other versions, storage engines, platforms, replication configurations and production authentication have not been certified by these tests.

## Application contract

`Store<T>` provides:

- `load(id)`: latest `{revision, value}` or `null`.
- `readEvents(after, limit = 100)`: a bounded page of committed operation event batches, ordered by durable global cursor, plus the last delivered cursor. Each batch contains `cursor`, `aggregateId`, `revision`, `commandId` and the complete original `events` array.
- `commit({id, expectedRevision, commandId, fingerprint, value, events, outbox})`: `{status: 'committed' | 'replayed', revision, value}` or `{status: 'conflict', reason: 'revision' | 'idempotency', revision}`.
- `lookupOperation({id, commandId, fingerprint})`: original committed snapshot, an idempotency conflict, or `{status: 'unknown'}`. The application uses this before deriving a transition, because later state cannot reconstruct the original command's accepted snapshot.
- `reconcile(originalCommitInput)`: read-only lookup that also verifies the full original commit payload. Use it to resolve uncertain submission outcomes.

Revision `0` means absent; the first accepted commit is `1`. Revisions are safe nonnegative integers. Every successful transition increments its aggregate revision once. Command IDs are globally unique within the selected database, not merely within one aggregate. An idempotency conflict reports the original operation's revision; a revision conflict reports the observed current aggregate revision.

A replay returns the **original accepted revision and value**, even after newer commands advance the aggregate. Calling `load` after a replay retrieves the latest snapshot instead, so it must not be substituted for the replay result.

The application fingerprint identifies the authorized command. Storage also hashes a canonical, JSON-only serialization of the complete commit input, including expected revision, value, events and outbox. Reusing a fingerprint with different derived data cannot overwrite the original operation. Property insertion order does not change identity. Unsupported/lossy inputs such as `undefined`, non-finite numbers, class instances, sparse arrays and cycles are rejected before submission. Callers cannot mutate a submitted snapshot by retaining object references.

## Transaction boundary and representation

Call `initializeSurrealSchema(transport)` explicitly in the intended database before normal use. Neither reads nor commits silently initialize schema. Version 3.3.0 rejects reads against missing tables; the initializer defines six tables and a version-2 feed metadata record in a transaction, with integer cursor constraints and a unique operation-cursor index. A nonempty legacy database without feed metadata is refused; no historical cursor order is invented. It is not a general migration or compatibility system.

Every commit is a single HTTP query containing a `BEGIN`, a result-producing block and `COMMIT`. The block checks operation identity first, then expected aggregate revision, and writes all of:

| Table | Retained content |
| --- | --- |
| `massion_feed` | Single database-global monotonic cursor and schema version |
| `massion_state` | Latest aggregate snapshot and revision |
| `massion_operation` | Immutable-by-application command identity, digest, accepted snapshot, global cursor and original event/outbox payloads |
| `massion_audit` | Command/aggregate identities, fingerprint, digest, previous/new revision and UTC recorded time |
| `massion_event` | One record per event, aggregate and operation record links, aggregate revision and within-command ordinal |
| `massion_outbox` | One record per intent, aggregate and operation record links, revision, ordinal, payload and pending status |

Audit time is observational, not a sequence or authority source. Actor/policy evidence belongs in the domain command and event data; a storage timestamp does not establish authorization. Journal immutability is currently an application convention; privileged database mutation is not prevented by production permission rules in this slice.

Record identifiers are SHA-256 digests of opaque IDs, with the original IDs retained for comparison. Event and outbox record IDs add their within-command ordinal. All variable data goes through RPC variables; it is never interpolated into the query or URL. Native record links connect journal entries to their operation and aggregate. This is not yet the complete typed, versioned Work/document/file/function/evidence graph.

SurrealDB uses snapshot isolation. The adapter always writes the aggregate key that it read, and creates a deterministic operation key, so overlapping writers contend on the same keys. The actual cross-store race test checks both result classifications and retained journal cardinality. It does not assert serializability across arbitrary sets of aggregates.

## Durable operation-event catch-up

Each accepted command increments the single `massion_feed:global` counter and stores that cursor on its operation, audit, event and outbox rows in the same transaction. One command is one feed batch, including commands with an empty event array. Replays, revision/idempotency conflicts and rolled-back commands do not create a batch or consume a cursor. Feed order comes from committed cursor allocation, never timestamps.

`readEvents(after, limit)` reads the counter and operation page in one snapshot. It returns only entries with cursor strictly greater than `after`, in ascending order. The returned cursor is the last delivered batch, not the database head, so a full page cannot skip undisclosed entries. An empty page preserves `after`. Cursor and revision values are safe integers; cursor is nonnegative; limit is an integer from 1 through 1000. A cursor ahead of this database throws `EventCursorError` with `after` and `head`, requiring the client to resolve a wrong/reset database or obtain a fresh snapshot. Invalid numeric bounds throw `TypeError` before any query.

The feed preserves the complete stored event payload, including application-supplied actor, command and scope evidence. It does not manufacture missing authority information, execute commands, filter per-user access, or replace backend authorization. Scope remains one local owner behind one authoritative host.

The global counter is a deliberate one-host bootstrap bottleneck. `SurrealStore` serializes its own submissions, capturing input before queueing; this avoids self-inflicted counter contention for concurrent host requests. The queue continues after rejection, and adds no retry or replay. Separate store instances/processes still contend on the same database key. Actual HTTP RPC 3.3.0 reports a structured `Query`/`TransactionConflict` error; the transport exposes this as `StorageContentionError` with `retryable: true`. The caller may deliberately re-read and retry a definitely rejected storage transition. Ambiguous outcomes never become retryable based on an error message.

No pruning, retention policy, cross-database cursor portability, live subscription, efficient large-scale feed benchmark or snapshot-plus-cursor handshake is implemented. Privileged manual journal changes remain outside the append-only application contract. This is a durable catch-up primitive, not a production event-feed claim.

## Ambiguous outcomes and failure handling

The transport never automatically retries a query. On a failed or malformed commit response, the adapter performs **one read-only operation lookup**:

1. Matching committed operation: return its original snapshot as a replay.
2. Existing operation with different identity/content: return an idempotency conflict.
3. No operation, but a complete validated SurrealQL `ERR` response established rejection: read current aggregate revision; report a revision conflict if it advanced, otherwise surface `StorageContentionError` for a structured transaction conflict or `StorageQueryError` for other rejections.
4. No authoritative outcome after a timeout, disconnect, HTTP/RPC protocol failure or malformed success: throw `CommitOutcomeUnknownError` containing the operation identity.

A missing operation immediately after a timeout is **not proof of rollback**: the submitted request may still be executing. A failed readback is also not rollback. The caller must preserve the original command and reconcile later; automatic retransmission or replaying external effects is forbidden. A known rolled-back storage transaction is distinct from an unknown external tool outcome.

The HTTP client validates RPC request IDs and every statement result, including late commit errors. In the tested RPC version, `BEGIN`/`COMMIT` contribute null result entries, so the adapter extracts the single result-producing block only after checking the complete response. Redirects are refused. Remote endpoints require HTTPS; unauthenticated HTTP is limited to loopback. Authorization, when needed, must be supplied by the caller; storage reads no credential files or environment secrets.

## Evidence and reproduction

`node --test tests/storage.test.ts` runs 19 unit/mock tests and skips the four actual-server tests unless their explicit environment is supplied. Mock and in-memory tests are not SurrealDB conformance evidence.

Actual live test coverage on the configuration above:

- State, operation, audit, event and outbox records commit together.
- Injecting a statement failure after all journal writes rolls everything back. Checks query raw operation links, so dangling events/outbox records cannot hide behind a missing operation.
- Twelve concurrent commands with one expected revision produce one commit and eleven explicit conflicts, with exactly one retained operation/audit/event/outbox set.
- Twelve concurrent identical command submissions produce one commit and eleven original-result replays.
- Same key with changed data conflicts; a valid replay retains its original value/revision after later transitions.
- A dropped response injected after an actual successful server commit is resolved by readback; the write query executes once. This is a controlled response-loss simulation, not a wire-level fault or cluster partition test.
- A fresh client reconnects from its stored cursor and receives only subsequent accepted operations; bounded pages, replay suppression, empty-event commands, rollback and future-cursor rejection are checked. Cross-store global-counter contention yields an explicit retryable rejection without a feed entry. Legacy journals without a cursor migration are refused.
- Killing the server with `SIGKILL`, reopening the same SurrealKV directory, and reading through a fresh adapter preserves the exact snapshots, complete journals, feed counter and catch-up result.
- Official HTTP export, import into a newly created database, and exact journal/snapshot comparison succeed. The fixture contains storage records, not yet the complete accepted product scenario.

The repository supplies a disposable-server launcher. With the verified official binary installed, reproduce the storage checks using:

```sh
MASSION_SURREAL_BINARY=/absolute/path/to/surreal \
  python3 scripts/with-surreal.py -- \
  env MASSION_TEST_SURREAL_RESTART=1 node --test tests/storage.test.ts
```

It passed **23/23 tests** with no skips. The launcher is development tooling, not the product host. An equivalent fresh test server must supply:

- `MASSION_TEST_SURREAL_RPC=http://127.0.0.1:<port>/rpc`
- Namespace and database `massion_storage_tests`
- For the separately opt-in crash test only: `MASSION_TEST_SURREAL_RESTART=1`, `MASSION_TEST_SURREAL_BINARY`, `MASSION_TEST_SURREAL_DATA`, and `MASSION_TEST_SURREAL_PID` belonging to the disposable server that the test is allowed to stop.

Do not run the crash test alongside other clients or parallel test files using that server. The crash test deliberately stops it and owns the replacement process. Ordinary live conformance does not require those restart variables.

## Remaining gates

- Complete graph schema and actual database multi-hop impact/invalidation queries with version/provenance fidelity.
- Feed retention, pruning, snapshot/cursor handshake and fallback, production authorization/filtering, and measured counter contention under sustained load. The implemented cursor is database-global and unpruned.
- Durable outbox claiming, leases/ownership, acknowledgement and effect reconciliation. Retaining an intent atomically does not execute it or make its outcome known.
- Complete product-scenario restore, graceful host ownership/drain, crash at admission/effect/receipt boundaries and two-client reconstruction.
- Schema versioning/migrations, bounded retention, indexes and measured load behavior.
- Production least-privilege access, authentication/secret management, backup policy and monitoring.
- Real provider, isolated VM, supported installation and external assistant integration evidence.

## Primary references

The implementation was checked against official documentation, then tested against the exact server binary rather than treating documentation as a substitute for execution:

- [HTTP protocol, structured RPC variables, export/import](https://surrealdb.com/docs/reference/rest-api/http-protocol)
- [RPC query request and statement response format](https://surrealdb.com/docs/reference/rest-api/rpc-protocol)
- [Transactions, rollback and snapshot isolation](https://surrealdb.com/docs/learn/querying/concepts-and-guides/transactions)
- [RETURN control flow](https://surrealdb.com/docs/reference/query-language/statements/return)
- [Parameterized record identifiers](https://surrealdb.com/docs/reference/query-language/functions/database-functions/type)
- [Unique indexes](https://surrealdb.com/docs/reference/query-language/statements/define/indexes)
- [Integer fields and constraints](https://surrealdb.com/docs/reference/query-language/statements/define/field)
- [Ordered bounded SELECT](https://surrealdb.com/docs/reference/query-language/statements/select)
- [FOR iteration and record creation](https://surrealdb.com/docs/reference/query-language/statements/for)
