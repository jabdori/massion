# Connection lifecycle backend

`ConnectionLifecycle` receives the server's drain-aware owner store and the existing
connection workbench. Owner commands are exact `{commandId, connectionId,
expectedConfigHash}` objects; key replacement adds `apiKey`, consumed only by the
manifest-selected secret slot. Environment bindings and subscription logins cannot
be edited as API keys. Keys are never fingerprinted, persisted, returned or read
back. Reusing a command identity means replaying its original intent, even when a
caller supplies different key bytes. A new replacement requires a new command ID.

A durable claim precedes discovery or secret writes. Only a fresh confirmed claim
executes the effect. Pending or unknown key writes block further replacements;
replays never resend them. Commands load state and look up their identity again
before applying transitions. Owner writes use the supplied owner store; admission
and database-feed checks fence asynchronous gaps before effects and settlement.

Read shapes expose bounded typed facts, observed times, key-edit capability and
command status. Rechecks reuse official CLI login status or bounded model
discovery, neither of which proves inference validity. Generic failures never mean
expired credentials. Expired/update/restart facts require the optional trusted
host observer, not client fields or parsed arbitrary errors. No updater or restart
executor is added. Latest admitted recheck generation wins; stale completions do
not replace a newer observation. Reads never repair, resend or mutate commands.

The server owns HTTP wiring and drain composition; the UI owns request-generation
and selected-feed invalidation. Tests use injected transports, CLI runners, secret
slots and in-memory storage only. Local verification is focused tests and typecheck.

## Integration contract

```ts
const lifecycle = new ConnectionLifecycle(ownerStore, connections, {
  logins,
  admit: async () => { if (draining) throw new HostDrainError(); },
  observe: trustedHostObserver // Optional; never populated from an HTTP body.
});

// GET /connections/lifecycle
send(200, await lifecycle.read());

// POST /connections/:id/recheck; body has commandId and expectedConfigHash.
await lifecycle.recheck({commandId, connectionId: id, expectedConfigHash});

// POST /connections/:id/key; apiKey remains request-local and is never logged.
await lifecycle.replaceKey({commandId, connectionId: id, expectedConfigHash, apiKey});

// Synchronous admission fence, then compose with the server's bounded drain.
lifecycle.beginDrain();
await lifecycle.drain();
```

`read()` returns `{feedId, revision, connections}`. Each connection contains
`connectionId`, `configHash`, `canReplaceKey`, `credentialStorage`, `credentialWriteStatus`
(`idle | stored | unknown`) and nullable `observation`. `credentialStorage` is
`saved | missing | unknown`: current slot presence, separate from past write receipts
and provider validity. Missing slots use key-add controls; saved slots use key-change
controls. Unavailable or unsupported presence checks remain unknown. A changed database feed
rejects a read instead of returning the previous database's observation.

Both commands return `{status, connectionId, observation}`. `status` is
`completed | unknown | stale`; a completed key replacement has no observation and
proves only the slot write receipt. `unknown` is never an instruction to resend.
`stale` must not replace the latest displayed facts. Invalid input or a definite
pre-write refusal throws `DomainError`; stale bindings and identity conflicts use
its `conflict` code. `HostDrainError` retains the server's existing rejection path.
Ambiguous intent acknowledgment and slot writes return `unknown`. A database change
after a slot write is unknown, never proof that the write was rejected.

An observation contains `observedAt` (host epoch milliseconds) and these typed facts:

- `status`: `unverified | detected | absent | expired | unavailable | unknown`.
- `update`: `unknown | available | current`.
- `restart`: `unknown | required | not-required`.
- `source`: `cli-status | model-discovery | host`.

The optional observer receives the existing non-secret connection target and an
abort signal, and returns the four facts above without `observedAt`. Unknown fields
are rejected. The service adds its own clock. Default API discovery yields
`unverified` or `unavailable`, not live-inference validity or expiry. CLI recheck
performs one fresh official status call for the exact provider, bypassing older
coalesced catalog reads and never opening login.

The UI must retain its selection/feed/request generation while awaiting reads or
commands, and discard results when any changes. Read `canReplaceKey` before showing
the masked replacement input; never populate it with a stored value. Do not cache
key drafts, requests or responses containing the draft. Expiry, update and restart
controls require corresponding trusted observations; there is no restart callback
or executor in this backend.

## Journal and limits

The aggregate is `assistant-conversation:connection-lifecycle` with
`kind: 'connection-lifecycle'`. `ConnectionLifecycleState`,
`isConnectionLifecycleState` and `replayConnectionLifecycle(operation, prior)` are
exported for portable backup and lineage. Strict replay derives state from exact
owner-claim and host-settlement events and checks actor, command identity,
fingerprint, revisions, derived value and empty outbox. Events and fingerprints
contain only non-secret command intent and typed observations, never key bytes or
key hashes.

The aggregate retains at most 128 command attempts and rejects additional new
commands at the bound; old identities still replay. Receipt compaction is not
implemented. An unresolved key write remains blocked across service restart and
cannot be cleared by recheck or by changing command IDs. Read-only reconciliation
of a secret-write receipt, automated installation/update and restart execution,
real providers and durable-database validation are outside this slice.

## Secret-slot presence

Optional `SecretSlots.has(slot, signal)` reports only metadata. The in-memory
adapter uses `Map.has`. Keychain calls the fixed `/usr/bin/security
find-generic-password -s massion:<owner> -a <slot>` command without `-w` or `-g`,
discards all output, and maps exit 0 to present and exit 44 to absent. Other
results are unavailable, never proof of absence. Neither adapter calls `read`.

Host compilation binds the metadata callback to the exact declared slots.
`ConnectionWorkbench.credentialStored(connectionId, expectedConfigHash)` verifies
the binding before probing, bounds the metadata call to five seconds, and returns
unknown on interruption, failure or a changed connection generation. Environment
and CLI bindings remain unknown without any credential lookup. `lifecycle.read()`
checks the database feed again after all asynchronous metadata reads. Presence is
read-only and creates no state, events, receipts or verification facts.

Definite domain refusals escape as `ConnectionLifecycleRefusedError`; the HTTP
adapter returns `outcome: 'rejected'`. Settings can then permit a fresh deliberate
attempt after a read. Post-write/ambiguous failures stay `unknown` and are never
classified by their HTTP status alone.

The HTTP lifecycle route marks an unknown result as host-unsettled, matching the
existing app-connect route. Shutdown cannot report a clean drain when a held
secret write completes without its lifecycle settlement. A definite pre-write
refusal still remains separate from an ambiguous write.
