# Massion

Massion is a personally owned AI organization that keeps responsibility for outcomes beyond a chat, model run, client window, or host session.

**Mission → organized Work → execution → independent Assurance → Records → Memory and Growth**

Read the [concepts overview](docs/product/concepts.md) for the graph, change history, Growth and core rules, including what is implemented and what remains planned.

For installation and everyday use, read the [development guide](docs/guide/README.md).

## Current candidate

This clean rebuild has a runnable, tested **development foundation**, not a finished AI product. Its controlled fixture performs actual local file/process effects, rejects an incorrect calculation, revises it, independently checks the result, and accepts an evidence-bound Record. A measured held-out improvement is adopted, applied to a second Work, and reverted without rewriting history. A document-analysis fixture uses the same Work/Records contract.

The authoritative store is a separate **SurrealDB 3.3.0** service. Actual integration tests cover atomic state/event/audit/outbox writes, concurrent revisions, idempotency, ambiguous commit readback, process crash/reopen, and backup/restore. The in-memory adapter is test-only; there is no file/SQLite production fallback.

**Evidence boundaries:** most automated model execution and memory-routing evidence uses deterministic fixtures or local HTTP mocks. A separately configured bounded-text provider path exists but is disabled without explicit matching configuration; live evidence is limited to the separately authorized [synthetic CLI smoke](docs/architecture/real-model-smoke.md). They do not demonstrate real model competence, autonomous learning, OS/VM isolation, external dot integration, production authentication, or a complete usable product. Passing storage tests does not close every product requirement. The next local interface increment is documented in [product interface](docs/architecture/product-interface.md). See [acceptance evidence](docs/acceptance/first-slice.md) and [requirements](docs/product/requirements.md).

## Install

This candidate runs from a source checkout on macOS or Linux. Install Node
**24.19.0 or a newer 24.x**, npm, Python 3 and the official **SurrealDB 3.3.0**
binary. Use the [official release assets](https://github.com/surrealdb/surrealdb/releases/tag/v3.3.0)
for your OS/architecture and verify the published SHA-256 before extracting.
The Linux amd64 checksum used by CI is recorded in
[storage configuration](docs/architecture/storage.md#runtime-and-tested-configuration).
Put `surreal` on PATH, or use its absolute path in the commands below.

```sh
git clone https://github.com/jabdori/massion.git
cd massion
node --version
surreal version
npm ci --ignore-scripts --no-audit --no-fund
```

There are no runtime npm dependencies and no build step. This is a private
development package; installation does not publish a version or create a release.

For a clean installation check without accounts or model credentials:

```sh
MASSION_SURREAL_BINARY=/absolute/path/to/surreal bash scripts/install-smoke.sh
```

The script installs locked development tools (npm registry access required), starts
owned disposable databases, runs the normal CLI with local fixtures, checks
restart, schema migration and backup/restore, then cleans up. Provider calls are
disabled. CI runs this same script in its separate `install-smoke` job.
It refuses a symlinked `node_modules`; run from a clean clone to protect shared
worktree dependencies. Each smoke stage requires executed tests with no skips or
empty test plans, so missing database configuration cannot silently pass CI.

## First run with persistent local data

From the checkout, start a separate database in one terminal:

```sh
mkdir -p .runtime/db-tmp
surreal start "surrealkv://$(pwd -P)/.runtime/database" \
  --bind 127.0.0.1:18080 --unauthenticated \
  --default-namespace massion --default-database massion \
  --temporary-directory "$(pwd -P)/.runtime/db-tmp" \
  --deny-net --deny-scripting
```

In a second terminal, from the same checkout:

```sh
MASSION_SURREAL_RPC=http://127.0.0.1:18080/rpc \
MASSION_SURREAL_NAMESPACE=massion MASSION_SURREAL_DATABASE=massion npm start
```

Wait for `Massion development workbench: http://127.0.0.1:8765`, then open that
address. The unconfigured host loads no model credentials and runs no model;
Work requiring one stays blocked until you explicitly configure and authorize a
connection. See [host connection setup](docs/architecture/cli-host-connections.md).
To try the controlled file/process scenario separately, use `npm run demo` through
the disposable launcher shown below; fixture results are not model evidence.

This is a loopback-only, single-owner development setup without authentication.
Keep both services private. Ctrl-C in the host terminal drains admitted work;
wait for `hostShutdown` with `status: "drained"` before stopping the database.
An `unsettled` result exits nonzero and requires inspection, not replay.

## Where data lives and how to upgrade

| Data | Location in the persistent example |
| --- | --- |
| Mission/Work history, conversations, members, schedules, permissions, host settings | SurrealKV directory `.runtime/database`, namespace/database `massion` |
| Sealed bounded text and runtime workspaces | `.runtime/workspaces/model-artifacts` and `.runtime/workspaces` |
| Explicit model manifest and credential references | The file passed with `--host-config`; secrets remain in their original configured source |
| Relocated restored text | The directory passed with `--restored-artifact-root`, resolved by its retained bundle |

Paths are relative to the host's working directory. Always start from the same
directory and retain the namespace/database selection. A different checkout or
working directory does not move the old files. `.runtime` is ignored by Git.
The disposable launcher **deletes its database at exit** and is for tests/demos;
it is not the persistent installation above.

Before replacing the checkout, drain and stop **every** host using the database.
Export the supported portable data below; to preserve the complete installation
(including host settings and non-text fixture files), also stop SurrealDB and
retain an offline copy of its whole data directory, workspaces and explicit
configuration. Never copy a live SurrealKV directory as a consistent backup.
Retain these originals until the upgraded host and restored evidence are checked.

On startup the host migrates legacy storage version 0 to version 1 atomically,
before HTTP admission or scheduled work. Journal format 2 and portable format v1
stay unchanged. Reopening version 1 does not rewrite history. A newer or malformed
storage version prevents startup; use the matching newer host or a separate copy
of the pre-upgrade backup. Do not edit the stored version to force a downgrade.
There is no online multi-host migration or automatic effect recovery.

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
Run offline `restore-check` to validate the exact encoded RPC byte size before a new restore; its client budget does not discover server capacity or resolve a previous unknown outcome.
See [backup CLI, limits and recovery](docs/architecture/portable-backup.md) and
[clean-restore evidence](docs/acceptance/portable-backup-evidence.md). To inspect
relocated accepted text through the normal CLI/workbench, explicitly select
`--restored-bundle /absolute/private-backup.json --restored-artifact-root /absolute/restored-text-root`.
See [normal restored reads](docs/architecture/restored-artifact-reader.md). This reads
existing restored evidence and restores no execution grants or effects.

Drain and stop the host first; leave its database running for export. For the
persistent installation above, from the checkout:

```sh
mkdir -p .runtime/backups
node scripts/backup.ts export http://127.0.0.1:18080/rpc massion massion \
  "$(pwd -P)/.runtime/workspaces/model-artifacts" \
  "$(pwd -P)/.runtime/backups/work.json"
```

The private file is created with mode 0600 and must not already exist. Keep it
outside the machine as appropriate for your own backup policy. It includes the
complete supported journal and referenced bounded text, **not** host settings,
provider configuration, credentials or arbitrary files. Unsupported non-text
artifacts fail closed; use the offline full-installation copy described above
for those. Restored pending/unknown effects retain their uncertainty.

For restore, start a second **new** SurrealKV database on port 18081, using the
first-run command with a new data path, temporary directory and default
namespace/database `restored`. Keep its host offline. Then:

```sh
node scripts/backup.ts restore-check http://127.0.0.1:18081/rpc restored restored \
  "$(pwd -P)/.runtime/restored-text" "$(pwd -P)/.runtime/backups/work.json"
node scripts/backup.ts restore http://127.0.0.1:18081/rpc restored restored \
  "$(pwd -P)/.runtime/restored-text" "$(pwd -P)/.runtime/backups/work.json"
MASSION_SURREAL_RPC=http://127.0.0.1:18081/rpc \
MASSION_SURREAL_NAMESPACE=restored MASSION_SURREAL_DATABASE=restored \
  npm start -- --restored-bundle "$(pwd -P)/.runtime/backups/work.json" \
  --restored-artifact-root "$(pwd -P)/.runtime/restored-text"
```

The destination database must be empty and the artifact root must not exist.
Retain the bundle to resolve original Record paths after relocation. The offline
size check does not prove server capacity. If restore reports an unknown outcome,
keep the bundle, staged root, database and reported restore identity; inspect them
read-only before any separate recovery. Never rerun an uncertain restore into the
same destination. To export relocated data again, use the relocation-aware API in
the [backup guide](docs/architecture/portable-backup.md#local-owner-cli).

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Unsupported Node version or TypeScript syntax errors | Use Node >=24.19.0 <25, then run the locked install command again. |
| Missing RPC endpoint, connection refused or missing namespace/database | Start the separate database first; check the exact loopback URL and namespace/database variables. There is no file-store fallback. |
| Port already in use | Stop the service that owns it or choose a free port; set `MASSION_PORT` for the host and update the RPC URL for the database. |
| Unsupported storage schema version | Stop; use a compatible newer checkout. Do not reset the marker or overwrite the data. |
| Storage feed identity is not initialized | Keep hosts stopped and retain the database. A current-version database has lost its identity; inspect the original metadata or restore a verified backup into a fresh destination. Do not invent a new identity or reset the version to bypass the guard. |
| Schema upgrade outcome unconfirmed, or shutdown unsettled | Keep the database offline from hosts, retain the original files and inspect durable state. An acknowledgement lost in transit does not prove rollback. |
| Work blocked with no provider | Configure an explicit connection and permission; installation alone does not authorize model calls. |
| Backup/restore refuses paths or an occupied destination | Use canonical absolute paths (`pwd -P`), no symlinks, a new bundle filename, a fresh empty database and a new artifact directory. Do not delete originals to bypass the check. |
| Restore size check blocked | Read the reported RPC size and independently verify server capacity; the bounded `--rpc-body-budget` option changes only the client guard. |
| Restored text unavailable | Keep both startup flags, the original bundle and its exact restored root together; ordinary startup cannot guess old paths. |
| A response or model outcome is unknown | Inspect the original operation and evidence. Do not resend merely because time passed or the host restarted. |

For a diagnostic report, include the Node/SurrealDB versions, failing command,
exit status and non-sensitive error text. Do not attach credentials or private
backup contents. The macOS case-insensitive-filesystem failure in the Turkish
inventory test is known; Linux CI remains the full durable-suite gate.

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
and restart/no-replay limits. Hosted HTTP account compatibility has not been validated; the separate [real-model smoke](docs/architecture/real-model-smoke.md) records synthetic CLI evidence.

Owners can now [attach an exact stored source to fresh Work](docs/architecture/work-sources.md), preserving original ID/version/SHA, provenance and decision through runtime inputs and Records. [Scoped acceptance evidence](docs/acceptance/work-sources-evidence.md) keeps fixture and live quality claims separate.
