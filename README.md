# Massion

Massion is a personally owned AI organization that keeps responsibility for outcomes beyond a chat, model run, client window, or host session.

**Mission → organized Work → execution → independent Assurance → Records → Memory and Growth**

## Current candidate

This clean rebuild has a runnable, tested **development foundation**, not a finished AI product. Its controlled fixture performs actual local file/process effects, rejects an incorrect calculation, revises it, independently checks the result, and accepts an evidence-bound Record. A measured held-out improvement is adopted, applied to a second Work, and reverted without rewriting history. A document-analysis fixture uses the same Work/Records contract.

The authoritative store is a separate **SurrealDB 3.3.0** service. Actual integration tests cover atomic state/event/audit/outbox writes, concurrent revisions, idempotency, ambiguous commit readback, process crash/reopen, and backup/restore. The in-memory adapter is test-only; there is no file/SQLite production fallback.

**Evidence boundaries:** the executor and memory routing are deterministic fixtures. They do not demonstrate real model competence, autonomous learning, OS/VM isolation, external dot integration, production authentication, or a complete usable product. Passing storage tests does not close every product requirement. See [acceptance evidence](docs/acceptance/first-slice.md) and [requirements](docs/product/requirements.md).

## Run tests

Requirements: Node **24.19.0**, Python 3 for the disposable service launcher, and the official **SurrealDB 3.3.0** binary for durable tests. No runtime npm package is required.

```sh
npm run check
# This checks runtime syntax and runs tests; live-store tests are skipped without a test DB.

MASSION_SURREAL_BINARY=/absolute/path/to/surreal \
  python3 scripts/with-surreal.py -- \
  env MASSION_TEST_SURREAL_RESTART=1 \
  node --test --test-concurrency=1 tests/*.test.ts
```

The second command creates a new loopback-only disposable SurrealKV database, runs the complete suite including deliberate database termination and clean restore, stops its processes, and removes its temporary database. Never point fault-injection tests at existing data. Serial test-file execution keeps restart tests from disrupting another test file.

Strict TypeScript settings are included. Node's type stripping and syntax checks are **not static type checking**; installation of the pinned development compiler/types remains a separate verification gate until a lockfile and type-check result are recorded.

## Run the controlled scenario or workbench

```sh
MASSION_SURREAL_BINARY=/absolute/path/to/surreal \
  python3 scripts/with-surreal.py -- npm run demo

MASSION_SURREAL_BINARY=/absolute/path/to/surreal \
  python3 scripts/with-surreal.py -- npm start
```

Open **http://127.0.0.1:8765** for the development workbench. It invokes the same application workflow and reads the same authoritative Mission revision as the headless client. It deliberately labels fixture evidence. No public binding or authentication is provided. The disposable launcher erases its test DB at exit; use an explicitly managed local service to retain development data.

For an existing authorized local development service, set `MASSION_SURREAL_RPC`, `MASSION_SURREAL_NAMESPACE`, and `MASSION_SURREAL_DATABASE`. Create that namespace/database before starting the host. The host initializes its own tables. Do not expose an unauthenticated service outside loopback.

A request that loses its receipt does not silently rerun. Pending/unknown effects block further execution; recovery requires establishing the prior owner has stopped, inspecting actual outcome evidence, and an explicit resolution. General recovery UI, durable outbox workers, retained event cursors and production leases remain open.

## Repository map

- `src/domain.ts`: product invariants, pinned attempts, authority, Records, Memory/Growth and typed relation impact
- `src/application.ts`: actor resolution, command identity, expected revision and transaction boundaries
- `src/storage.ts`: SurrealDB adapter and test-only in-memory reference
- `src/execution.ts`: version-gated built-in fixtures, independent oracles and sealed snapshots
- `src/scenario.ts`: product-owned delegation and actual execution/verification orchestration
- `src/server.ts`: loopback development workbench and read API
- `docs/product`: preserved product scope and requirement ledger
- `docs/architecture`: decisions and tested storage guarantees
- `docs/acceptance`: claims, commands and remaining gates

## Historical implementation

The previous implementation and Git history are preserved in [massion-archive](https://github.com/jabdori/massion-archive). This repository has independent history and does not reuse the abandoned runtime or its data. Historical contracts inform the scope; historical tests are not evidence for this candidate.
