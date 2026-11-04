# CLI host connection evidence

This successor to provider-only PR #8 connects explicit versioned host bindings to
the normal CLI. It includes no correction dispatch, Domain/Application/backup-format
change, real account enrollment or live-provider test.

## Checks

Pinned Node 24.19.0/TypeScript 7.0.2 strict typecheck and runtime syntax passed.
The first full runtime regression on this slice reported 270 passed, 20 conditional
DB skips, 0 failures, 290 cases. These are not added to prior candidate counts.

The affected host tests use synthetic accessors and intercepted HTTPS-shaped
requests for lazy credential/ref/profile/destination binding, missing values,
cancellation, redaction, exact-schema parsing and managed UI. They do not read a
real provider variable or establish provider account compatibility.

The actual CLI lifecycle test uses `node src/server.ts --host-config ...` child
processes, a separately launched fresh SurrealDB 3.3.0 and native credential-free
Anthropic/Gemini loopback fixtures. It covers:

- Default startup: no host profiles, value lookup or provider sends.
- Configured startup: declared model profiles present, no grants or sends; explicit
  discovery filters undeclared models and explicit model selection works.
- HTTP connection/endpoint tampering and undeclared model selection rejected.
- Scope grants and current preflight, stale revision rejected without dispatch.
- Explicit Run produces accepted fixture Record with executor/verifier sent once each.
- Slow executor cancellation preserves cancelled/unknown effect and null usage;
  no verifier is sent. A separate dropped-response executor preserves unknown outcome.
- Shutdown/restart under a changed manifest revision changes connection identities,
  restores no grants and preserves accepted/cancelled/unknown Mission snapshots.
  Attempts to rerun those three Works remain already-started with no additional sends.
- UI reload displays the preserved accepted state with zero POST operations.

The observed inference sends are exactly executor, reviewer, slow executor and
unknown executor. No API key/header is sent to these loopback fixture providers.
The accepted Record remains fixture-class. Disposable state/processes are cleaned
up by the test/launcher. Initial CLI test failure was a wrong test storage key at
the final UI reload; using the real product key fixed it without relaxing deadlines.

The final affected suite against the disposable database passed all 6 cases with
0 failures and 0 skips, including both actual CLI process tests.

A later boundary regression reproduced valid 512-character connection labels failing
automatic profile enrollment when concatenated with model IDs. Profiles now use
the exact model ID as their display label; the connection retains its owner label.

Independent Codex review also found generated inference URLs could exceed the
profile catalog limit while the discovery URL passed transport validation. The
manifest parser now checks each generated native inference endpoint, including
the 512-character boundary, before database startup. The regression failed before
the fix and checks both rejection and the accepted exact boundary.

Codex P1 review found forced active-connection closure on SIGTERM could exit before
a provider receipt was persisted. The actual CLI regression holds an executor
response, sends SIGTERM, verifies the host stays alive, then releases it and checks
accepted receipt/Record persistence before exit and restart. It failed before the
fix. Shutdown now stops accepting connections and waits for active handlers.

## Reproduce

```sh
node --test tests/host-connections.test.ts tests/host-cli.test.ts
# The durable CLI test skips without an explicitly disposable database.

MASSION_SURREAL_BINARY=/path/to/official/surreal \
  python3 scripts/with-surreal.py -- \
  node --test tests/host-connections.test.ts tests/host-cli.test.ts
```

The existing candidate CI additionally performs the complete durable aggregate,
enabled crash/restart and clean restore against a fresh service. Published-head CI
and independent reviews are separate evidence from these local checks.

## Open boundaries

Real key/account access, paid inference, provider model aliases/returned versions,
live judgment quality and monetary spend controls remain unverified. Host manifests
pin declared account authority; they do not independently identify an account.
Secrets are not persisted by this code; scoped grants remain session-only. This is
a trusted owner loopback setup and does not provide production authentication,
keyring integration, multi-PC shared sessions or deployment.
