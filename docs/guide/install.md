# Install and run the development build

You need macOS or Linux, Node 24.19.0 or a newer **24.x**, npm, Python 3 and
SurrealDB **3.3.0**. Use the verified official database download described in
[the installation instructions](../../README.md#install).

```sh
git clone https://github.com/jabdori/massion.git
cd massion
npm ci --ignore-scripts --no-audit --no-fund
```

Keep this checkout and its data private. The development workbench has no public
sign-in protection and must stay on this machine.

## Start with data that survives a restart

From the checkout, in one terminal:

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

Open the address printed by Massion, normally `http://127.0.0.1:8765`.
Leave both terminals running. Starting with a different folder or database name
does not move your previous data.

## Desktop window

The optional Electron development app uses the same workbench. Follow
[desktop setup](../../desktop/README.md#run), including its database environment.
It needs its own managed host; it refuses to attach to the bare web host above.
Stop the bare host before starting the desktop app on the same port. Desktop data
lives in the app's own data folder, rather than automatically sharing this
checkout's workspaces. This app is unsigned and does not install Node or SurrealDB.

## Stop or update

For the web host, press Ctrl-C and wait for a drained shutdown before stopping
the database. Closing a desktop window leaves its host running; use **Quit** to
stop it. An unsettled shutdown needs inspection before you start more work.

[Back up](backup-restore.md) before replacing the checkout. Stop every host that
uses the database before upgrading; retain your original files until you have
checked the updated installation. Do not change a stored version to force a
rollback.
