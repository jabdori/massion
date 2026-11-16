# ADR 0005: Desktop app, transport-agnostic protocol and adapter boundaries

> [!NOTE]
> **In short**
> - Massion 1.0 ships as a desktop app. The app is only a window; the core runs per user and keeps going with no window open.
> - Windows and core speak one protocol (commands, queries, change events) that does not depend on the transport.
> - Five replaceable boundaries (owner sign-in, secrets, execution, model connection, data location) prepare a later cloud version without building it now.
> - Secret values stay in the OS keychain and never reach the UI, settings or logs. MCP servers are a kind of app. Every tool call has a timeout, cancel and cleanup.

- Status: accepted working design; not implemented; reversible on measured evidence
- Date: 2026-11-09
- Scope: how Massion 1.0 is packaged and run on the owner's computer, how the UI and the core talk, which boundaries let a cloud version come later without rewriting the core or the UI, the desktop security defaults, how secrets are delegated to external CLIs, MCP servers as apps, tool-call timeouts, what is deferred, and the screen changes these decisions cause. Builds on [ADR 0001](0001-product-owned-core.md) (headless core, commands and queries, durable cursor), [ADR 0002](0002-assistant-first-surface-and-independent-checks.md) §5, §8, §11, §12 and §14, and [ADR 0003](0003-members-internal-teams-model-groups-and-apps.md) §4. See [Changes to earlier ADRs](#changes-to-earlier-adrs).

Sections 1–9 record the owner's decisions of 2026-11-09. Details this ADR adds to make a decision exact are marked **Proposal**. Every number is an initial default to be measured, not a fact.

## Context

Today Massion is a browser page served by a loopback development host:

- `npm start` runs `src/server.ts`, a loopback HTTP host with Host validation, same-origin checks and bounded JSON. Server-side role resolution fixes the local user to the owner identity ([Local Mission/Work interface](../product-interface.md)). This is a development boundary, not production authentication.
- The client polls the durable feed every 3 seconds while the page is visible (`src/workbench.ts:1673`). Commands carry a command identity (idempotency key), a fingerprint, an expected revision and `X-Massion-Feed`; reconnect reads a fresh feed/revision boundary and never resends ([Reconnect and conflicts](../product-interface.md#reconnect-and-conflicts)).
- Schedules tick every 30 seconds only while the host serves ([Results and schedules](../results-and-schedules.md); `src/server.ts:68`). When the owner closes the terminal that runs the host, schedules stop. ADR 0001 never said what happens when the UI closes, or when UI and core versions differ.
- Model connection secrets reach the host only as the value of an environment variable named in the host manifest ([Normal CLI host connection setup](../cli-host-connections.md)). External CLIs (Claude Code, Codex) are spawned directly with an allow-listed environment (`src/cli-agent-providers.ts:20`); they use the owner's own subscription logins from their home directories. There is no launcher, no signature check and no secret store.
- Apps are one script each in a sandboxed child process (`node --permission`, `sandbox-exec` network denial on Node 24, empty environment, 5 s per handler). Apps return view JSON and the host draws it ([Apps runtime v1](../apps.md)). App secret slots resolve through a host adapter; setting a value is not implemented. There is no MCP path.
- Host drain and run lifetime are bounded and owned ([Host drain](../host-drain.md), [Run lifetime](../runtime-lifetime.md)). The data lives in a separate SurrealDB service and an artifact root ([Storage](../storage.md)); [portable backup](../portable-backup.md) moves both to a fresh destination.

On 2026-11-09 the owner reviewed reverse-engineering notes of three desktop agent products ([Evidence](#evidence)) and decided the 1.0 shape. The notes show three Electron apps with a resident or sidecar process, hardened fuses and window defaults, enumerated IPC channels with sender checks, MCP as a first-class connection kind, tool-call timeouts and, in one product, a layered launcher for delegating secrets to an external CLI. They also show exceptions this ADR avoids: file-protocol extra privileges left on, and binaries modified after signing.

## Decision

### 1. Massion 1.0 is a desktop app; the core is a per-user daemon (AR6)

- Massion 1.0 ships as an Electron desktop app. The Electron app is a UI client only. It never holds Work, Records, memory or Growth (ADR 0001).
- The core runs as a per-user daemon, independent of any window. It keeps schedules, runs and host drain going while no UI is open. Closing the last window does not stop it.
- **Single instance.** The daemon takes a pid lock in the owner's data directory at start. A second start finds a live holder and exits without serving; the UI connects to the holder. **Proposal:** a lock is stale only when its pid is gone or its recorded process start time differs; a stale lock is taken over, never shared.
- **Sleep.** A sleeping computer pauses work; it does not fail it (ADR 0002 §14). Missed schedule slots follow the existing schedule rules; they are not replayed.
- **Stop.** Quitting Massion from the UI asks the daemon to drain under the existing bounded host drain. A forced kill cannot drain; the next start inspects originals only, as today.
- **Protocol version on every message.** UI and core put a protocol version on every command, query, reply and feed event. **Proposal:** each side declares the range it supports at connect; a message outside the other side's range is refused before admission, never partly applied.
  - The running core is older than the UI needs, and a newer core is installed: **Restart needed** with `Restart` (drain, then start the installed core).
  - No installed core supports the UI's version, or the UI is older than the core supports: **Update needed**.
  - The states appear on the connection rows and the device line (section 9, P6). While either state holds, writes stay closed and reads continue where the version allows, as in today's reconnect barrier.

### 2. UI and core speak one transport-agnostic protocol (AR7)

- The protocol has three message kinds:
  1. **Commands**, with the command identity (idempotency key), fingerprint, expected revision and feed identity they carry today. Admission, replay of the original result and conflict rules are unchanged (ADR 0001 invariants 1–3).
  2. **Queries**, bound to a feed/revision boundary as today.
  3. **Feed events**: a revision or cursor change. An event says that something changed; the UI reads it through a query. An event is never a command receipt by itself.
- **Transports.** Now: the desktop preload bridge to the Electron main process, and a user-only local socket from main to the daemon. Later: HTTPS with SSE or WebSocket. The loopback HTTP host stays a development transport.
- **The UI never knows which transport it uses.** UI code depends on one client port (send command, run query, subscribe after cursor). Each transport implements that port. No screen branches on the transport.
- **Push, not polling.** Feed events move from the 3-second poll to server push (SSE semantics on every transport). Each event carries its durable cursor. On reconnect the client resumes from the last cursor it processed (ADR 0001 invariant 6); a gap or a changed feed identity closes the write barrier and runs today's recovery read.
- **Large payloads** (artifacts, long views) are sent in chunks with a transfer identity, a sequence number and an acknowledgement. A missing or out-of-order chunk aborts the transfer; the client reads again. Chunking is a transport concern and never changes a command's identity.
- **The write path is unchanged.** Push changes how the UI learns of a change, not how a write is admitted, settled or reconciled. A lost reply is still reconciled read-only by command identity and never resent.

### 3. Five adapter boundaries for a later cloud version

The core and the UI depend on these five ports, not on their desktop implementations. A cloud version replaces implementations, not callers.

| Adapter | Desktop now | A cloud implementation would need |
|---|---|---|
| **Owner authentication** | The OS user is the owner. The daemon serves only its user-only socket; **Proposal:** it also checks the peer's user ID on each connection. The preload bridge is the only path from a window | Account sign-in (for example passkeys or OIDC), sessions bound to a device, CSRF and origin checks on HTTPS, and a tenant identity on every command. Role resolution stays server-side |
| **Secret storage** | OS keychain, keyed by `(appId \| connectionId, slot)` (section 5) | A KMS-backed secret store with per-tenant keys, access audit, and the same `(owner, appId \| connectionId, slot)` keys. Values never cross into the UI or into app code |
| **Execution environment** | Local processes: the app sandbox worker (`node --permission`, `sandbox-exec`), the external CLI launcher (section 5) and utility processes (section 4) | Containers or VMs per Work or per risky task, with declared mounts, network egress rules and the same timeout and cancel/cleanup events (section 7) |
| **Model connection** | Local subscription logins of external CLIs through the launcher, and HTTPS providers whose keys come from secret storage | API keys or OAuth tokens held in the cloud secret store. Local subscription logins do not move to a server; the model group shows such models as unavailable there |
| **Data location and backup** | A local SurrealDB service and artifact root under the owner's data directory; portable backup to a fresh destination | A managed SurrealDB per tenant (namespace or instance), object storage for artifacts, scheduled backups and restore through the same portable lineage checks |

- Each adapter refuses explicitly when its implementation is unavailable, as the app sandbox does today (`Sandbox unavailable`). No adapter falls back to a weaker one.
- No cloud implementation is built now. The boundary is the decision; section 8 lists what else is deferred.

### 4. Desktop security defaults (AR5)

1. **Electron fuses.** `RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off, `EnableNodeCliInspectArguments` off, `EnableEmbeddedAsarIntegrityValidation` on, `OnlyLoadAppFromAsar` on, `EnableCookieEncryption` on, `GrantFileProtocolExtraPrivileges` **off**. No exception is kept for convenience.
2. **Windows.** Every window runs with `sandbox: true`, `contextIsolation: true` and `nodeIntegration: false`.
3. **One preload bridge.** All channels are listed in one enum. Every handler validates the sender frame (the top frame of a Massion window loaded from the app bundle) before reading its arguments. An unknown channel or a failed check is refused and logged without its payload.
4. **Renderer CSP.** `connect-src` allows only the local core. No remote script, style or frame source.
5. **Risky work in separate utility processes:** terminal (pty), file index, app handlers and the external CLI launcher. Everything else stays in the daemon. The UI processes never run them.
6. **Signing.** Binaries are never modified after signing. Anything that must change ships as a new signed build.

While the web development host remains, its same-origin checks and enumerated routes play the role of item 3.

### 5. Secret delegation (AR1)

- **Storage.** A secret value lives only in the OS keychain, keyed by `(appId | connectionId, slot)`. It never goes to disk in plain form, into a host profile or settings, into a hash input or into a log. A profile pins the slot's identity, never its value (as manifest hashes do today). The UI shows only `Saved` or a problem state. The host process that needs a value reads it once and keeps it in its own memory until the value changes or the host stops; the kept value is never written anywhere else. (2026-11-17: before this change the keychain was read by a spawned `security` for every model request, and again for discovery, recheck and settings presence; of nine apps compared on 2026-11-16, none reads its secret store per request. Not done, waiting for a signed build: making the signed Massion program itself the reader, with a single item. Not verified: no keychain prompt has been observed on a real build.)
- **External CLIs** run only through a small launcher in its own utility process. Two kinds are distinguished by one question: does Massion hand the executable a secret?
  - **Executables Massion hands a secret to, and executables shipped inside the app** (later `gh` or `op`): refused by the launcher before anything is spawned. An executable that receives a secret needs a confinement that has been run for real, and there is none: the sandbox profile this section used started no program under a real `sandbox-exec` (issue #190) and is deleted. The slice that first needs one (for example `gh` or `op`) rebuilds it together with a test that starts a real child under the real `sandbox-exec`.
  - **Subscription CLIs the user installed** (Claude Code, Codex): Massion hands them no secret; they use the owner's own login. Checks 1, 4 and 5 apply. Check 2 does not (owner, 2026-11-16: in five comparable desktop apps no code was found that uses the signature of a user-installed CLI as a gate before running it; that search read bundles and sources and did not read every execution path). In its place the host runs the found executable with `--version` and accepts it only if the output has that CLI's shape. Check 3 is not applied, and no longer exists for any executable: of six desktop apps compared on 2026-11-16, none wraps the user's agent CLI in an OS-level sandbox on a desktop Mac (for two of them this rests on a search of the app bundle, not on source); Massion starts Claude Code with every tool off and Codex in its read-only sandbox with the listed features off; and inside the OS sandbox the CLI could not reach its own login (issue #190). With the profile gone, nothing in Massion keeps the subscription CLI from executing `/usr/bin/security` or reaching the keychain services; the CLI runs as the user, as it does when the user starts it. **Decision (2026-11-17, made by the lead; the owner left it to the lead: "내 성격 스타일 다 알잖아 내가 원하는바 그에 따른 결정을 진행하고 나한테는 왜 그렇게 했는지를 설명하는 방식으로 진행해"; the owner's question that started it, 2026-11-16: "어느 앱도 하지 않은것을 우리가 하는건 분명한 이유가 있어야 하지 않아?").** Where the wrapper came from: the first version of this ADR (commit `92b5936d`, PR #100, 2026-11-09) wrote section 5, "Secret delegation", from reverse-engineering notes of a launcher that wraps a password manager's CLI in order to delegate a credential to it (five layers: argument allow-list, signature, sandbox, scrubbed environment, pre-exec re-check), and put Claude Code and Codex, which receive no secret from Massion, in the same list; PR #111 (commit `a4a1daf3`, 2026-11-09) implemented it. That original allows everything and denies reads of one folder; this ADR widened it to "denies reads of sensitive directories" and the implementation became default-deny. No sentence of the owner asking for a sandbox around the subscription CLIs is quoted in this ADR, in PR #100 or in PR #111. A narrower wrapper in the original's shape is not built now: it would bring back, in another form, a defence nobody asked for; the slice that first hands a secret to an executable starts from the original's shape. Reasons: (a) the wrapper cannot do what it was for, because the CLI starts and works only if the things the wrapper was to keep it from (its own login in the home folder and the keychain) are opened to it; (b) inside a default-deny profile the CLI's own confinement cannot apply: Codex puts its tool children under `/usr/bin/sandbox-exec` itself (`codex-rs/sandboxing/src/seatbelt.rs`, read on 2026-11-16), and on macOS 26.6.2 a `sandbox-exec` started inside a default-deny profile failed with `sandbox_apply: Operation not permitted` while the same command inside an allow-all profile worked (a scratch run on 2026-11-16: one machine, one outer profile; the real Codex was not run); (c) the profile never once started a program (issue #190); (d) of six desktop apps compared, none wraps the user's agent CLI. **Condition:** the job the wrapper was to do, a second line if the tools-off arguments do not hold, is taken over by verifying those arguments against the real CLIs (a smoke script run by hand, not in CI). State of that verification: for **Claude Code** it was run by hand on 2026-11-17 (Claude Code 2.1.325, the cheapest model, one machine): with the product's arguments unchanged, and again with only the system instruction changed to tell the model to use tools, the model was asked to read a marker file and to create a file; in both runs the marker did not appear in the output, no file was created, and the model answered that it had no tools in the session. For **Codex**, the runs BEFORE the list change first (real CLI 0.167.1, 2026-11-17, the lead's three prompt runs — the product's arguments unchanged, a tools nudge sent as text in the user input, and a forced-tools prompt): in all three the planted marker never appeared in the output and no file was created, and in the forced run `functions.exec` was called and failed closed with "code-mode host is disabled"; that is not proof that every file read and command run was blocked. The collaboration tools, however, were declared to the model and `collaboration.spawn_agent` was called (it failed only because `--ephemeral` leaves no thread record): the argument list lacked the multi-agent switches (issue #209). AFTER the list change, on 2026-11-17, on one machine, with codex-cli 0.167.1 and model gpt-6.1-terra, the smoke script at commit `00db710` ran its four prompts (plain; a tools nudge sent as text in the user input; a forced-tools prompt; and spawn-agent with `fork_turns` "none"): all four exited 0 with the product's verdict `completed`, the only items were one `error` item (a warning) and one `agent_message`, no tool item appeared, in the fourth run no `collab_tool_call` appeared (with the old list, the same day, the forced run showed two), and the planted marker did not appear in the output. File creation, deletion and modification were NOT observed in that run: the script took both directory snapshots after the CLI run, so the comparison was empty and only the marker's content and the event stream were checked (the script now takes the "before" snapshot before the run, compares it with one taken after, and treats a deleted marker as a FAIL rather than a crash). In one single prompt run after the change (the lead's push-mode run, same day), the model could name two tools, `functions.exec` and `functions.wait`, down from nine the old list's forced run had shown. Not observed: the new list blocking `exec` or any other specific tool — no tool call was made in the four smoke runs, so what was observed is the absence of tool items, not a blocked call. The list was changed on 2026-11-17 to one fixed override list (`src/cli-agent-providers.ts`), built from Codex's own tool-less thread (`codex-rs/tui/src/temporary_structured_request.rs:46-99` at rust-v0.167.1), OpenMausBot's text-only Codex path (feature names only), and the collaboration switch `agents.enabled=false` with `features.multi_agent_v2=false` (`codex-rs/core/src/config/mod.rs:1687-1714`); keys left out: `unified_exec` (it has no effect unless pinned by managed requirements, `core/src/config/managed_features.rs:176-184`) and `unified_exec_tty` (with `features.shell_tool=false`, no exec tool exists for it to configure). Whether the new list holds with the fixed file comparison (file creation, deletion and modification actually checked) is NOT YET VERIFIED — the lead fills this line after running the fixed `scripts/smoke-codex-tools-off.mjs` by hand. The smoke script cannot see: a tool call that leaves no item in the JSON stream; a marker that was read but not printed; file changes outside the run's temporary directory, or a file created and deleted within the same run (inside that directory it compares a snapshot taken before the run with one taken after it — created, deleted and modified entries recursively, and marker.txt's content; a deleted marker is a FAIL, not a crash). Limits of the guarantee: a Codex version newer than the verified one may declare a tool the list does not cover; what still stands then is Codex's own read-only sandbox (it blocks writes; it does not block reading files) and Massion's widened result check, which cannot see function-style calls — `exec`, goals and V2 collaboration messages are dropped from the `codex exec --json` stream (`codex-rs/exec/src/event_processor_with_jsonl_output.rs:244-324` maps SendMessage, FollowupTask, InterruptAgent, ListAgents and Interrupted to `None`, and other payloads fall through to `_ => None`). Codex can also re-route the model mid-turn: `codex exec --json` reports it only as one completed `error` item whose free text reads `model rerouted: <from> -> <to> (<reason>)` (`codex-rs/exec/src/event_processor_with_jsonl_output.rs:496-508`), and no structured field of any stream event carries the re-route or the model that actually answered (`thread.started` carries only `thread_id` and `turn.completed` only token usage, `codex-rs/exec/src/exec_events.rs:36-68`), so a re-routed answer is accepted as completed and stays labelled with the requested model; the conversation's settlement counts the error items (`warnings`) so the report stays visible. An organisation account's requirement pins rank above `-c` overrides and can turn a feature back on; that is outside what Massion can close before a run. `--ignore-user-config` does not stop a `hooks.json` of the Codex home from being loaded (`config/src/loader/mod.rs:520-532`, `hooks/src/engine/discovery.rs:178,390-394`); the list turns `features.hooks` off. Deliberately not done, each for the same reason — it would rebuild, around a self-updating CLI, the verification tower this section removed, and no comparable app does it: no run-time feature discovery, no version pin, no private Codex home. The smoke script is run whenever the installed Codex version changes; the Claude Code hand check is repeated when the installed Claude Code version changes. Check 4 applies to the variable names as before; the value of `PATH` is the search path the CLI was found on (the fixed install folders and the login shell's `PATH`), because an npm-installed CLI needs its interpreter. **The `PATH` value is part of the same decision (the lead's; it was put to the owner together with the isolation and not answered separately).** The refusal list of variables that inject code into a process (`NODE_OPTIONS`, `DYLD_*`, `LD_*` and the like) stays for both kinds.
  1. **Arguments.** A fixed allow-list of argument patterns per target, with length and character-set checks. No argument may start with `-` unless the pattern fixes it.
  2. **Signature.** The target binary's code signature is checked by team ID and identifier before use.
  3. **Sandbox.** Not applied, and deleted. No executable is wrapped in an OS sandbox profile: the profile that stood here started no program under a real `sandbox-exec` (issue #190). An executable Massion would hand a secret to is refused rather than run without confinement.
  4. **Environment.** The environment is emptied; only names the target declares are set.
  5. **Re-check.** Immediately before exec the launcher compares the binary's device, inode, size and modification time with the checked values, and refuses on any difference.
- **What each check has been shown to do (2026-11-16).** A check is listed as kept only with what a test that runs for real shows about it.
  1. Arguments: enforced in the launcher before dispatch; tested with the real launcher code (`tests/secret-launcher.test.ts`) and without any injected adapter (`tests/cli-launcher-real.test.ts`).
  2. Signature: until 2026-11-16 it refused every executable, because the requirement was given to `codesign` as a file path (issue #195); with the fix merged (requirement as text, tested on the macOS runner) `verifySignedCli` accepts a correctly signed executable. It now applies to a pinned-signature policy without secrets, unwrapped; an executable Massion hands a secret to is refused outright.
  3. Sandbox: not applied; the profile no longer exists for any executable. Until its deletion it started no program under a real `sandbox-exec` (issue #190); no external CLI ever ran inside it. A policy that hands a secret to an executable is refused before anything is spawned (`tests/cli-launcher-real.test.ts`).
  4. Environment: a real child process launched with no injected adapter receives exactly the declared names and the `PATH` value (`tests/cli-launcher-real.test.ts`).
  5. Re-check: a file replaced after it was checked is refused before exec with nothing spawned; tested with real files and no injected adapter (`tests/cli-launcher-real.test.ts`).

  Two paths start the user's `claude` or `codex` without the launcher, and always did: the discovery probe that runs `--version` (`src/subscription-cli-discovery.ts`) and the login status and login commands (`src/connection-logins.ts`). Each applies the stamp re-check (the probe takes the stamp before its `--version` run and compares it after; the login run compares it immediately before exec, with one rediscovery) and its own environment allow-list with the discovered `PATH` value; neither applies the argument allow-list (the arguments are fixed in host code), the signature check or an OS sandbox.

  Verified by hand, not in CI: the arguments that keep Claude Code tool-free (`--tools ''`, `--setting-sources ''`, `--strict-mcp-config`) held against the real CLI on 2026-11-17 (Claude Code 2.1.325, one machine, two runs, the second with the system instruction telling the model to use tools). For Codex, `--sandbox read-only` with the listed features off has the 2026-11-17 smoke record of section 5 (four runs: no tool item, marker not leaked); file creation and deletion were not compared in that run (section 5), and the fixed script's second hand run is NOT YET VERIFIED.
- **Delegation scopes.** A credential delegated to a CLI carries a scope fixed in host code. The default is read-only. A wider scope is a change to permissions, the second kind in ADR 0002 §5, and is granted only through a decision card at the moment it is needed. Issuance is capped per Work and per day (**Proposal:** initial caps fixed in host constants and measured).
- A model or app never sees a secret value; the launcher and the host adapter attach it.

### 6. MCP servers are an app kind (AR3)

- The app manifest gains `kind: 'mcp'` beside today's script apps. An MCP app declares exactly one network host: its server.
- **Tool list pinned like a version.** The host hashes the canonical tool list (names, descriptions, input schemas and declared read-only flags) and pins it with the app version. On connect the host compares. Added or changed tools are a widening: the new list is not used until the owner answers a decision card (ADR 0003 §4). Removed tools are a narrowing.
- **OAuth** runs through the system browser, never an embedded window. Tokens go into secret slots (section 5).
- **Tool results are data, not instructions** (ADR 0002 §11, invariant 6).
- **Write tools are single-send effects** (ADR 0002 §12). A tool counts as a read only when the pinned list declares it read-only; an unclear tool is a write.

### 7. Tool-call timeouts, cancel and cleanup (AR4)

- Every tool call has a host timeout. The value is a host constant, versioned and pinned per Work, never an owner setting: MCP calls 180 s by default; app handlers keep 5 s.
- A **read** call that times out is a failure.
- A **write** call that times out is an unknown outcome. It is never resent. The existing exception card shows it.
- On owner stop or a timeout the host sends cancel and resource-cleanup events to the sandbox or server, then ends the process after a bounded grace. A cancel does not prove the remote side stopped.

### 8. Deferred

- **App-drawn UI (AR2).** 1.0 keeps host-rendered app views. If app UI is ever allowed, all of these come first: a separate origin per app; preload validation of protocol, port, absence of credentials and host suffix; a closed enum bridge API; a CSP whose `connect-src` is generated from the manifest network and whose `frame-src` allows only the app origin; and no effects inside the app UI. Effects go through the bridge to host decision cards only.
- **VM execution tier (AR8).** Process sandboxes stay the only tier in 1.0.
- **Menu bar icon and quick entry window.**

### 9. Screen consequences

Recorded here; the details live in the screen contracts (prototype contracts and the [experience plan](../../product/experience-plan.ko.md)).

- **Light theme following the system.** Tokens split into role → palette. Yellow means a decision and red an exception in both themes.
- **New screens:** B1-first (finding the first job), B2-offline (a send-failure line under the composer instead of a banner), B13-general (Settings > General, with notifications and app version), B14-usage (Settings > Usage), a memory section on the member page (B19), B21-done (right after a member is made), B24-connect (install card for an app that needs a connection), B26 (budget decision card).
- **Small spec items P1–P10:** sidebar width token, work pane width ratio, motion tokens, focus ring and composer maximum height, the activity toggle's needs-attention state, connection row states (`Update needed`, `Restart needed`), the token expired state, live regions and a skip link, the scroll-to-bottom button, member switching shortcuts.

## Invariants at the boundaries

1. ADR 0001 is unchanged in substance. The daemon is the one authoritative headless core. The UI is a client of commands and queries on any transport.
2. A transport never changes write semantics. Command identity, fingerprint, expected revision, read-only reconciliation and no resend hold on every transport.
3. A feed event is a hint to read, never a receipt, a grant or a settled outcome.
4. A protocol version mismatch refuses the message before admission. It is never partly applied.
5. A secret value is never in a file, profile, hash input, log, model prompt, app process or UI.
6. An external CLI runs only through the launcher, and only after the pre-exec checks that apply to its kind pass: the signature check for an executable with a pinned signature, the `--version` shape check for subscription CLIs the user installed. No kind is wrapped in an OS sandbox. An executable Massion hands a secret to is refused, not run: no confinement for it has ever run for real.
7. Widening an app's tools, network or a delegation scope is an owner decision at the moment of change (ADR 0002 §5).
8. A timed-out write is unknown and never resent.
9. An adapter that is unavailable refuses; it never falls back to a weaker implementation.

## What is not decided

- How the core runtime is packaged (a signed bundled Node runtime or a single executable). `RunAsNode` off rules out running the core through the Electron binary.
- How the daemon is registered and started (login item, launch agent) and how it supervises the local SurrealDB service. ADR 0001's separate-service boundary is assumed to hold.
- Auto-update: channel, signature verification of updates, and when a downloaded core replaces the running one.
- Exact protocol version ranges, the chunk size and the acknowledgement window.
- Platforms other than macOS. The keychain, code-signature and sandbox-profile mechanisms named here are macOS ones; elsewhere the adapter refuses until an equivalent exists.
- Local stdio MCP servers. Section 6 covers remote servers; a local server would also need the launcher.
- Ephemeral sign-in keys for members that must log in to a service (memory only, re-issued per session, PIN asked by the host).
- Issuance cap values and the read-only scope suffixes per delegated tool.
- Whether telemetry or crash reporting exists at all.

## Alternatives and replacement criteria

- **Stay a browser page on a loopback host.** Rejected for 1.0. Schedules stop with the host process, there is no OS secret store, and the owner would run a terminal. Kept as the development transport.
- **Run the core inside the Electron main process.** Rejected. Closing the app would stop schedules, the core would follow Electron's Node version instead of its own, and `RunAsNode` must stay off. Revisit if the daemon's start, update and supervision cost measurably more than they save.
- **Another shell (Tauri or a native app).** Not chosen. Electron gives tested fuses, sandboxed renderers and utility processes. Revisit if measured install size, memory or start time fail the 1.0 targets.
- **Keep polling the feed.** Rejected. Polling delays decision cards by up to the interval and costs reads while nothing changes. Revisit if push cannot resume reliably from a cursor in measurement.
- **WebSocket for the desktop feed.** Not chosen now. The feed is one-way; SSE semantics suffice. A WebSocket transport may come with the cloud version under the same port.
- **Secrets in environment variables or an encrypted file.** Rejected. Environment values leak to child processes and crash reports; a file needs its own key management. The keychain is the OS's store.
- **Spawn external CLIs directly, as today.** Rejected once secrets are delegated. Revisit only if the launcher's checks block a supported CLI and no allow-list pattern can express it.
- **Let MCP tool lists float.** Rejected. A server could add a write tool or change a description without the owner seeing it.
- **App-drawn UI now.** Deferred (section 8). The host-drawn model has a smaller attack surface.

## Consequences

- The transport layer needs a protocol version field, a client port with two implementations (development HTTP, desktop bridge and socket), push with cursor resume, and chunked transfers.
- Schedules move from "while the host serves" to "while the daemon runs". Host drain becomes the daemon's quit path.
- [Normal CLI host connection setup](../cli-host-connections.md) changes its secret source from an environment variable to the keychain on desktop; the manifest keeps naming slots, not values. [Apps runtime v1](../apps.md) gains `kind: 'mcp'`, the tool-list hash, keychain-backed slots and the timeout rules.
- `src/cli-agent-providers.ts` moves behind the launcher; its environment allow-list becomes the declared-names list per target.
- Desktop security needs packaging tests that read the fuses and window options from the built app, and a test that every bridge handler checks the sender frame.
- Order: (1) the client port and protocol version over the development transport; (2) push with cursor resume; (3) the daemon with pid lock and drain on quit; (4) the Electron shell with section 4 defaults; (5) keychain and the launcher; (6) MCP apps and timeouts; (7) the screen items of section 9.

Revisit this ADR when a packaging gate fails, when push cannot resume from a cursor, when the launcher cannot verify a supported CLI, or when a cloud version is started. Record the evidence and the replacement.

## Evidence

- Reverse-engineering notes of Codex Desktop v26.1103, Claude Desktop 4.23118.0 and Grok Bot 0.78.5 (owner-private). Only patterns and measured values are used: a resident core process with a pid lock and two version states; a single upstream channel with chunked, acknowledged transfers and versioned messages; fuse and window hardening; an enumerated channel list with sender-frame checks on every handler; risky work in utility processes; MCP as a connection kind with a 180-second default tool timeout and cancel and cleanup events; a layered secret-delegation launcher (argument allow-list, signature check, sandbox profile, scrubbed environment, pre-exec file re-check) with read-only scopes and issuance caps; isolated app UI with per-app origins and manifest-derived CSP. Avoided patterns from the same notes: file-protocol extra privileges left on, and binaries modified after signing. No code or text from these products is reproduced.
- Massion sources: [Local Mission/Work interface](../product-interface.md), [Normal CLI host connection setup](../cli-host-connections.md), [Apps runtime v1](../apps.md), [Host drain](../host-drain.md), [Run lifetime](../runtime-lifetime.md), [Storage](../storage.md), `src/workbench.ts:1673` (3-second poll), `src/server.ts:68` (schedule tick), `src/cli-agent-providers.ts:20` (CLI environment allow-list).

## Changes to earlier ADRs

- **ADR 0001, Decision.** "`src/server.ts`: loopback development workbench and narrow headless transport" now reads: the loopback HTTP host is a development transport; the product transport is the protocol of section 2. The core runs as a per-user daemon (section 1). The closing evidence gate stands: packaging and deployment claims still need actual evidence.
- **ADR 0002 §11.** "Received text is data" also covers MCP tool results (section 6).
- **ADR 0002 §12.** Tool calls gain host timeouts; a timed-out write is unknown and never resent (section 7).
- **ADR 0002 §14.** "A sleeping host pauses work" applies to the daemon; schedules no longer depend on an open UI.
- **ADR 0003 §4.** Apps have two kinds, script and `mcp`. Secret slots are keychain-backed. App views stay host-drawn; app-drawn UI waits for the conditions in section 8.

ADR 0004 is unchanged. Its 2-second discriminator timeout is a model call bound, not a tool call.
