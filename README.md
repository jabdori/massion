# Massion

Massion is a personally owned AI organization that keeps responsibility for outcomes beyond a chat, model run, client window, or host session.

**Mission → organized Work → execution → independent Assurance → Records → Memory and Growth**

## Current candidate

This clean rebuild has a runnable, tested **development foundation**, not a finished AI product. Its controlled fixture performs actual local file/process effects, rejects an incorrect calculation, revises it, independently checks the result, and accepts an evidence-bound Record. A measured held-out improvement is adopted, applied to a second Work, and reverted without rewriting history. A document-analysis fixture uses the same Work/Records contract.

The authoritative store is a separate **SurrealDB 3.3.0** service. Actual integration tests cover atomic state/event/audit/outbox writes, concurrent revisions, idempotency, ambiguous commit readback, process crash/reopen, and backup/restore. The in-memory adapter is test-only; there is no file/SQLite production fallback.

**Evidence boundaries:** demonstrated model execution and memory routing use deterministic fixtures or local HTTP mocks. A separately configured bounded-text provider path exists but is disabled without explicit matching configuration; no live model has been tested. They do not demonstrate real model competence, autonomous learning, OS/VM isolation, external dot integration, production authentication, or a complete usable product. Passing storage tests does not close every product requirement. The next local interface increment is documented in [product interface](docs/architecture/product-interface.md). See [acceptance evidence](docs/acceptance/first-slice.md) and [requirements](docs/product/requirements.md).

## Run tests

Requirements: Node **24.19.0**, Python 3 for the disposable service launcher, and the official **SurrealDB 3.3.0** binary for durable tests. No runtime npm package is required. Development checks use pinned TypeScript 7.0.2 and Node types 24.19.1.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
# Strict static types, runtime syntax and tests; live-store tests need a test DB.

MASSION_SURREAL_BINARY=/absolute/path/to/surreal \
  python3 scripts/with-surreal.py -- \
  env MASSION_TEST_SURREAL_RESTART=1 \
  node --test --test-concurrency=1 tests/*.test.ts
```

The second command creates a new loopback-only disposable SurrealKV database, runs the complete suite including deliberate database termination and clean restore, stops its processes, and removes its temporary database. Never point fault-injection tests at existing data. Serial test-file execution keeps restart tests from disrupting another test file.

`npm run typecheck` runs the pinned compiler with strict settings and unchecked-index protection. `npm run check` includes that static gate before runtime checks. Node's type stripping by itself is not static checking. The lockfile pins development dependencies; CI installs them without lifecycle scripts.

## Run the controlled scenario or workbench

```sh
MASSION_SURREAL_BINARY=/absolute/path/to/surreal \
  python3 scripts/with-surreal.py -- npm run demo

MASSION_SURREAL_BINARY=/absolute/path/to/surreal \
  python3 scripts/with-surreal.py -- npm start
```

Open **http://127.0.0.1:8765** for the development workbench. It invokes the same application workflow and reads the same authoritative Mission revision as the headless client. The default surface accepts user-authored Missions and Work, displays lifecycle/blockers/evidence, records steering and cancellation, and catches up through durable event cursors. With no real provider configured, user Work is explicitly blocked; it never falls back to the separately labeled development fixture. No public binding or authentication is provided. The disposable launcher erases its test DB at exit; use an explicitly managed local service to retain development data.

For an existing authorized local development service, set `MASSION_SURREAL_RPC`, `MASSION_SURREAL_NAMESPACE`, and `MASSION_SURREAL_DATABASE`. Create that namespace/database before starting the host. The host initializes its own tables. Do not expose an unauthenticated service outside loopback.

A request that loses its receipt does not silently rerun. Pending/unknown effects block further execution; resuming execution requires establishing the prior worker has stopped, inspecting actual outcome evidence, and an explicit resolution. Terminal owner quarantine is available below without claiming that proof. General continuation controls, durable outbox workers, event retention/snapshot fallback and production leases remain open.

For the opt-in provider path and its remaining live-service gates, see [configured execution](docs/architecture/configured-runtime.md). No account or credential is loaded by default.

## Owner handling of interrupted runs

The loopback owner interface can permanently quarantine a configured run with
pending or unknown effects. It records the owner and reason, preserves reservations
and history, and marks missing receipts unknown without inventing a provider result.
Quarantine prevents later Work progression; an already admitted external effect may
still execute. It does not resume completion or permit replay. See the
[protocol and limits](docs/architecture/owner-quarantine.md).

## Portable Work backup

The bounded text runtime now has a versioned private bundle containing the complete
Mission operation history plus every referenced sealed text artifact. Restore into
a fresh SurrealDB and new artifact root preserves original Records and command
identities, verifies relocated bytes, and holds old outbox rows without replay.
See [backup CLI, limits and recovery](docs/architecture/portable-backup.md) and
[clean-restore evidence](docs/acceptance/portable-backup-evidence.md).

## Repository map

- `src/domain.ts`: product invariants, pinned attempts, authority, Records, Memory/Growth and typed relation impact
- `src/application.ts`: actor resolution, command identity, expected revision and transaction boundaries
- `src/storage.ts`: SurrealDB adapter and test-only in-memory reference
- `src/execution.ts`: version-gated built-in fixtures, independent oracles and sealed snapshots
- `src/scenario.ts`: product-owned delegation and actual execution/verification orchestration
- `src/product.ts` / `src/providers.ts`: user Work admission and explicit provider/runtime gates
- `src/http-provider.ts` / `src/configured-runtime.ts`: opt-in bounded provider execution and independently bound review
- `src/text-artifacts.ts`: bounded text data, content-addressed snapshots and fresh hash checks
- `src/server.ts` / `src/workbench.ts`: loopback Mission/Work interface, interventions and event catch-up
- `docs/product`: preserved product scope and requirement ledger
- `docs/architecture`: decisions and tested storage guarantees
- `docs/acceptance`: claims, commands and remaining gates

## Historical implementation

The previous implementation and Git history are preserved in [massion-archive](https://github.com/jabdori/massion-archive). This repository has independent history and does not reuse the abandoned runtime or its data. Historical contracts inform the scope; historical tests are not evidence for this candidate.

## Select execution connections

A configured host can expose multiple connection/model profiles and explicit
per-Work executor/verifier choices in the workbench and headless API. The first
implemented protocol is OpenAI-compatible Chat Completions; ACP is a future
session adapter, not a fake selectable provider. Configuration and authorization
remain disabled by default. See [connection selection and extension
contracts](docs/architecture/provider-selection.md) for scope, authentication,
preflight, usage limits and the Hermes/ACP design reference.

The [Work-aware preflight evidence](docs/acceptance/workbench-preflight-evidence.md)
covers explicit selection, two-call budget guidance, side-effect-free checks,
stale-result rejection and client/HTTP/SurrealDB reload integration. These tests
use fixture providers; they do not establish live-model or browser-rendering quality.

## Configure host-owned model connections

The normal CLI supports an explicitly selected, versioned non-secret host manifest.
It enrolls only declared connections/models and binds credential references to exact
destinations. HTTPS model calls still require a separate startup option, scoped
executor/verifier permission, current preflight and explicit Run. The unconfigured
CLI reads no provider credential. See [CLI host setup](docs/architecture/cli-host-connections.md)
for the manifest, lazy environment binding, credential-free loopback fixture mode
and restart/no-replay limits. No live account has been validated.
