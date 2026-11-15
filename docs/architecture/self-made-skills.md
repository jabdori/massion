# Self-made skills and procedures

- Status: implemented (first increment: candidates from finished Work, host checks, automatic adoption, revert, archive, the owner-written decision card, the member page and Settings > Improvements; second increment: the owner's adoption setting — review by default — the one adoption decision, and calibration pause with owner resume).
- Date: 2026-11-06, above `feat/settings-pages`
- Decisions: [ADR 0003](decisions/0003-members-internal-teams-model-groups-and-apps.md) §5 (members make their own skills and procedures; the host adopts after an independent check) and §7 (a same-family check never supports automatic adoption); [ADR 0002](decisions/0002-assistant-first-surface-and-independent-checks.md) §4 (the producer never judges) and §5 (two kinds of owner decision). Screens: experience plan v3.1 §5.8 and §6, prototype artboards B19-juno (member page: skills, procedures, recent improvements, archived line) and B14 (Settings > Improvements).
- Builds on: [Members](members.md) (member identity and home folder name), [Family map and model groups](family-map-and-model-groups.md) (`familyCheck`, `supportsAutomaticAdoption`), [Settings](settings.md) (section layout, reserved-prefix owner aggregate), [Surface skeleton 2](conversation-cards.md) (decision card shape and `POST /assistant/decisions`).

## Problem

A member keeps skills and procedures in its home folder, but nothing writes them. Research (`self-made-tools`, SkillsBench v4) shows self-written skills without a check do worse than none; gains come only when a candidate is tested before it is kept. ADR 0003 §5 fixes the rule: members may make them, the host adopts only after a deterministic check and an independent evaluation.

## Skills aggregate

One aggregate `assistant-conversation:skills` (kind `skills`) under the reserved prefix, like members and permissions. It holds every member's skills and procedures, the candidates and the change log. Nothing is deleted.

```ts
interface SkillBody {description; steps: string[]; verify}   // verify: the stated way to check the result
interface Skill {id; memberId; kind: 'skill'|'procedure'; name; path: 'members/<memberId>/skills/<slug>' | '.../procedures/<slug>';
 versions: {version; hash; body; author: 'owner'|'member'; candidateId?; at}[]; current: number|null; archivedAt?; usedAt}
interface Candidate {id; at; memberId; skillId; kind; name; body; hash; base: number|null; trigger: 'correction'|'dead-end'|'repeat';
 source: {missionId; workId; recordId; title}; producer: ModelIdentity; state; reason?; evaluation?}
```

- **Home folder.** `path` names where the skill lives in the member's home (`members/<id>/skills/` or `procedures/`); like the home path itself it is a name, and the record is the store. Each version keeps the SHA-256 of its body (`hash`); a load recomputes it.
- **One path only.** A candidate names its member and a kind of `skill` or `procedure`; the path follows from those, so a candidate cannot name another member's folder, permission settings, evaluators, evaluation sets, the family map or scan rules. Any other kind is refused at validation (ADR 0003 §5 table, last two rows).
- Bounds: 64 skills per member, 16 versions per skill, 512 candidates in all (ponytail: prune rejected candidates older than a year if the bound is reached).

### Commands

| Command | Actor | Rule |
|---|---|---|
| `propose-skill` | Host step | From an accepted Work only (it has a Record), with a trigger of correction, dead end or repeat. The host runs the deterministic check at once: format (description, 1–12 steps, a `verify` line) and the static scan of the name and body (hard-coded secrets, remote loading, hidden instructions, check-bypass phrases). The producer's family must match the host family map. A failure keeps the candidate `rejected` with its reason. The same body for the same skill is never proposed twice. |
| `check-skill` | Host step | Only a `pending` candidate. Carries the evaluation and the adoption context the host resolved (the effective mode, its revision, the calibration state). Without execution evidence it is no evaluation. The outcome follows `adoptionDecision` under the owner's setting (below): a same-family check leaves it `unchecked` ("No way to check"), a worse candidate is `rejected`, and a supported candidate is adopted or asked according to the mode — under `review` (the default) it goes to `deciding` and the existing decision card. A candidate past the skill or version bound is `rejected` ("Skill bound reached") rather than left pending, also before an ask. The checker's family must match the host family map. |
| `decide-skill` | Owner | `act` adopts a `deciding` candidate, `later` defers, `ask` reopens. |
| `revert-skill` | Owner | The current version must be a member version; the skill goes back to the version in use before that adoption (the `from` of the adoption that made it current), or out of use when there was none. A version the owner reverted earlier is never brought back. |
| `restore-skill` | Owner | Undoes an archive. |
| `drop-candidate` | Owner | An `unchecked` candidate becomes `dropped`; it stays recorded. |
| `resume-adoption` | Owner | Lifts a calibration pause. The boundary is the change sequence at the moment of the resume, so an adoption in the same millisecond still counts. |
| `write-skill` | Owner | The owner writes a version for an admitted member. The format is checked and a hard-coded secret is refused, since the body is kept in the journal and backups; the other scan rules do not bind the owner. Later candidates for that skill need a decision card. |
| `use-skill` | Host step | A Work loads a skill: the body hash and the static scan are checked again; a failure refuses the load. Records the time of use. |
| `archive-unused` | Host step | Member-written skills unused for 30 days are archived, with Undo. Owner-written ones are left alone. |

- Adoption needs the candidate's `base` to still be the skill's current version; a candidate made against an older version is rejected as stale.
- Only `supportsAutomaticAdoption` (deterministic or different family) adopts, both automatically and through the owner's decision.

## What decides adoption

One pure function, `adoptionDecision` in `src/adoption.ts` (the shape of `gateDecision` in [Environment actions](environment-actions.md)), decides every self-made change: candidate → host scan → independent check → **decision** → adoption → record → revert. It takes the target, the candidate's nature (replaces something the owner wrote; widens permissions or tool scope), what the check said, the owner's mode and the calibration state.

| Mode | A candidate the check supports (a host evaluator or a different family found it better than the baseline) | A candidate with no way to be checked |
| --- | --- | --- |
| **review** (default) | The existing decision card asks | Stays `unchecked`, as today |
| **auto-threshold** | Adopted (today's behaviour) | Stays `unchecked` |
| **auto-adopt** | Adopted | Adopted when the host scan passed |

No mode changes these, in this order:

1. A failed host scan, or a check that finds the candidate not better than the baseline, rejects in every mode (a scan failure is already born `rejected` at the proposal).
2. A candidate that replaces something the owner wrote, or widens permissions or tool scope, asks in every mode, also over a same-family check. For skills an owner-written skill goes to the decision card, and a widening candidate has no write path at all.
3. A same-family-only judgement never adopts in any mode and stays `unchecked`, except that rule 2 asks first for an owner-written replacement and the owner's answer adopts (the owner decided). A same-family check that found the candidate worse rejects, as every check that finds the candidate worse does.
4. A paused target behaves as review. Audit records and revert stay on at every mode, and only the owner changes the mode.

The decision is made once, at the moment of writing, and the store enforces it: the check command carries the effective mode and the setting revision it was decided under, and its commit is conditional on the setting aggregate still being at the revision that was read and, when the mode in force is `auto-adopt` with an expiry, on the store's clock not having passed that expiry. If the setting moved, the expiry passed or the skill state moved (a revert during the evaluator) before the store recorded the write, the write is refused as a known conflict and the attempt reloads both aggregates and decides again under what then applies; a recomputed `ask` goes to the decision card. Values read before the evaluator ran are never used. The store's clock is the single clock for the deadline, and the decision's now is the maximum of the host clock, the setting aggregate's recorded high-water mark and the latest time recorded in the skill aggregate, so it cannot go back before the last recorded write (the limit is stated below).

### The setting

One reserved-prefix aggregate, `assistant-conversation:adoption` (kind `adoption`), like members, permissions and skills:

- An organization default plus an optional override per target kind; the latest override for the target wins, else the latest default. Only `skill` (skills and procedures) is wired; `memory`, `app` and `organization` are names for later slices.
- Each revision records who, when, which target (or the default) and the mode. `auto-adopt` requires an expiry timestamp (no "never"); `review` and `auto-threshold` take none.
- Only the owner sets the mode or resumes a paused target (`POST /assistant/adoption`, caller command IDs only): no member, app, schedule or host actor can issue the command. `GET /assistant/adoption` reads the revisions, resumes and recorded expiries.
- The default mode is `review`, defined once in `DEFAULT_ADOPTION_MODE` (`src/adoption.ts`) and read from nowhere else, so changing the default later is a one-line change.
- An installation or old journal without the aggregate loads and means the default. A `check-skill` command from before the setting exists replays through a replay-only legacy branch under the behaviour of that time (a same-family check left the candidate unchecked whatever its scores), so old journals and backups restore exactly.
- A `check-skill` command in that pre-setting shape is refused by journal-lineage validation when it is ordered after the setting's first revision, and the single-aggregate replay refuses it when it is ordered after a marked check, so no new command can pass itself off as an old one.
- When an `auto-adopt` revision expires, the effective mode is `review` and the fact is recorded once, as a host step with a derived command identity.
- Expiry is one-way: once recorded, a revision never grants `auto-adopt` again, whatever the clock says. Before it is recorded, time is evaluated against the later of the wall clock, the latest time recorded in this aggregate's journal and the latest time recorded in the skill aggregate (the limit is stated below).
- Every automatic adoption records the setting revision it was made under (`adoptionRevision` on the change record; `null` when the default applies with no revision). An owner-decided adoption records none.

**Limit of the expiry.** The expiry of `auto-adopt` is read from this computer's clock. Massion never lets its own notion of the time go back before the last write it recorded for the adoption setting or for a skill, and an expiry that has been recorded is final: no clock change brings that grant back. Between those points the clock is trusted. A user who has the right to change this computer's time can therefore extend a grant that has not yet expired: by at most the amount the clock was set back, counted from the last recorded write. This is accepted because the expiry is a safeguard the owner sets for themselves; the person who can change the clock is the person who chose the expiry. It is not a boundary against another party.

Restoring a backup is an explicit act of the owner (the local CLI `scripts/backup.ts restore` is the only path; no product route or host step starts one), and this design does not authenticate backups: a forged bundle whose commands, state and checksums all match replays as valid.

### Calibration

The host counts the automatic adoptions after the last resume, at most the 10 most recent, in change order (a sequence, not wall-clock time); an adoption failed if it was reverted. Automatic adoption pauses when 2 or more failed, or 1 failed while fewer than 5 are counted. While paused every mode behaves as review, so the window cannot change until the owner resumes; `resume` is an owner command on the skills aggregate. Records from before the setting existed count too: an adoption with no owner answer was automatic. This is the revert-rate calibration the Growth design describes, implemented here for skills in its smallest form.

### What changes for an existing installation

Until the owner chooses a mode, a candidate that today would be adopted automatically goes to the existing decision card instead. Nothing else in the check changes, and no new card or wording appears.

### Producer and evaluator

`SkillsService` takes two host functions: the producer (the member's model, a fixture in tests) drafts a body from a pointer to the finished Work and its Record; the evaluator runs baseline and candidate on the same cases and returns the scores, the evidence and the checker model it ran. The host, not the producer, calls the evaluator and builds the check itself with `familyCheck`, so an evaluator never states a family. A result without a checker model counts as the deterministic check only when the service was built with `hostEvaluator: true` (the evaluator is a host program); otherwise it is refused. The producer never judges its own candidate. Neither has an HTTP route: today only tests and the host call them.

## Decision card

A candidate in `deciding` adds a card to the member's 1:1 conversation read (`decisions`, the shape of conversation-cards.md):

```
{id: 'skill-decision:<candidateId>', at, title: name, question: 'Replace your <name>?', rows: [['Now', 'v<n> · You'], ['Change', first changed step], ['Check', '<baseline> → <candidate> of <cases> · <checked by>']], action: 'Use v<n+1>', state, line?: 'Changed: v<n+1>'}
```

`POST /assistant/decisions` sends a `skill-decision:` ID to the skills service; other IDs stay with members.

## Routes

- `GET /assistant/skills` → `{feedId, revision, skills, improvements, candidates}`: each skill with its current version, steps, author and state (`active`, `archived`, `off`); each change (adopted, reverted, archived, restored) with its source Work, result and who checked, and for an adoption whether it was later reverted (`reverted: {to, at}` or null); each candidate that is waiting, unchecked, rejected or dropped with its reason and result.
- `POST /assistant/skills {commandId, action}` with `revert` or `restore` (`skillId`), `drop` (`candidateId`), `write` (`memberId, kind, name, body`) or `resume` (no fields; lifts a calibration pause). Caller command IDs only; `assistant-` IDs are the host's.

## Surface

- **Member page** (B19-juno): Settings > Members opens a member's page: back to `Members`, avatar, name, `Message`; `Skills` (name, `v2 · Nov 5` or `You`), `Procedures` (steps as chips), `Model group`, `Recent improvements` (`name v1 → v2`, date and source Work, `Details` with Source, Result and Checked by, `Revert`, or `Reverted to v1` once reverted), and the line `Archived N unused skills` with `Undo`.
- **Settings > Improvements** (B14): one card without section titles, like the prototype: open decisions first (`Skill · 1 → 3 of 3 · date · Decision pending`; the card itself is in the member conversation), then what could not be checked (`No way to check · date` with `Drop`), then one row per past adoption, newest first (`Applied Nov 4 · Reverted the same day · v1 → v2`). Archives stay on the member page.
- Labels stay in the surface's English. No explanation sentences; yellow only on the decision card.

## Invariants

1. The producer of a candidate never checks it; the check comes from the host evaluator or a different family.
2. A same-family check never adopts a skill or procedure automatically; an owner-written replacement it covers asks, and the owner's answer adopts because the owner decided.
3. A candidate writes only its own member's `skills/` or `procedures/`; no candidate changes evaluators, evaluation sets, the family map, scan rules or permissions.
4. A candidate for a skill the owner ever wrote waits for the owner's decision.
5. Nothing is deleted: rejected, dropped, reverted and archived entries stay with their reason.
6. Only the owner changes the adoption mode; no mode adopts a candidate the scan rejected, the check found worse, or only a same-family judgement supports.

## Not in this increment

- The trigger that proposes from Growth reflection trails (Q3) and the owner correction inside a running Work; today the host step is called directly.
- A production evaluator: candidates wait as `pending` until the host has one. Rotating held-out sets.
- Scripts inside skills and self-made tools packaged as apps (Q11).
- Loading skills into a member's Work (member Work does not exist yet), the load cap and search by description.
- Merging two skills; wiring the `memory`, `app` and `organization` target kinds (the decision function names them; nothing proposes candidates for them yet).
- An editor for owner-written skills on the member page (the route exists).
- `Reapply` after a revert and `Archive again` after an Undo on the member page (B19-juno); today the row shows `Reverted to v1` and Undo restores.
- Memory Growth rows in Settings > Improvements (B14 shows them beside skills); only skill candidates are listed today.
- Re-proposing the same body after a stale, unchecked or dropped candidate: the duplicate check is skill and body hash, so it replays the old proposal.
- Distinct home paths for names that slug alike (`PR description` and `PR-description`, or two Korean names ending in `v2`); the path is a name today, so nothing is overwritten.
