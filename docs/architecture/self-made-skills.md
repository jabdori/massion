# Self-made skills and procedures

- Status: implemented (first increment: candidates from finished Work, host checks, automatic adoption, revert, archive, the owner-written decision card, the member page and Settings > Improvements).
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
| `check-skill` | Host step | Only a `pending` candidate. Carries the evaluation: the family check, baseline and candidate scores on the same cases, the held-out pair and the execution evidence. Without evidence it is no evaluation. A same-family check leaves it `unchecked` ("No way to check"). A host evaluator or a different family, with the candidate above the baseline and not below it on the held-out part, adopts it; otherwise `rejected`. A candidate past the skill or version bound is `rejected` ("Skill bound reached") rather than left pending. If the owner ever wrote a version of the skill, the candidate waits for the owner instead (`deciding`), also after the owner approved a member version. The checker's family must match the host family map. |
| `decide-skill` | Owner | `act` adopts a `deciding` candidate, `later` defers, `ask` reopens. |
| `revert-skill` | Owner | The current version must be a member version; the skill goes back to the version in use before that adoption (the `from` of the adoption that made it current), or out of use when there was none. A version the owner reverted earlier is never brought back. |
| `restore-skill` | Owner | Undoes an archive. |
| `drop-candidate` | Owner | An `unchecked` candidate becomes `dropped`; it stays recorded. |
| `write-skill` | Owner | The owner writes a version for an admitted member. The format is checked and a hard-coded secret is refused, since the body is kept in the journal and backups; the other scan rules do not bind the owner. Later candidates for that skill need a decision card. |
| `use-skill` | Host step | A Work loads a skill: the body hash and the static scan are checked again; a failure refuses the load. Records the time of use. |
| `archive-unused` | Host step | Member-written skills unused for 30 days are archived, with Undo. Owner-written ones are left alone. |

- Adoption needs the candidate's `base` to still be the skill's current version; a candidate made against an older version is rejected as stale.
- Only `supportsAutomaticAdoption` (deterministic or different family) adopts, both automatically and through the owner's decision.

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
- `POST /assistant/skills {commandId, action}` with `revert` or `restore` (`skillId`), `drop` (`candidateId`) or `write` (`memberId, kind, name, body`). Caller command IDs only; `assistant-` IDs are the host's.

## Surface

- **Member page** (B19-juno): Settings > Members opens a member's page: back to `Members`, avatar, name, `Message`; `Skills` (name, `v2 · Nov 5` or `You`), `Procedures` (steps as chips), `Model group`, `Recent improvements` (`name v1 → v2`, date and source Work, `Details` with Source, Result and Checked by, `Revert`, or `Reverted to v1` once reverted), and the line `Archived N unused skills` with `Undo`.
- **Settings > Improvements** (B14): one card without section titles, like the prototype: open decisions first (`Skill · 1 → 3 of 3 · date · Decision pending`; the card itself is in the member conversation), then what could not be checked (`No way to check · date` with `Drop`), then one row per past adoption, newest first (`Applied Nov 4 · Reverted the same day · v1 → v2`). Archives stay on the member page.
- Labels stay in the surface's English. No explanation sentences; yellow only on the decision card.

## Invariants

1. The producer of a candidate never checks it; the check comes from the host evaluator or a different family.
2. A same-family check never adopts a skill or procedure, automatically or by decision.
3. A candidate writes only its own member's `skills/` or `procedures/`; no candidate changes evaluators, evaluation sets, the family map, scan rules or permissions.
4. A candidate for a skill the owner ever wrote waits for the owner's decision.
5. Nothing is deleted: rejected, dropped, reverted and archived entries stay with their reason.

## Not in this increment

- The trigger that proposes from Growth reflection trails (Q3) and the owner correction inside a running Work; today the host step is called directly.
- A production evaluator: candidates wait as `pending` until the host has one. Rotating held-out sets.
- Scripts inside skills and self-made tools packaged as apps (Q11).
- Loading skills into a member's Work (member Work does not exist yet), the load cap and search by description.
- Revert ratio calibration; merging two skills.
- An editor for owner-written skills on the member page (the route exists).
- `Reapply` after a revert and `Archive again` after an Undo on the member page (B19-juno); today the row shows `Reverted to v1` and Undo restores.
- Memory Growth rows in Settings > Improvements (B14 shows them beside skills); only skill candidates are listed today.
- Re-proposing the same body after a stale, unchecked or dropped candidate: the duplicate check is skill and body hash, so it replays the old proposal.
- Distinct home paths for names that slug alike (`PR description` and `PR-description`, or two Korean names ending in `v2`); the path is a name today, so nothing is overwritten.
