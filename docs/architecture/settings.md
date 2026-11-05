# Settings

- Status: implemented (first increment: the Settings layout with General, Memory, Members, Devices, Connections, Apps, Permissions and Advanced; the permission rules record).
- Date: 2026-11-06, above `feat/results-and-schedules`
- Decisions: [ADR 0002](decisions/0002-assistant-first-surface-and-independent-checks.md) §5 (two kinds of owner decision, no autonomy setting) and §6 with the change proposed by experience plan v3.1 §17 item 2, ADR 0002 §6 amendment pending (no "next time just do it" on a card; the two-column rule in Settings > Permissions), [ADR 0003](decisions/0003-members-internal-teams-model-groups-and-apps.md) §3 (model groups live in Settings > Connections) and invariant 4 (checking rules and permissions change only by owner decision). Screens: experience plan v3.1 §5.8, prototype artboards B12 (Memory), B13 (Members), B13-devices (Devices), B14 (Connections and Permissions), B23 (Apps).
- Builds on: [Surface skeleton](surface-skeleton.md) (the owner's menu opens Settings), [Family map and model groups](family-map-and-model-groups.md) (`modelGroups` in `GET /connections`), [Members](members.md) (members in the conversation read), [Growth proposals](growth-proposals.md) and memory retirement (the existing Mission routes), [Results and schedules](results-and-schedules.md) (the same reserved-prefix aggregate pattern).

## Problem

Settings was one long page of the earlier forms. Nothing showed what the Representative remembers, which models a group uses, or which effectful actions are asked; and there was no record for "allow without asking", so the only way to stop being asked was a card button the experience plan removed.

## Surface

- **Me > Settings** (or ⌘,) replaces the conversation and opens at General. The sidebar shows `Settings` and the sections `General`, `Memory`, `Members`, `Devices`, `Connections`, `Apps`, `Improvements`, `Permissions`, `Advanced`; the current one carries `aria-current`.
- Each section is a heading, group labels and rounded cards of rows: a title, a muted line and at most one control (B12, B13, B14). Settings apply at once; `Cancel` and `Add` appear only when making a new rule.
- **General**: the Representative's name and the morning briefing (its cycle or `Off`, and `Open` to Schedules).
- **Memory** (B12) reads the intake Mission (`GET /connections` names it, `GET /missions/:id` reads it):
  - `You said`: the latest explicit version of each memory, `content · version N · In use`, with a switch. Turning it off retires that version through `POST /missions/:id/memory-retirement` with the reason `Stopped in Settings`; a version no longer in effect reads `Not in use` with its switch disabled.
  - `Learned`: learned candidates with Growth evidence, `content · version N · Pending` or `In use`, and `Evidence` folding the recorded scores, held-out note and caution (the proposal's counterevidence). Nothing is adopted here.
  - `Change history`: adopted and reverted Growth, newest first. An adopted one that is still effective has `Revert`, which sends the existing owner `revert` through `POST /missions/:id/growth` with the exact baseline and candidate.
- **Members** (B13): the Representative (★) and each admitted member with its model group name. The Representative's row opens its conversation; a member's row opens the member page (B19-juno, [self-made skills](self-made-skills.md)) with `Message`. Archive is later.
- **Devices** (B13-devices): `This Mac` and the host state (`Ready` or `Offline`).
- **Connections** (B14): `Model groups` from `GET /connections`: each group's name, who uses it (the Representative uses Default; members their own), its description (the Default group's host string is not drawn), its models as `model Family` chips (the model family from the host map, `Unknown` when unmapped, so a model reached through OpenRouter counts with its family) and `N providers` counting distinct families. Then `Subscription logins` (CLI connections) and `API keys` (the others) as rows with their state. The earlier connection forms follow under `Connection setup`.
- **Apps** (B23): `No apps installed`. The app runtime is a later step.
- **Improvements** (B14): one card with skill and procedure candidates waiting for the owner, the ones that could not be checked, then past adoptions with their revert ([self-made skills](self-made-skills.md)).
- **Permissions** (B14): two columns.
  - `Always ask`: the five fixed kinds, `Spend money`, `Send as me`, `Delete`, `Hand to a new member`, `Change check rules`.
  - `Allow without asking`: owner rules, each `what` and `kind · date` with `Remove`; `None` when empty. `Add rule` opens a field and a kind of the first four, with `Cancel` and `Add`.
- **Advanced** holds what Settings held before: host health, the provider notice, Create a Mission, Continue a Mission and the development fixture.
- Labels stay in the surface's English. No explanation sentences, no yellow (no decision card here).

## Permission rules

One aggregate `assistant-conversation:permissions` (kind `permissions`) under the reserved prefix, like members and schedules.

```ts
interface PermissionsState {kind:'permissions'; id; rules: {id; what; kind:'spend'|'send'|'delete'|'delegate'; at}[]}
```

| Command | Actor | Rule |
|---|---|---|
| `allow-rule {ruleId, what, kind}` | Owner | `what` is one line of at most 120 characters; `kind` is one of the four first-kind decisions; no rule with the same kind and text (case folded without locale); at most 64 rules |
| `remove-rule {ruleId}` | Owner | An existing rule. Removing means the kind is asked again |

- **Only the owner writes.** The reducer refuses every actor without the owner role, so no host step, Representative, member, Growth candidate, skill or app has a path. Lineage replays each operation as the owner, refuses an `assistant-` command ID, and checks that the rule ID derives from the command ID (`rule-` + 16 hex of its hash), so a resent Add commits once.
- **The second kind is never allowed.** `Change check rules` and widening permissions (ADR 0002 §5 B) have no rule kind: an `allow-rule` with any other kind (or a kind that is not a string) is refused, so they cannot be allowed without asking.
- **Nothing reads the rules yet.** No Work pays, sends, deletes or hands work to an outside agent today. The policy gate that consults them comes with the first such Work.

### Routes

- `GET /assistant/permissions` → `{feedId, revision, ask: [{kind, label}], allow: [{id, what, kind, label, at}]}`.
- `POST /assistant/permissions {commandId, action:'allow', what, kind}` or `{commandId, action:'remove', ruleId}`; it goes through feed admission like the other conversation writes.

## Invariants

1. Only an owner command changes a permission rule; the host and every agent have no write path.
2. Rules for checking rules or for widening permissions cannot exist.
3. Memory changes from Settings use the existing owner commands: retirement of an explicit version and revert of an adoption. Settings adopts nothing.
4. There is no autonomy setting.

## Not in this increment

- General: renaming the Representative (the name is a host constant used by members and the shell), briefing frequency.
- Memory: member memory, kept memory candidates, re-enabling a stopped version, search.
- Members: archive and unarchive, the member page (B19), merging.
- Devices: pairing codes and remote devices.
- Connections: editing groups (B20), changing the checking model through a decision card, `Recheck` and `Add key` on rows; the earlier forms still carry explanation text.
- Apps: everything (Q11).
- Permissions: owner rules in `Always ask`, and the policy gate that reads `Allow without asking`.
- The Settings search field.
