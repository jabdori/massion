# Default execution route and persistent connections

- Status: implemented (server side, fixture-class evidence). Workbench controls are a later increment.
- Date: 2026-11-05, above `5c75629` (main)
- Requirements: RUN-01, WRK-01, GOV-01, GOV-02 in [requirements](../product/requirements.md); item 1 of [Next implementation order](../product/scope.md#next-implementation-order); [ADR 0002](decisions/0002-assistant-first-surface-and-independent-checks.md) "Consequences and evidence gates" item 1; [experience plan v3](../product/experience-plan.ko.md) §5.8 and §14.3
- Builds on: [Explicit execution connections and model selection](provider-selection.md), [Normal CLI host connection setup](cli-host-connections.md), [Provider connection setup](provider-connections.md), [Configured runtime](configured-runtime.md), [Bounded local Work admission capacity](host-admission.md), [Portable backup](portable-backup.md), [ADR 0001](decisions/0001-product-owned-core.md)

## Problem

Every Work needs four manual choices before it can run: executor profile, verifier profile, authorization and output-token cap. A host restart then loses every grant, so the owner has to grant again before the next Work. The experience plan names this the first dogfooding blocker: permissions and the default executor/verifier must survive a restart for daily use (§14.3). In Settings, models are picked only when the owner wants to change them (§5.8).

This increment adds two things:

1. **Default route.** The owner saves, once per exact Mission scope, which grant (and therefore which executor and verifier) and which output cap to use. A run, check or sequence that names no selection uses that saved route.
2. **Persistent connection state.** Under a host manifest, owner model labels and output limits, grants, revocations, default routes and discovered model metadata are stored in the authoritative database and restored at startup. Secret values, secret references and environment names are never stored.

Run admission, per-run pins and recheck at admission do not change.

## Current state before this change (code evidence)

| Concern | Where | Behavior |
| --- | --- | --- |
| Connection, profile and grant state | `ConnectionWorkbench` in `src/connection-workbench.ts` | Private `Map`s `#connections` and `#profiles` and array `#grants`, all in process memory. `list()` reports `sessionOnly: true`. |
| Manifest enrollment | `ConnectionWorkbench` constructor, `compileHostBindings` in `src/host-connections.ts` | With `--host-config`, each declared connection is replayed through `connect()` and each declared model through `selectModel()` with `label = model`. Connection IDs are `host:<id>:<bindingHash[0..16]>`. Profile IDs are `profile:` + `hash({connectionId, configHash, model})[0..32]`. The same manifest gives the same IDs on every start, and every profile a manifest allows already exists after enrollment. |
| Unmanaged host | `createHostConnections` | Without a manifest the workbench gets only `{transport}`: no `allowFixture`, no resolver, no live option (`loadHostStartup` refuses `--allow-live-model-calls` without an HTTPS manifest). A normal CLI host without a manifest therefore cannot create any grant. |
| Profile output limit | `selectModel()` | `maxOutputTokens = min(discovered outputTokenLimit ?? 4096, 4096)`. The limit is part of the profile, so it is part of the profile hash. |
| Grants | `authorize()` | Exact Mission `scope`, one executor and one verifier `(profileId, configHash)`, `mode`, `maxOutputTokensPerCall`. Live mode needs `allowLiveExecution`. At most 64. Nothing revokes a grant. |
| Concurrency tokens | `connect`, `selectModel`, `discover`, `authorize` | `connect()` has none. `selectModel()` and `discover()` compare the connection's `configHash`. Only `authorize()` compares `version()`. |
| Choice validation | `SelectableTextRuntime.prepare()` | A missing or partial choice gives `selection_required` (HTTP 200). Otherwise grant scope, cap, exact hashes per role, reported usage and mode/evidence class are checked. |
| Run pin | `ConfiguredTextRuntime`, `activate-runtime` in `src/domain.ts` | `RuntimeRun` records `authorizationId`, `mode`, `outputTokenCap` and `connectionBindings.{executor,verifier}.{profileId,configHash}`. |
| Entry points | `ProductService.preflight/run/runSequence`, `/missions/:id/preflight`, `/run`, `/run-sequence` | `body.selection` is passed through as is; the server did not distinguish an absent selection from `null`. |
| Sequence guard | `runSequence` in `src/run-sequence.ts` | Each step compares `hash(runtime.configuration())` with the value at entry and stops as `blocked` when it changed. |
| Storage | `src/storage.ts` | Mission aggregates in `massion_state`, journal in `massion_operation`. Catalog, inbox and backup read only Mission data. The restore guard checks only Mission/journal tables. |

## Decision summary

- **Persist only under a manifest scope.** `scope = "manifest:" + bindingHash`. Only a manifest gives stable connection and profile identities, and only a manifest host can create grants in the normal CLI. An unmanaged host stays session-only, so no connection input and no `secretRef` is ever stored.
- **Store the owner's decisions, not derived profiles.** The manifest rebuilds connections and profiles. The stored document carries each selection's label and captured output limit, the grants, the revocations and the default routes.
- **One table outside the Mission journal.** `massion_host_settings` in the existing SurrealDB service (ADR 0001: no file or SQLite fallback). A Mission aggregate is ruled out: catalog, inbox and backup would read it as Mission data, and portable backup must not carry provider configuration.
- **Default route per exact grant scope, taken from the grant itself.** Resolution names one route by exact `mission.scope` or fails. No fallback.
- **Resolution at the `ProductService` boundary** turns an absent selection into one concrete `ExecutionChoice`, which then goes through the unchanged `preflight`/`run` path.
- **Fail closed while a settings write is in flight or unknown.** Every check, run and second change is refused until the outcome is known.

## Stored shape and location

### Table

`SCHEMA_QUERY` gains `DEFINE TABLE IF NOT EXISTS massion_host_settings SCHEMALESS`. The feed `schemaVersion` stays 2. The table never joins `massion_operation`, `massion_event` or the feed cursor; a settings write is not a Mission event.

Two row kinds share the table:

```
massion_host_settings:⟨sha256("settings\0" + scope)⟩   {kind:'settings', scope, revision ≥ 1, writeId, updatedAt, settings: HostSettingsV1}
massion_host_settings:⟨sha256("discovery\0" + scope + "\0" + connectionId)⟩   {kind:'discovery', scope, connectionId, configHash, models, hasMore}
```

```ts
interface HostSettingsV1 {
  version: 1;
  selections: {connectionId: string; connectionConfigHash: string; model: string; label: string; maxOutputTokens: number}[]; // ≤ 64, Map order
  authorizations: ExecutionAuthorization[];   // ≤ 64, exact existing shape, array order
  defaultRoutes: DefaultRoute[];              // ≤ 64, at most one per grant scope
  revokedAuthorizationIds: string[];          // ≤ 320 (authorize refuses once 256 are used)
}
interface DefaultRoute {
  authorizationId: string;                    // the scope comes from the grant, never copied
  executor: {profileId: string; configHash: string};
  verifier: {profileId: string; configHash: string};
  outputTokenCap: number;
}
```

There is no `connections` field: the manifest is the only source of connections. Load validates every field exactly (unknown fields reject the whole document, so a raw-credential field can never be restored), the label/model rules of `selectModel`, `1 ≤ maxOutputTokens ≤ 4096`, and that grant and revoked identities are unique together. A failed check stops startup with "Host settings: stored document invalid" and does not overwrite the row.

`DefaultRoute` stores both role pins, so the ADR 0002 different-family rule can be added later as one more check at set time and at resolution, reading `providerKind`/`model` from the two pinned profiles, without a storage migration.

### Selections and order

`selections` lists every current profile in `#profiles` Map order, including the ones enrollment created with `label = model`. This is written only by an owner change, never at startup. On restore the manifest enrolls first, then each stored selection is applied through the internal `#select(connectionId, model, label, expectedConfigHash, storedLimit)` with the stored limit in place of discovery. Under one manifest every allowed profile ID exists after enrollment, so re-applying overwrites in place and the Map order, and therefore `version()`, matches the original session. A selection whose connection or hash does not match the rebuilt manifest cannot happen under the same `bindingHash` without tampering, so it is treated as an invalid document.

### Discovery rows

A discovery row is a cache. It is written after a successful `discover()` (last writer wins; a write failure appends "Model metadata was not saved for restart." to the message and does not fail discovery). At startup a row is applied only when its `configHash` equals the rebuilt connection's, and only after selections, so it never changes a profile hash.

## Service API

`ConnectionWorkbench` takes an optional `settings: HostSettingsStore`. It is used only when the host has a manifest.

```ts
interface HostSettingsStore {          // src/storage.ts: SurrealHostSettings, InMemoryHostSettings
  load(scope): Promise<{revision, writeId, updatedAt, value} | null>;
  save(scope, expectedRevision, writeId, value): Promise<{status:'committed', revision, updatedAt} | {status:'conflict', revision}>;
  loadDiscovery(scope): Promise<{connectionId, configHash, models, hasMore}[]>;
  saveDiscovery(scope, row): Promise<void>;
}
```

### Synchronous apply, asynchronous save

The constructor stays synchronous and keeps enrolling the manifest through the synchronous apply functions. `createHostConnections` stays synchronous. Restore and enrollment never write.

- `connect`, `selectModel`, `authorize`, `revoke`, `setDefaultRoute`, `removeDefaultRoute` are synchronous apply functions that validate first and then change memory. Without a store they behave as before, so existing callers and tests are unchanged.
- With a store, they run only inside `save(() => apply())`. A direct call is refused.
- `restoreSettings()` is the async startup step. `server.ts` calls it after `createHostConnections` and before `listen`.

| Method | Concurrency token |
| --- | --- |
| `connect(value)` | none (rejected anyway under a manifest) |
| `selectModel(connectionId, {model, label, expectedConfigHash})` | connection `configHash` |
| `discover(connectionId, expectedConfigHash)` | connection `configHash` |
| `authorize(value)` | `version()`; also refuses an identity that is current or revoked |
| `revoke({authorizationId, expectedConfigHash})` | `version()`. Removes the grant and any route naming it, records the identity as used. Like every change it waits until no Work is active, because adopting stored state rebuilds profiles; the next admission re-validates anyway. |
| `setDefaultRoute({authorizationId, outputTokenCap, expectedConfigHash})` | `version()`. Takes executor and verifier from the grant's own pins and replaces any route for the same grant scope. Refused unless the route is usable now, which includes executor and verifier using different profiles and not the same provider kind and model. |
| `removeDefaultRoute({authorizationId, expectedConfigHash})` | `version()` |
| `resolveDefault(mission)` | pure read |

`version()` now also hashes default routes and revocations. Across processes, the row `revision` is the compare-and-set token, so two hosts on the same database cannot overwrite each other. Overwriting is not the only cross-host risk: host B would keep a grant or route that host A revoked in memory. So `run()` reads the stored row before every admission. If its revision differs from the one this host last read, the host adopts the stored state (when no Work is active) and returns `blocked` with `settings_changed`. A failed read blocks that run with `settings_pending`. Preflight stays a synchronous, advisory check and does not read the row; the run is the guarantee.

### Save protocol and fail-closed window

1. Refuse when another save is pending or a run is active.
2. If the last outcome was unknown: read the row again, adopt it, and refuse this change ("Check them before changing again").
3. Set `pending`. Apply synchronously. If nothing changed, return.
4. `save(scope, revision, writeId = randomUUID(), document)` once, never retried.
   - `committed`: keep memory, record revision and `updatedAt`.
   - `conflict`: read the row and adopt it; HTTP 409.
   - exception (outcome unknown): read the row once. Our `writeId` means committed. Another `writeId` means the stored state is adopted and the change is refused. A failed read sets `unknown`.
5. Clear `pending`.

While `pending` or `unknown`, `preflight`, `run`, `resolveDefault` and every change return `settings_pending` (`run` returns `blocked`). The check is synchronous at request entry, and `run` registers its active slot synchronously, so no admission can fall between a change's start and its commit. This covers narrowing changes too: during an in-flight revoke, the old grant cannot be used, and after an unknown revoke nothing runs until the stored state is read.

## HTTP API

All routes stay under the existing loopback host, the `/connections` 503 guard and drain refusal.

| Route | Body | Result |
| --- | --- | --- |
| `GET /connections` | — | `sessionOnly: false` and `persistence: {durable, scope, revision, updatedAt, status: 'saved'|'saving'|'unknown', secretValuesStored: false}` when persistent (otherwise `persistence: null`). `grants: [{id, scope, mode, maxOutputTokensPerCall, status: 'active'|'stale'|'live-disabled', diagnostics}]`, `revokedAuthorizationIds`. |
| `POST /connection-authorizations` | existing fields | `list()` |
| `POST /connection-authorizations/revoke` | `{authorizationId, expectedConfigHash}` | `list()` |
| `POST /connection-defaults` | `{authorizationId, outputTokenCap, expectedConfigHash}` | `list()` |
| `POST /connection-defaults/remove` | `{authorizationId, expectedConfigHash}` | `list()` |
| `POST /missions/:id/preflight`, `/run`, `/run-sequence` | `selection` optional | With a resolved default, the result gains `selection: {source: 'default', choice}`. An explicit selection's result is unchanged. |

A settings conflict is HTTP 409 (`DomainError` code `conflict`). Every other refusal is 400 as before.

`runtime.configuration()` (in `/providers` and `/connections`) is `ConnectionWorkbench.configuration()`: `SelectableTextRuntime.configuration()` merged with `defaultRoutes: [{...route, scope, status, diagnostics}]`, and `selectionRequired: false` when at least one route is active. `SelectableTextRuntime` itself is unchanged; it receives only grants usable at this start (live grants are filtered out without the live option).

## Resolution when a request has no selection

The server now distinguishes absent from present: `Object.hasOwn(body, 'selection')` with a non-object value (including `null`) is **new** HTTP 400 "Selection must be an object when present". Before this change `null` reached `prepare()` and returned `selection_required`.

1. **Selection present.** Used exactly as before. Defaults are ignored. A partial selection is never merged with a default and still gives `selection_required`.
2. **Selection absent and the runtime has `resolveDefault`.** Find the route whose grant `scope` equals `mission.scope`.
   - None: `default_route_missing`. `preflight` returns `ready: false` with the admission diagnostics plus this one; `run` returns `blocked` (or `conflict`/`already-started` when the admission diagnostics say so) with the message in `reason`. `RuntimeResult` has no diagnostics field, so tests check the status and reason text. No dispatch, no reservation, no Work change.
   - Route present but its grant is not active, a pinned hash no longer matches, or the cap exceeds the grant or a profile limit: `default_route_stale` with the reasons. Nothing falls back to another route or grant.
   - Otherwise one concrete `choice` continues as in case 1. Resolution and the call into the runtime are synchronous, so no settings change can fall between them.
3. **`runSequence`** resolves once and passes the same choice to every step. A default or grant change between steps changes `configuration()` and **stops** the sequence as `blocked` through the existing configuration guard. It never switches routes mid-sequence.
4. **Budget.** The route's cap goes through `workAdmissionPreflight`; a cap that cannot be reserved twice gives `budget_exceeded`. The cap is never lowered.

`preflight` and `run` are separate requests, so a default changed between them can change what `run` uses. Such a change needs an explicit owner request with the current `version()`. A caller that needs "what I checked is what runs" sends the `selection.choice` returned by `preflight` explicitly; that is the existing exact path and needs no new field.

## Recheck at admission and pins

Nothing about admission changes. The resolved choice enters the same `prepare()` and is checked again at run admission. `activate-runtime` pins it. Revoking, changing a default, re-selecting a model or restarting never changes an admitted run, and an unknown outcome is never replayed. The domain does not record whether a choice came from a default; the pin is the evidence. Role independence stays the existing rule for explicit selections (distinct executor and verifier identities in separate calls). A default route is a standing choice, so it also requires different profiles and not the same provider kind and model; a stored route that breaks this is `default_route_stale`. The ADR 0002 family check is still not implemented.

## Restart restore

`restoreSettings()` runs before `server.listen`, after `initializeSurrealSchema`. It performs no discovery request, credential lookup, inference, dispatch or write.

1. The constructor enrolls the manifest as before.
2. Load the settings row for the scope. Missing: empty settings at revision 0. Malformed: startup fails.
3. Re-enroll, then apply stored selections in stored order with their stored limits.
4. Install grants, routes and revocations as stored. Status is computed on read, never stored: a grant is `stale` when a pinned profile is missing or its hash differs, `live-disabled` when it is live and this start lacks `--allow-live-model-calls`, otherwise `active`. Routes are `active` or `stale`.
5. Apply discovery rows whose `configHash` matches.
6. The startup log prints `{hostSettings: {revision, grants, activeLiveGrants, liveDisabledGrants, defaultRoutes}}`.

Nothing stored is silently deleted. Stale entries stay, are rewritten unchanged on the next save, are listed with a reason and are never applied. Only `revoke`, `removeDefaultRoute` or a manifest edit (a new scope) make them go away.

**Live meaning change.** Before this change, a live grant had to be created again after every restart. Now a live grant and a live default made earlier under the same HTTPS manifest become active again when the host starts with `--allow-live-model-calls`, and a selection-less run can then make a paid call without another owner action. Two explicit owner acts are still required: creating the grant (and the default) and starting with the live option. This is a deliberate decision for daily use (ADR 0002 §5: the owner decides permission changes; it does not require re-deciding a standing permission at every start). It is made visible: the startup log counts active live grants, `GET /connections` lists each grant's scope, mode and status, and every default-route result names `selection.source = 'default'` and the choice; the pinned `mode` is in the Work. [CLI host connections](cli-host-connections.md) and [provider selection](provider-selection.md) are updated accordingly. No extra confirmation on first use after restart is added in this increment.

**Third owner act: the Representative route** ([assistant conversation](assistant-conversation.md)). Setting a Representative route (`POST /assistant-settings`) lets a model classification of an owner message cause a selection-less run on this default route, recorded under the actor `assistant-representative`. There is no separate auto-start setting: the Work starts whenever the default route resolves. With no resolved default route at admission no Work is created (its budget comes from this route); a route that stops resolving after admission leaves the Work admitted and not started. Both are exceptions on its card. The startup log reports `representativeRoute` (`active`, `stale`, `live-disabled` or `off`).

Editing the manifest changes `bindingHash`, so it starts a new, empty scope. That costs the owner the grants and defaults on every manifest edit. A stable connection identity that survives manifest edits is a separate decision.

## Secrets

- The stored document contains labels, exact model IDs, Mission scopes, profile and connection hashes and output limits. It contains no secret value, secret reference, environment variable name, header or token. The manifest file stays the only declaration of value sources; `compileHostBindings` and its lazy resolver are unchanged.
- The exact-field validator rejects unknown fields on load.
- The settings table lives in the owner's SurrealDB, so a raw database export includes it. It holds no secrets, but Mission scopes and labels are private data, like the rest of the database.

## Backup and restore

Portable backup v1 is unchanged. `exportJournal` reads only `massion_operation`, so host settings never enter a bundle. `RESTORE_JOURNAL_QUERY` now also requires `massion_host_settings` to be empty, so a journal can never be restored into a database that already holds grants or defaults whose scope could match a restored Mission. After a restore there are no grants or defaults; the owner grants again. Restored Works keep their pins as evidence only.

## Local trust boundary

ADR 0001 says the loopback host is not production security. This change raises the stakes of that boundary: a local process that can reach the port can now create a grant and a default that outlive the process and, on a later start with the live option, lead to paid calls. Cross-site browser requests stay blocked (exact `Host`, `Origin` when present, `application/json` bodies with no CORS answer). A local process can forge any `Origin`, so requiring the header would not stop one; an owner token is the real fix and belongs with production authentication. The row records `updatedAt`, and `GET /connections` shows it.

## Invariants

1. A live grant is usable only when this start has `--allow-live-model-calls`. Stored grants never enable live execution by themselves.
2. No default is chosen by the host. A route exists only through an explicit owner command, and resolution names one route by exact scope or fails.
3. A default is resolved to a concrete choice before admission, and the full existing admission check runs on it.
4. An admitted run's pins never change because of a settings change, revoke, default change, discovery or restart. Unknown outcomes are not replayed.
5. While a settings write is in flight or its outcome is unknown, no check or run is admitted and no other change is accepted. An unknown outcome is resolved by reading back, never by retrying.
6. A stored entry is applied only when its hashes match the rebuilt catalog. Otherwise it is listed and inert. Restore never deletes.
7. No secret value or reference is written, logged, hashed into a profile or returned. Startup reads no credential.
8. Host settings never enter the Mission journal, the event feed, catalog or inbox reads, or portable backup, and a restore refuses a database that holds them.
9. A revoked authorization identity is never reused within one settings scope. A new scope (manifest edit, restore into a new database) starts with no tombstones; a pin stays unambiguous because it also records the exact profile bindings and cap.
11. A host admits a run only when the stored settings revision equals the one it last read.
10. Executor and verifier keep distinct identities and separate calls.

## Acceptance (tests)

`tests/default-route.test.ts`, with `InMemoryHostSettings` and fixture adapters only:

- Label change, grant and default, then a new manager over the same store: labels, grants, routes, `runtime` and `configHash` are identical, with no transport call.
- A run without a selection uses the route; the pin equals the route; the result reports `source: 'default'`.
- No route, a route only for another scope, or a partial selection: no run, no journal change, no call. A full explicit selection overrides the default.
- A stale route (re-selected label): `default_route_stale`, blocked, no call; it survives restart as stale; revoke removes it and its route; the identity cannot be reused, also after restart.
- A route whose cap cannot be reserved twice: `budget_exceeded`, never a lowered cap. A manifest edit starts an empty scope.
- `runSequence` without a selection completes with one resolved choice.
- A live grant restored without the live option is `live-disabled`, absent from `configuration().authorizations` and unresolvable; with the option it is active. The stored rows contain no secret reference or environment name. An unknown field such as `apiKey` rejects the stored document.
- Write conflict: 409-class error and the stored state is adopted. Unknown outcome whose read-back shows our `writeId`: accepted. Another `writeId`: refused and adopted. Failed read-back: `unknown`, checks blocked with `settings_pending` until the next change reads again.
- A save in flight refuses preflight, run and a second change; the schema and restore guard name `massion_host_settings`.
- Discovery cache restores for a matching hash only and never changes `configHash`.
- HTTP: `selection: null` is 400; defaults, remove and revoke routes; a conflicting remove is 409.
- An unmanaged host stays session-only even with a store.
- Another host's revoke is read before admission: `blocked` with `settings_changed`, the grant and route are gone, no call.
- A default changed by another host during a sequence step: the next step is `blocked`, the first step keeps the original route, no step runs on the new one.
- Stored routes must be one per scope and name a stored grant; a grant whose mode differs from the manifest mode rejects the document; a default with the same profile for both roles is refused.
- `SurrealHostSettings` over a fake transport: NONE, committed, conflict, a committed revision other than expected + 1, and the stored field mapping. With a disposable SurrealDB, two concurrent writers commit once and a late writer gets a conflict.
- HTTP: `/run` and `/run-sequence` with `selection: null` are 400; a selection-less `/run` reports `source: 'default'`; a successful revoke is 200 and its body shows the committed revision with status `saved`.

Existing tests that construct `ConnectionWorkbench`/`createHostConnections` without a store pass unchanged. The actual-database CLI tests that restart with the same fixture manifest now expect the earlier grant to be restored (`tests/cli-host-admission`, `cli-host-drain`, `cli-expired-run`, `cli-run-sequence`, `cli-host-kill`); they need a disposable SurrealDB and are skipped without one. The actual-database `SurrealHostSettings` test is skipped without a disposable SurrealDB, and no selection-less CLI run is recorded yet; both still need a Linux run with `SURREAL_TEST_RUNTIME`. The stored field is named `settings`, not `value`, so the load query never relies on `value` parsing as a field name.

## Out of scope

- Workbench controls: grant status and Revoke, "Use as default", run-form prefill from the route. The HTTP API is complete; the panel still shows the session disclosure.
- Persistence for an unmanaged host (no stable identities, and no grant can be created there in the normal CLI). A later `version: 2` can add it.
- The ADR 0002 family map and different-family check.
- A stable connection identity that survives manifest edits, or migration of grants between scopes.
- Wildcard or cross-scope grants, or one default for every Mission scope.
- Settings in portable backup; any secret storage, keychain, OAuth or account enrollment; an owner token for the loopback host.
- Making `availability()` report ready when a default exists.
- Live or paid provider verification. All evidence for this increment is fixture-class.

## Review dispositions

Independent review of the proposed design, and what changed:

| Finding | Disposition |
| --- | --- |
| Unmanaged scope cannot create grants in the CLI; `allowFixture` does not separate modes | Accepted. Only `manifest:<bindingHash>` persists; no `connections` field, no `secretRef` stored. |
| Async mutations break the synchronous constructor enrollment | Accepted. Synchronous apply functions plus `save()`; enrollment and restore never write. |
| `run()` can slip in while a save is awaited | Accepted. `pending`/`unknown` refuse checks, runs and changes synchronously. |
| A default change mid-sequence stops it; `configuration()` lives in `SelectableTextRuntime` | Accepted. Documented as `blocked`; routes are merged in `ConnectionWorkbench.configuration()`. |
| `selection: null` was not 400 before | Accepted. New 400 behavior, absent vs present distinguished. |
| Concurrency tokens differ per method | Accepted. Table above. |
| Stored limit needs an internal path; restore order affects `version()` | Accepted. `#select(..., storedLimit)` with 1..4096 check; Map order stored and restored. |
| Enrollment selections versus first save | Accepted. Every profile is stored on owner change only; startup never writes. |
| Restore guard ignores settings (two findings) | Accepted. The guard now requires `massion_host_settings` to be empty. |
| `default_route_*` codes are not in `RuntimeResult` | Accepted. Run results are checked by status and reason. |
| Narrowing writes fail open on unknown outcome | Accepted. Covered by the fail-closed window; there is no separate pending-revoke state. |
| Live grants now come back with the start option | Accepted with a decision: documented meaning change, visible counts/scope/mode/source, no extra first-use confirmation. |
| Headless preflight/run may differ | Partly accepted. Documented; the existing explicit selection is the guarantee. A new expected-route field was not added. |
| Revoked identity can be reused | Accepted. Tombstones, bounded. |
| Require `Origin` for settings POSTs | Not adopted. A local process can forge `Origin`, so it adds no protection; the risk is documented and `updatedAt` is shown. |
| YAGNI on unmanaged storage | Accepted (same change as the first finding). |
| `writeId` generation and failed read-back | Accepted. `randomUUID()` per attempt; a failed read-back leaves `unknown` and fail-closed. |

Independent code review of the implementation, and what changed:

| Finding | Disposition |
| --- | --- |
| CLI admission test still expected the restored grant to be refused | Accepted. The test revokes the restored grant first, then expects `blocked` and an unchanged journal. Needs the Linux actual-database run. |
| No test drives `SurrealHostSettings`; `value` may parse as a keyword | Accepted. Fake-transport test, gated actual-database concurrency test, field renamed to `settings`. |
| Another host keeps a revoked grant in memory | Accepted. `run()` reads the stored revision before admission (above). |
| Settings responses report the pre-commit revision and `saving` | Accepted. The server sends `list()` after the save returns. |
| Duplicate routes per scope are not rejected on load; grant mode not checked | Accepted. |
| Unknown outcome read-back says "not applied" when ours was superseded | Accepted. A later stored revision gets its own message. |
| Missing sequence-guard, HTTP and selection-less pending tests | Accepted. |
| Unresolved default returns `blocked` while draining | Kept and commented: it admits nothing, and HTTP refuses mutations while draining. |
| Same profile or model for both roles in a default | Accepted for defaults (above). Explicit selections are unchanged. |
| Revoked identities can repeat across scopes | Not changed. Documented in invariant 9; pins carry the exact bindings. Checking every Mission journal on authorize is out of proportion here. |
| A changed secret behind the same environment name revives a live default | Not changed. Same decision as the earlier "live grants come back with the start option" row: the owner controls both the environment and the start option, and startup reads no credential. |
| Discovery cache write is not validated | Not changed. The write takes the list already bounded and exact-checked by discovery (≤ 1000, exact fields); it is a cache that never changes a profile hash, and the restore guard intentionally covers its rows. |
| Invalid stored settings stop startup | Not changed. Fail-closed start is the documented decision; serving with `unknown` would offer no repair path either, since every change first re-reads the same invalid row. |
| Revoke waits for active Work | Not changed in behavior; the misleading "always allowed" comment and table row were corrected. |
