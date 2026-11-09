# Apps runtime v1

- Status: implemented (first increment: manifest, pinned versions, the sandboxed worker, install and widening decision cards, Settings > Apps, the rail icon and app page, a Work room tab, and self-made apps with host-run tests).
- Date: 2026-11-06, above `feat/self-made-skills`
- Decisions: [ADR 0003](decisions/0003-members-internal-teams-model-groups-and-apps.md) §4 (an app runs in a sandboxed worker with only its declared permissions; installing and widening are owner decisions; versions are pinned by content hash) and §5 (a new or widening tool is packaged as a self-made app with an install decision card); [ADR 0002](decisions/0002-assistant-first-surface-and-independent-checks.md) §5 (two kinds of owner decision). It continues the archive's `massion.extension.v1`: a host-validated manifest, declared permissions and contributions, and views drawn by the host. Screens: experience plan v3.1 §5.1, §5.7, §6 and §10, prototype artboards B22 (app page), B22-room (Work room app tab), B23 and B23-github (Settings > Apps), B24, B24-later, B24-done (install card) and B25, B25-later, B25-done (self-made app card).
- Builds on: [Self-made skills](self-made-skills.md) (host steps, static scan, accepted-Work sources), [Surface skeleton 2](conversation-cards.md) (decision card shape and `POST /assistant/decisions`), [Settings](settings.md) (section layout).

## Problem

ADR 0003 makes an extension an app on Massion. Before the first outside app (EXT-01) the host needs a real boundary: an app's code must not reach the database, secret values, files or the network except through what it declared, and anything that widens what an app may do must wait for the owner.

## Manifest (`massion.app.v1`)

```ts
interface AppManifest {format: 'massion.app.v1'; id; name; version /* x.y.z */; description;
 permissions: {read: string[]; write: string[]; network: string[] /* exact hosts */; files: string[]; secrets: {slot; label}[]; events: string[]};
 contributes: {page?: {title}; roomTab?: {prefix /* e.g. 'PR #' */}; templates: string[]; skills: string[]; procedures: string[]; tools: string[]};
 handlers: string[] /* 'page' | 'item' | 'run' */}
interface AppPackage {manifest: AppManifest; source: string /* one script, at most 64 KiB */}
```

- Validation is exact: unknown keys, more than 16 entries in a list, a host with a scheme, path, port or wildcard, or a slot that is not a slug is refused.
- The content hash is SHA-256 of the canonical `{manifest, source}`. A version is pinned by it; before every run the host recomputes it and refuses a changed package (`Package changed after its check`).
- Static scan of the source (host rules, like skill scan rules never a candidate): hard-coded secrets, dynamic code (`eval`, `Function(`, `import(`, `require(`), hidden characters.
- Permission order: version B widens version A when any list of B has an entry not in A. Narrowing or equal is not widening.

## Apps aggregate

`assistant-conversation:apps` (kind `apps`) under the reserved prefix. Nothing is deleted.

```ts
interface App {id; name; origin: 'catalog'|'self-made'; memberId?; versions: {version; hash; package; at; check?}[]; current: number|null; enabled: boolean; removedAt?}
interface AppDecision {id; at; appId; version /* index into versions of the offer */; kind: 'install'|'widen'; state: 'open'|'later'|'done'|'stale'; answeredAt?; source?: {missionId; workId; title}}
```

| Command | Actor | Rule |
|---|---|---|
| `offer-app` | Host step | A validated, scanned package. Not installed, or removed: an `install` decision. Installed and the offer widens the current permissions: a `widen` decision. Otherwise it becomes current at once, and any open decision for the app becomes `stale` (it was asked about the version that ran before). One open decision per app; an older open one becomes `stale`. An owner request installs only a bundled catalog package, checked in `AppsService.act` at request time; replay does not compare with today's catalog, so a backup still restores after a catalog update. |
| `decide-app` | Owner | `act` makes the offered version current, and turns the app on only when it installs (first time or after removal); an update or rollback keeps the owner's off; `later` defers; `ask` reopens. A decision whose app changed since is `stale`. |
| `disable-app`, `enable-app` | Owner | Narrowing, no decision. Enabling returns to the version the owner already approved. |
| `rollback-app` | Owner | To an earlier pinned version. When it widens the current permissions it opens a `widen` decision instead. |
| `remove-app` | Owner | `current` becomes null and `removedAt` is set; the versions stay. |

- Bounds: 32 apps, 16 versions per app, 64 decisions not done.
- A self-made app (`origin: 'self-made'`) carries `memberId`, its source Work and the host check: `{tests: {passed, total}, declaredOnly, evidence}`. Its offer comes only from an accepted Work with a Record of an admitted member, and only when every host-run test passed and every call stayed inside the declared permissions; otherwise it is kept as rejected with its reason and no card opens. The tests and their expected views come from the member, so they only gate the offer: the card's Check shows what the host verified (`Declared permissions only`), not `Tests N/N passed`, until an independent evaluator supplies the expectations.

## Sandboxed worker

Each handler call is one child process: `node --permission --allow-fs-read=<runner>` with an empty environment and a 64 MiB heap. Node's permission model denies file reads and writes, child processes, worker threads, native addons and, from Node 25, the network. On Node 24 the permission model does not cover the network, so the worker starts under macOS `sandbox-exec` with `(deny network*)`; where neither applies (Node 24 on Linux) the host has no worker and refuses with `Sandbox unavailable`. The `vm` context is not the boundary: the runner removes `fetch`, `WebSocket`, `process.binding` and `process.getBuiltinModule`, and runs the app script in a `DONT_CONTEXTIFY` context (no host object behind its global) with string code generation and WebAssembly off. Only strings cross into and out of the context: the host passes no function or object in (a host-realm error or prototype would hand the app the host's `Function`), and drains the context's outbox every 2 ms, reading back nothing but strings. The script sees one object:

```js
massion.handle(name, async input => view)   // registers a handler
await massion.fetch(url, {method, secret})  // the only call out
```

- `massion.fetch` is an RPC line on stdout; the host answers on stdin. A secret belongs to an app: the adapter receives `{appId, url, method, secret}` and looks the value up by `(appId, slot)`, so an app that names another app's slot gets its own (empty) slot, never the other app's token. The host checks the URL's host against `permissions.network`, refuses any method but GET unless `permissions.write` is non-empty, and refuses a secret slot that is not declared. The secret value is attached by the host adapter; the app never receives it. With no adapter the call is refused (`No network on this host`); tests and the screenshot fixture pass a mock adapter.
- Bounds: 5 s per handler, 16 calls, 256 KiB per line, 4 workers at once (`Busy` beyond); the process is killed on any breach. The handler's result must be a view (below); anything else is refused.
- There is no database handle, no Store and no secret in the child. RPC names other than `fetch` do not exist.
- ponytail: Linux on Node 24 runs no apps; bubblewrap or seccomp, or engines at Node 25+, before the first outside app runs there.

### Views

Apps never send markup. A handler returns `{title, meta?, groups: [{title, rows: [{id, title, meta?, state?}]}], fields?: [[label, value]]}` and the host draws it with its own components.

## Surface

- **Settings > Apps** (B23): `Installed N` catalog rows (name, `version`, `On`/`Off ›`), `Self-made apps N` rows (`version · Made by 주노 · <source Work title>`), then `Recommended` catalog rows with `Install`. `Install` opens the card in the Representative's conversation. App page (B23-github): `‹ Apps`, name, `version · Installed <date>`, `Open`, `Turn off`/`Turn on`; `Permissions` (Tools, Network, Files, Token, Events), `Adds` (Member templates, Skills, Procedures, Tools, Screens), `Versions` with `Current version` and `Roll back to this version`.
- **Install card** (B24): `Install GitHub app?`, detail `GitHub · 1.4.0`, rows Read, Write, Network, Token, Events, Adds; `Install` and `Later`. `Later: Install GitHub app? · Ask again`. Done: `GitHub app installed · Remove`. While the app is installed, its newest done card (install or update) carries `Remove`.
- **Self-made card** (B25) in the member's conversation: `Install PR list fetcher?`, detail `Self-made app · Made by 주노 · 0.1.0`, rows Does, Read, Write, Network, Files, Token, Events, Check (`Declared permissions only`), Source.
- **Rail and app page** (B22): an enabled app with `contributes.page` adds a rail icon after Schedules. Its page shows the app's list in the sidebar (`App settings` at the foot) and the selected item's view; an app without an `item` handler, or a page without rows, shows the page view itself. A page response that arrives after the owner opened another app is dropped.
- **Work room tab** (B22-room): an enabled app with `roomTab.prefix` adds a tab `PR #84` when an open Work's title contains the prefix followed by a number; the tab draws the `item` view for that number.
- Labels stay in the surface's English. No explanation sentences; yellow only on the decision card.

## Routes

- `GET /assistant/apps` → `{feedId, revision, apps, catalog}`.
- `POST /assistant/apps {commandId, action}`: `install` (`catalogId`), `disable`/`enable`/`remove` (`appId`), `rollback` (`appId, version`).
- `POST /assistant/apps/view {app, handler: 'page'|'item', ref?}` runs the handler in the sandbox and returns the view. It is a JSON POST, not a GET, because it runs app code that may call out with a secret: another site cannot start it without a preflight.
- `POST /assistant/decisions` with an `app-decision:` ID answers an app decision.

## Invariants

1. An app gets only its declared permissions; the host enforces them on every call.
2. Installing, and any version that widens permissions, waits for the owner's decision. Narrowing, disabling and removing do not.
3. A version runs only while its content hash matches the pinned one.
4. An app never receives a secret value, a database handle or host markup rights.
5. A self-made app is offered only after host-run tests pass inside its declared permissions; its producer does not judge it.

## Not in this increment

- Files and events RPC (declared and shown, not callable), event triggers, member templates, skills and procedures that apps bring (listed, not installed into members).
- Setting secret values (`Token · Saved`); the host adapter resolves slots.
- An outside catalog, update checks, signatures; the catalog is the host's bundled GitHub fixture.
- The trigger that packages a member's tool (host step only, like skill proposals); using a self-made app's `run` inside member Work.
- Conversation cards contributed by apps; the `7 more ›` link in B24-done; per-app member lists (`주노, 퀼`).
- A Linux network sandbox on Node 24 (see the ponytail note).
- A link from a self-made app's source Work (B23, B25 `PR #84 review ›`) to its Work room; the title is shown as text.

## MCP and connection follow-up (E5b)

[MCP apps and connection cards](mcp-apps.md) extends this aggregate with owner-admitted MCP descriptors, pinned tool lists, durable single-send calls, scoped secret entry and opaque-origin app frames. Legacy script packages retain their existing hashes and worker path. Native transport and secret adapters remain unavailable by default pending E5a integration; fixture evidence is not a live-account claim.
