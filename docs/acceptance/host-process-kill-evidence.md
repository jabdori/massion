# Owned host process-kill regression

This test/document successor to Draft #14 preserves the existing no-replay and
permanent-quarantine contracts. Product server, runtime, admission and recovery
behavior are unchanged. It replaces a task-local six-boundary experiment with
repeatable tests in `tests/host-process-kill.test.ts` and an owned fixture child
in `tests/support/host-kill-child.ts`.

## Reproduce safely

Supported: Linux with readable `/proc`, Node 24.19.0 and SurrealDB 3.3.0. The
existing Ubuntu CI actual-store aggregate runs these tests through the disposable
launcher. Run the focused regression with the same launcher:

```sh
MASSION_SURREAL_BINARY=/path/to/official/surreal \
  python3 scripts/with-surreal.py -- \
  node --test --test-concurrency=1 tests/host-process-kill.test.ts
```

Without the launcher ownership metadata, or on a non-Linux platform, all six
integration cases explicitly skip. A green ordinary run does not prove them.
Supplying only an RPC URL is insufficient. Do not substitute an existing service.
If supplied ownership metadata fails verification, the test fails before its first
database request; it does not fall back to another service or weaken assertions.

Before database access, the test verifies the temporary SurrealKV root, owner,
server metadata/PID/argv, loopback endpoint and launcher ancestry. It creates a
new random database for each case. Before every host signal, it verifies the
directly spawned child's PID, parent PID, Node executable, fixture entrypoint,
config location and temporary cwd. SIGKILL targets that exact child object only;
the database, provider, user host and unrelated processes are never kill targets.
Diagnostics retain PID/parent PID and a temporary cwd basename without account
paths, credentials or private fixture logs. Child hosts terminate on IPC loss.

## Observed boundaries and assertions

| Controlled stop boundary | Provider sends before/after recovery | Existing disposition |
| --- | --- | --- |
| Before executor effect admission | 0 / 0 | Run admission retained; no unresolved effect, so quarantine rejects |
| After effect admission, before invocation | 0 / 0 | Pending effect can be permanently quarantined as receipt-free unknown |
| During held executor HTTP invocation | 1 / 1 | Same unknown/quarantine contract; no provider-stop claim |
| Provider returned, before receipt commit | 1 / 1 | No invented durable receipt or usage; permanent quarantine |
| Executor receipt committed, before the next stage | 1 / 1 | Settled receipt retained; no unresolved effect, so quarantine rejects |
| Artifact bytes written, before its receipt commit | 1 / 1 | Executor receipt/bytes retained; pending artifact becomes unknown |

The fixture pauses the real store commit path at exact nested command events;
the parent independently reads durable state before terminating the host. During
invocation, the owned loopback provider holds its response instead. Six local
actual-store cases passed, zero failures/skips. Exact published-head aggregate
counts, CI and independent review are recorded in the separate Draft PR.

Every case checks durable snapshot/journal equality across restart, unique
contiguous cursors and exactly one activation command. The actual inline client
runs in the DOM harness: an open client's private creation/instruction drafts
survive, a fresh client sends no POST, and reconnect sends no automatic POST.
Readback of the exact activation receipt clears only browser command-admission
uncertainty; it does not settle an external effect or resume the run. Restarted
fixture authorization is disabled. Deliberate same/new-command Run probes return
`already-started` without a journal entry or another provider send.

For unresolved effects, owner quarantine creates one operation with no outbox,
preserves reservation and settled effects, keeps receipt-free unknown outcomes
and null measured usage, and prevents subsequent Run. Duplicate quarantine
returns its original receipt. With no unresolved effects, rejection creates no
operation. No verifier request occurs in any case.

## Limits

This closes the bounded actual host-process-death verification gap for the current
contract, not general execution resumption. Worker ownership/fencing, external
stop proof, late evidence attachment, successor/resume policy, persistent approvals,
live-provider quality and production recovery remain open. Before-effect and
after-settled-receipt cases deliberately remain admitted without a new recovery
policy. The controlled child uses the unmodified application/server/runtime with
a pausing store wrapper; it is not a normal CLI shutdown or Chrome/assistive
technology proof. Existing CLI/Chrome evidence retains its original scope.
The separate [normal CLI process-kill regression](normal-cli-process-kill-evidence.md)
covers a held-call SIGKILL through the actual CLI entrypoint without store hooks.

Only disposable fixture data and credential-free loopback providers are used.
No real account, live/paid model, production DB, merge or deployment is included.
