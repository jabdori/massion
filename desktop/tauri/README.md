# Massion Tauri 2 host (development skeleton)

The Tauri shell beside the Electron shell. Rust owns the window, the two
custom URI schemes (massion and massion-app), the four deny callbacks
(navigation, new window, permission request, download), single instance and
native notifications. Every relay rule — allowed paths, the 48 KiB body limit,
authenticated calls to the core, app-document publishing, the CSP and the
notification decision — lives on the daemon side in desktop/client-relay.ts,
served as the "client" connection kind on the supervisor's user-only socket.
Rust carries lines only: no secret, core address, HTTP client or
authentication logic ever enters this process.

## Run against a development core (a human with a screen)

    npm ci --ignore-scripts --no-audit --no-fund
    npm run build --prefix desktop
    MASSION_SURREAL_RPC='ws://127.0.0.1:8000' cargo run --manifest-path desktop/tauri/Cargo.toml

| Setting | Purpose | Default |
| --- | --- | --- |
| MASSION_SURREAL_RPC | Database address, so the daemon can start the core | none; required for a new daemon |
| MASSION_DAEMON_ORIGIN | Explicit loopback origin for the managed daemon (read by the supervisor itself) | http://127.0.0.1:8765 |
| MASSION_NODE_BINARY | Node 24 executable for the supervisor | node on PATH |
| MASSION_DESKTOP_HTML | App document location for the relay | desktop/dist/index.html |

The daemon is started detached (new process group, private log beside the
socket) and survives the app; it is stopped only by an explicit drain.
If the app dies during start, the database TLS key and certificate
("database-tls.key" and "database-tls.crt" in the data directory) stay on
disk until the next start, which removes both files before creating a fresh
pair ("removeTlsFiles" before the exclusive "wx" creation in
desktop/daemon-runner.mjs), so a killed start never leaves a stale pair for
the next start to trip over.

## The packaged app (built in CI only)

desktop/tauri/stage-package.mjs stages the whole package tree into
desktop/tauri/package/ (the core sources, the daemon-side relay and its
siblings, the built app document, the version file and the screen copy) and
the two sidecar executables into desktop/tauri/binaries/; "tauri build
--config packaged.conf.json" merges the externalBin and resources entries
from that overlay and bundles them into an unsigned development .app. The
overlay exists because tauri-build validates those paths on every cargo
build, and a plain build or test must not need staged binaries.
The supervisor is started through the same ensure_supervisor path as in
development, with the app's data directory as its working directory, and
starts the bundled database through the managed start (keeper, marker
recovery, password file, TLS with the start certificate). No node_modules
enters the package: the runtime has zero npm dependencies.

One check-only environment variable, MASSION_INSTALL_CHECK, exists (set =
install check; unset or empty leaves every check behaviour inert). It grants
nothing: it only makes the app write a status file with a closed key list
inside its own data directory and quit. The variable is read in exactly one
place in the sources (the Rust host), which passes the status-file path to
the supervisor as an argument; the variable itself never enters any child
environment.

## Test without opening a window

    cargo test --manifest-path desktop/tauri/Cargo.toml --workspace   # macOS
    cargo test --manifest-path desktop/tauri/carrier/Cargo.toml       # anywhere: no webview packages
    node --test desktop/tests/client-relay.test.ts desktop/tests/client-relay-runner.test.ts desktop/tests/tauri-client.test.ts

Never run "cargo tauri dev", "tauri dev" or the built binary from an agent
session: they open a window. Window-level behaviour is verified by the owner
on the first real build.
