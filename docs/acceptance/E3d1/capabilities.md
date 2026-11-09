# Capability residuals

This ledger separates current host data from approved artboard-only behavior.
Passing a generic placeholder check does not prove a missing capability. Exact
remaining diagnostics and their dependent ordering failures are in
`remaining.md`; all 32 final pairs are linked from `README.md`.

| Screens | Missing producer and retained behavior | Code evidence |
| --- | --- | --- |
| B13 | Last-active time, historical per-member Work/schedule totals, member archive and unarchive are not exposed. Admitted identities, names, groups and recorded running status are rendered. No invented timestamps or totals. | `src/members.ts:13,89` returns only id/name/look/modelGroup; `src/server.ts:131-147` has no member archive command. |
| B13-devices | The current Mac's health is available. Pairing, remote devices, disconnect and reconnect are not. | `src/server.ts:128` returns local health only; the route table has no device-management path. |
| B13-general / restart | Representative name is read-only. Briefing frequency and notifications remain disabled with unknown values; installed app version and native restart have no producer/command. The existing schedules service schedules daily briefing executions, not the approved off/low/high preference. | `src/surface-shell.ts:6` owns the fixed name; `src/members.ts:56` checks name conflicts against it; `src/schedules.ts:56,106-109,124` exposes daily schedule time/run budgets, not these preferences; `src/server.ts:148` configures a route, not a name. |
| B14 / expired / restart / update | Default model labels are read-only and use exact recorded route pins. No identity-bound checking-model decision producer, CLI authentication check, raw-key save/change, credential expiry, provider-specific installed-update or restart action exists. Configured credential references are not proof of a live connection: show Not checked, or the explicit fixture state. | `src/connection-workbench.ts:134-136,148-156` exposes unverified connection metadata and host-owned credential references; `src/server.ts:131-150` exposes connection metadata/model discovery, not login, secret mutation or lifecycle commands. `src/members.ts` decision production concerns member admission, not checking-model changes. |
| B14-usage | Cycle utilization, reset time, per-member usage and currency budgets are unknown. No budget-change or meaningful utilization-refresh producer exists, so neither action is fabricated. Existing Work output-token caps and schedule run budgets are not currency or utilization percentages. | `src/server.ts:128-150` read/command routes; `src/schedules.ts:106-109` run counts; `src/connection-workbench.ts:148,151` output-token caps. |
| B19 / B19-juno | Owner-authored skills cannot truthfully be labelled built-in. There is no member-specific app installation binding, retained member-memory read/delete command, member-assigned recurring schedule producer or member archive. Existing skills/procedures, recent improvements, details, revert/restore, model-group navigation and conversations work. Missing app/memory rows also cause downstream ordering diagnostics when a broad placeholder consumes a later real date/title; those are dependent on the same missing capability. | `src/skills.ts:154-162` exposes author/version/steps without a built-in flag; `src/apps.ts:146-152` exposes manifests without catalog-app member bindings; `src/schedules.ts:106-109` assigns the briefing to the Representative; `src/members.ts:89` has no retained memory/archive read. |
| B23 | The real bundled catalog contains GitHub only. The installed-app read has no member binding. A valid self-made app and its accepted source Work can be shown, but the six other recommended packages and their Install actions cannot be invented. | `src/app-catalog.ts:13-16`; `src/apps.ts:146-152,204-207`; see `apps-causes.md`. |
| B23-github / expired | Declared secret slot labels are visible; secret values and stored/expired-token claims are absent. There is no token reconnect/save command. Manifest contribution arrays do not bind a skill/procedure/tool to a named member. | `src/apps.ts:146-152,204-207`; `docs/architecture/apps.md`, Not in this increment. |

Protocol incompatibility is distinct from a subscription or desktop app update.
`src/protocol.ts:21,32-37` supports protocol version 1 and negotiates update or
restart requirements; it supplies no installed application version or restart
command. Its restart branch requires a newer client's minimum version above
the running host's maximum, so the current version-1 client cannot reach that
branch with a valid older host range. The screen fixtures do not manufacture a
ready conversation with an incompatible protocol or relabel it as CLI expiry.

No checker, ordering, occurrence, budget or infrastructure-failure rule was weakened. Owner feedback A2 updates exactly two B23 heading strings to include the approved space before the count; no other contract expectation changes. Extra approved copy has artboard provenance; the original 241
imported copy entries and all 75 contracts remain intact.
