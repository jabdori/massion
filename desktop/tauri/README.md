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

## Test without opening a window

    cargo test --manifest-path desktop/tauri/Cargo.toml --workspace   # macOS
    cargo test --manifest-path desktop/tauri/carrier/Cargo.toml       # anywhere: no webview packages
    node --test desktop/tests/client-relay.test.ts desktop/tests/client-relay-runner.test.ts desktop/tests/tauri-client.test.ts

Never run "cargo tauri dev", "tauri dev" or the built binary from an agent
session: they open a window. Window-level behaviour is verified by the owner
on the first real build.
