# Massion Desktop

[English](README.md) | [한국어](README.ko.md)

`apps/desktop` owns the personal macOS AgentOS surface and local lifecycle. Browser fixtures, the Tauri application, and the live daemon connection share the same React surface but have different verification boundaries.

```text
React and Vite renderer
→ Tauri host
→ Node.js bridge sidecar
→ loopback Massion daemon
→ SurrealDB
```

- The renderer does not receive the daemon URL, authentication token, or general shell and filesystem permissions.
- The Tauri host owns allowlisted native commands and the bridge lifecycle.
- The bridge translates authentication, Application queries and commands, and event streams into a bounded message contract.
- The daemon owns Work, organization, policy, Runtime, and persistent state.
- Browser development uses `createFixtureDesktopService()` and does not prove real Provider or release behavior.

See the [documentation map](../../docs/README.md) for document responsibilities and [DESIGN.md](DESIGN.md) for the visual and interaction language.

## Development

Run commands from the repository root.

```sh
pnpm --filter @massion/desktop dev
pnpm --filter @massion/desktop test
pnpm --filter @massion/desktop typecheck
pnpm --filter @massion/desktop tauri:dev
```

`dev` renders fixture data in a browser. Verify the native picker, bridge, daemon lifecycle, and restart persistence separately with `tauri:dev` or a release candidate application.
