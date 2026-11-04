# Restore RPC size preflight

This bounded correction builds on PR56 head
`34c4da4087b34b8d6f20f47aa41bfa36625a7f1c` and addresses issue #4's backup
and restore acceptance path. It changes no database, security or global setting.

The current-head QA retained a valid 4,057,747-byte portable bundle whose actual
Massion restore RPC envelope is 4,581,746 UTF-8 bytes. SurrealDB 3.3.0's official
[configuration source](https://github.com/surrealdb/surrealdb/blob/v3.3.0/surrealdb/server/src/cnf/mod.rs)
sets the HTTP RPC default to 4 MiB with an environment override;
[the HTTP route](https://github.com/surrealdb/surrealdb/blob/v3.3.0/surrealdb/server/src/ntw/rpc.rs)
applies a request-body limit before decoding/query execution. The normal transport
encodes JSON variables as strings, and restore also generates event/outbox rows,
so bundle file size alone does not measure the request. The default-capacity
failure was retained as EPIPE/unknown; that restore identity was never replayed.

The preflight measures the exact envelope using the same serializer and generated
restore variables as the actual transport. Both measurement UUIDs have the same
36-byte representation as the actual generated UUIDs. A wire-capture regression
compares the actual transmitted byte length, including Unicode, escaping and
additional event/outbox rows, with the reported measurement.

The normal CLI now blocks a request above its client body budget before schema
initialization, any database request, root creation or artifact staging. Offline
`restore-check` fully validates the bundle and reports its byte size, exact RPC
size and budget without fetching the destination or writing files. Boundary,
tampered bundle, invalid/unbounded budget, zero-request HTTP trap and actual DB
small restore cases are covered by `tests/restore-preflight.test.ts`. Independent
review found no remaining findings; its focused run has 5 pass and 1 actual-DB
conditional skip, distinct from the local actual-DB gate and exact-head CI.

The default 4 MiB is a client guard based on the inspected 3.3.0 default, not a
measurement of the destination configuration. A caller can specify a bounded
1..64 MiB client budget after independently checking the destination capacity.
That parameter changes no server setting and grants no execution authority.
Within-budget does not prove server capacity, destination emptiness, filesystem
permissions, successful restore or future version compatibility. The HTTP API
paths inspected do not advertise this deployment-specific body-limit value;
version detection alone cannot prove it. No splitting protocol, alternate
transport, automatic retry or unlimited override is introduced.

Previously unknown restores still require read-only identity/destination
inspection and retention of staged evidence before any new explicit recovery
decision. This increment prevents the observed oversized default-budget request;
it does not certify recovery of the previous unknown attempt or whole first-slice
assistive-technology behavior.

Local final gate (Node 24.21.0, TypeScript 7.0.2, SurrealDB 3.3.0/SurrealKV):
`restore-preflight`, `storage`, `portable-backup` and `restored-record-cli` test files
pass 47/47, no failures or skips, with actual crash/restart enabled and the optional
local headless Chrome restored-reader case executed. Static types and runtime
syntax checks pass. The earlier 46/47 gate with crash conditional skip and the
initial sandbox/type failures remain separate retained diagnostics; they are not
summed with this final run. Exact published head and CI results belong to the
Draft PR description, rather than a claim about all first-slice or AT coverage.
