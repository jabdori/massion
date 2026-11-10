# App lifecycle settings

Reuse the bundled GitHub package, owner app decisions and password panel. Do not
invent catalog packages, remote authentication results or inferred assignments.

`AppsService` accepts `members: () => Promise<{id, name, archived?}[]>`. This is
the admitted-member read boundary. `bind-members` stores explicit member IDs only
after loading app state, checking command replay, and validating against current
nonarchived members. Reads preserve stored IDs and project current active member
names; manifest contributions belong only to those explicit bindings.

Owner actions on `/assistant/apps` add `bind-members` (`appId`, `memberIds`) and
`reconnect` (`appId`). Reconnect opens an existing app decision; its action uses
`/assistant/apps/connect` with the unchanged `{commandId, decisionId, token}`.
The token goes directly to the app's declared secret slot. Only its slot, original
command identity and storage observation are retained. Saved means stored, never
verified authentication. Missing and unknown remain distinct from expired.

An installed app may reconnect its declared connection slot, or its single
unambiguous declared secret slot. The host records expiry only with
`expireCredential({commandId, appId, connectionId})`, tied to the exact connection
that supplied the credential; delayed expiry cannot overwrite a newer credential.
The command ID starts with `assistant-app`. Pending effects never authorize a new
connection attempt, including after restart. All writes use the supplied
ownerStore and admission guard, with post-load operation lookup and CAS replay.

Read additions: `availableMembers`, app `memberIds`, `members`, and `credential`
(`null` or `{slot, state: missing|saved|expired|unknown, at?, connectionId?}`).
No secret values or secret fingerprints enter these shapes or the journal.

Tests use in-memory storage, secret slots and mocked transports; no outside
network, model or payment calls. Local verification is focused tests, typecheck
and headless fixture interaction only.

## Integration

The server retains its existing app routes and owner decision dispatcher:

```ts
const apps = new AppsService(ownerStore, {
  network: options.appNetwork,
  secrets: options.appSecrets,
  mcp: options.mcp,
  members: async () => (await members.read()).members,
  admit: async () => { if (draining) throw new HostDrainError(); }
});

await apps.act({commandId, action: 'bind-members', appId, memberIds});
await apps.act({commandId, action: 'reconnect', appId});
await apps.connect({commandId, decisionId, token});
await apps.expireCredential({commandId: 'assistant-app-expiry-observation', appId, connectionId});
```

The member callback may supply `archived: true` or a numeric `archivedAt`;
`archivedAt: null` is active. Both archived forms are excluded. The expiry method
is host-only and needs an observed expiry tied to the original saved command.
No public owner expiry command or provider validity check is added.

UI controls call the shared settings admission helper:

```js
await settingsLifecyclePost('app:' + app.id, '/assistant/apps', {
  action: 'bind-members', appId: app.id, memberIds
});
const saved = await settingsLifecyclePost('app:' + app.id, '/assistant/apps', {
  action: 'reconnect', appId: app.id
});
if (saved) { chatOpenThread(''); await readChat(); }
```

`settingsLifecycleLocked('app:' + app.id)` fences pending/unknown commands.
Controls also check the selected app, feed and connection epoch. New connection
decisions project `connection.pending: true` after a durable claim, so a fresh
client cannot enter another token while the original outcome is unresolved.
New completion commands journal `observeStorage: true`; old completion commands
keep their original transition output during backup replay.

The main fixture loader calls `appLifecycleFixture` for B23, B23-github and
B23-github-expired at the root, after inheritance. The generator retains recorded
background Work, self-made apps and conversation decisions, and uses the bundled
executable GitHub source scoped by the existing fixture manifest/version labels.
Each offered version, approval, binding, secret-slot save and expiry passes
through AppsService; the resulting app journal is validated. Recommendations
remain limited to the actual bundled GitHub package. The six unsupported app
recommendations remain a documented gap.

Required copy keys: `ui.apps.members`, `ui.apps.bind-members`,
`ui.apps.credential-saved`, `ui.apps.credential-expired`,
`ui.apps.credential-missing`, `ui.apps.reconnect`. The main agent owns the copy
catalog and fixture-loader integration. Browser checks are batched by the main
agent; this worker runs only focused tests and typecheck.
