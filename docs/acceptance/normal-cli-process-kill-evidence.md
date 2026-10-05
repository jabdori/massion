# Normal CLI process-kill regression

This bounded successor to Draft #15 tests the real `src/server.ts --host-config`
entrypoint during a held fixture HTTP call. It adds no product behavior or
recovery policy. The six controlled store-boundary tests retain their original
scope and now share their disposable database ownership verification helper.

## Reproduce

Use Linux with readable `/proc`, Node 24.19.0 and SurrealDB 3.3.0:

```sh
MASSION_SURREAL_BINARY=/path/to/official/surreal \
  python3 scripts/with-surreal.py -- \
  node --test --test-concurrency=1 tests/cli-host-kill.test.ts
```

Without disposable-launcher metadata or Linux, this case explicitly skips.
Invalid supplied ownership metadata fails before database access. The test checks
the launcher's ancestry, server PID/argv, temporary SurrealKV root and loopback
endpoint, then creates a random database. Before each signal it checks the exact
direct child PID, parent PID, full CLI argv, owned temporary cwd and owner UID.
Only that child is signalled. Cleanup checks the same identity before SIGTERM
and any bounded SIGKILL fallback; no shared process or database is a target.

## Acceptance evidence

The normal CLI starts from a credential-free loopback manifest and an empty
grant set. An explicit fixture-only grant permits one executor request. The
provider holds the response while the parent independently observes durable run
admission and a pending effect without a receipt. SIGKILL occurs at that point;
there is no pausing store wrapper or custom application host in this case.

The restarted normal CLI uses the same disposable database with no restored
grants. Snapshot and journal remain identical. Total provider calls remain one
executor call, with zero verifier calls or automatic provider replay. The actual
inline client in the DOM harness retains its private creation/direction drafts;
reconnect sends zero automatic POSTs and a fresh client sends zero POSTs.
Readback of the exact activation receipt clears browser admission uncertainty
while the external effect remains pending without a receipt.

Explicit same/new-command Run probes return `already-started` without new
effects or journal entries. Owner quarantine produces one operation and no
outbox, retaining the reservation and receipt-free unknown outcome with null
measured usage and no Record. Duplicate quarantine replays its receipt;
subsequent Run remains blocked. Event cursors are contiguous and activation is
recorded exactly once. The focused local case passed with zero failures/skips;
exact candidate aggregate, CI and independent review are recorded in its PR.

This proves the existing held-call CLI interruption contract. It does not prove
general resumption, worker fencing, external cancellation, late receipts,
persistent approval, live-provider quality or Chrome/assistive technology use.
Only disposable fixture data is involved; no live/paid model, merge or deployment
is included.
