# ADR 0003: Members, internal teams, model groups and apps

- Status: accepted working design; not implemented; reversible on measured evidence
- Date: 2026-11-05
- Scope: what the organization is on the surface and inside, how models are chosen, what an app (extension) is, how members make their own skills and tools, when a request becomes Work, and the checking rule when only one model family is available. Builds on [ADR 0001](0001-product-owned-core.md) and [ADR 0002](0002-assistant-first-surface-and-independent-checks.md). Supersedes ADR 0002 in part (see [Changes to ADR 0002](#changes-to-adr-0002)).

## Context

ADR 0002 put one assistant, the Representative, at the entry and hid the organization. It left three questions open: what a member is, how the organization grows, and how Core Office returns. It also required a different model family for every model check (invariant 4).

On 2026-11-05 the owner agreed a direction and checked it in the prototype ([Design canvas](https://claude.ai/artifact/XYTuX4ZXwqyKvpcRVuDBRF), version 35, 51 artboards; owner-private). Screens are listed in the [experience plan](../../product/experience-plan.ko.md). The direction draws on four reviews of the same day:

- The earlier organization designs: the four-level OrgNode tree of pi (the previous prototype) and the archive's Core Office with temporary teams. A tree adds hand-offs but no assurance for one owner. Eight named bots add eight things to understand. The old B11 canvas drew the verifier Iris as a researcher, mixing checking with producing.
- Agent products (Grok Bot, Muse, dots, Paperclip). The unit people manage is a named bot. Sub-workers appear as unnamed chips. Bots that multiply become hard to manage.
- Self-made skills and tools. Self-written skills without a check score below no skills at all (SkillsBench v4: −8.1 to −11.5 points). Gains come only where a candidate is tested before it is kept (EvoSkill, CRAFT, ToolMaker).
- pstack and Matt Pocock's skills. Both end at the same rule: ask a person only for decisions, batch the questions, and ask late. Workers start with a fresh context and receive pointers, not copies. A change to a skill needs an observed failure.

## Decision

### 1. The surface shows named members only

- The organization starts as one Representative and zero members. The owner names the Representative (drawn as 하나).
- A member exists only when the owner admits it and gives it a name and a look. There are no titles: no "department", "lead" or "team" on the surface.
- Core Office responsibilities are host functions, not people: checking, Records, the policy gate, Growth, schedules, staffing, default model groups and default skills and procedures. The surface shows only their results: decision cards, exception cards, Records and check lines.
- The names Atlas, Lyra, Quill, Onyx, Vega, Iris, Cedar and Sage are dropped. Today's executor and verifier are the producing seat and the checking seat of a Work. Example member names in the prototype are owner-chosen.
- The sidebar lists the Representative, then members. While a member works, its Work lines appear under it.
- Each member has exactly one 1:1 conversation. There is no "new chat". A message about a running Work is recorded as that Work's steering. A general remark becomes a memory candidate that the owner keeps or drops.
- `@name` in the Representative's conversation still reaches a member and gets a direct answer.

### 2. Inside, a member runs a team per Work

| Layer | Holds | Lifetime |
|---|---|---|
| Member | Identity, memory, skills, standard procedures, schedules, model group, apps | Until the owner archives it. Its home folder is kept |
| Team lead | One Work: expands the member's standard procedure into this Work's plan | One Work |
| Team members (workers) | One step each; unnamed role chips on the surface | One Work |

- Context lives in the Work. Identity and memory live in the member. The relationship lives in the 1:1 conversation.
- Concurrent requests get separate teams, one per Work. Two Work rooms of the same member never share context.
- The team lead turns a procedure into a plan: steps, skipped steps with a reason, and steps that block others. Steps with nothing blocking them run in parallel.
- Workers start with a fresh context and receive pointers to the Work, its inputs and earlier Records, not copies.
- Workers and team leads do not write memory. They leave Growth candidates only. This keeps a resident identity from appearing without admission.
- With zero members, the Representative and workers run Work the same way.
- A team never replaces a host function. It cannot check, record or pass the policy gate on its own behalf.
- On the surface the Work room is the collaboration room: participants (member, role chips, and "check" last), the progress table, messages between participants, the check line, and stop.

### 3. Model groups

- A model group is a named set of models with a one-line description of its role, for example "Finds and reads sources and summarizes them with evidence".
- An agent picks a group by its description. The host picks the actual model inside the group by rules: availability, budget and family.
- The default group holds what the default route holds today: the Representative's producing and checking models.
- Admitting a member may create a group with a host default description. The owner may edit it.
- Each model shows its family. The family map stays host-owned, as in [Who checks a change](../growth-reflection-and-model-proposals.md#who-checks-a-change).
- Editing a group's name, description or producing models is an owner setting and applies at once. Changing the family map or the models that check is the second kind of change in ADR 0002 §5.

### 4. Apps are programs on Massion

An extension is an app installed on Massion, as on an operating system. It continues pi's `ext` and the archive's `massion.extension.v1`.

- An app runs in a sandboxed worker and gets only the permissions it declares: tools, network, files, secret slots and events.
- An app may contribute a rail icon and its own page, a Work room tab and a conversation card. It may also bring member templates, skills, procedures, tools and event triggers.
- Installing an app, and any update that widens its permissions, is an owner decision through a decision card. Narrowing or disabling is not.
- Each version is pinned by content hash and can be rolled back. A changed hash is checked again before use.
- The surface word is "app".

### 5. Members make their own skills, procedures and tools

Members and workers may make them. The host adopts them only after an independent check. This extends ADR 0002 §4 and §15 to skills and tools.

- **When.** From the reflection trail of finished Work, or from an owner correction during a Work. The correction is also recorded as that Work's steering (section 1). Only for an observed correction, a dead end that was worked around, or repeated work. No skill is written before a task. A candidate applies only after the check.
- **Check.** Deterministic checks first: format, a stated way to verify the result, and a static scan for hard-coded secrets, remote loading and hidden instructions. Then the host runs the baseline and the candidate on the same input in isolation and compares the Records, with a held-out part of the set. The judge is a host evaluator or a different-family model (section 7).
- **Adoption.**

| Change | Handling |
|---|---|
| New or edited instruction skill or procedure, or one that narrows a rule | Automatic after the check. Listed under the member's recent improvements with revert |
| Script inside the member's existing tool scope | Automatic after sandbox tests and the check |
| Unused skill | Archived automatically with revert. Never deleted |
| Candidate that replaces an owner-written skill | Decision card, like explicit memory |
| New tool, or one that widens tools, network, files, secret slots or events | Packaged as a self-made app. Install decision card, as in section 4 |
| Change to evaluators, evaluation sets, the family map or scan rules | Not a candidate. Rejected at validation |
| Writing to permission settings or another member's home folder | No write path |

- A rejected candidate is kept with its reason, so the same proposal is not made again.
- The skill is checked again when a later Work loads it.

### 6. Answer directly or hand off as Work

| Answer directly (ends in the conversation) | Hand off as Work (card and Work room) |
|---|---|
| Questions, explanations, short calculations, summaries, translations, one draft | Has several steps, or runs long enough that the owner would leave the conversation |
| The answer itself is the result | Leaves a file, document or code |
| No effect outside | Uses an outside tool, site or app; sends, pays or has another effect |
| | A member or team takes it; a schedule repeats it |
| | The owner asks for a proper check |

- A direct answer is a conversation reply, not an accepted result. It gets no independent check, no card and no Work room.
- When the owner says "check this", the request becomes Work.
- A single-step Work that one agent finishes shows only a collapsed "Worked for N min ›" line and the result. A Work card and a Work room appear only when the Work has several steps or several participants. The Work still follows every Work rule.
- This answers open question 5 of the experience plan v3. Who checks the Representative's choice stays open.

### 7. Checks when only one family is available

- A different-family checker is still preferred. The host picks it from the model groups when one exists.
- When no different family is available, the host checks with the same model anyway, in a separate run with its own identity and a fresh context. The producer never judges its own result.
- The host records the family relation of every check: deterministic, different family or same family, with both model identities.
- A same-family check can accept a Work result. It never counts as a different-family evaluation. It never supports automatic Growth adoption or automatic adoption of a self-made skill or tool; those need a host evaluator or a different family.
- A check without execution evidence is still no evaluation.
- How the owner is told that checks run on one family is a separate design. This ADR does not decide it.

### 8. Admission, autonomy and order

- Admitting a member is the first kind of decision in ADR 0002 §5. The Representative may propose it with a decision card when the same kind of work repeats (for example "Data analysis came up 4 times this month. Add a member for it?"). The owner then sets only a name and a look.
- Only one admission proposal is open at a time. A declined proposal is not repeated for a while.
- There is no autonomy setting and no automatic hiring. The archive's "auto-apply in unsafe mode" staffing is dropped.
- Archiving a member that has not been used is automatic with revert, except a member with schedules, open Work or unknown outcomes. Merging two members is a proposal card. Renaming and removing are owner actions.
- The ADR 0002 §10 restore order (Representative, Records, policy gate, Growth, extensions) still holds. Records already exist as accepted evidence. The policy gate arrives with decision cards in step 6, before members in step 7, because members need it for pause, stop, hand-over and admission. The implementation order is in [Consequences](#consequences-and-implementation-order).

## Changes to ADR 0002

- **§1 Rail and sidebar.** The rail opens the Representative's conversation, the results shelf, schedules and installed apps. Settings moves to the owner's menu. The sidebar lists the Representative, members and their Work lines; pinned and recent Work are dropped.
- **§2 Work card.** A single-step Work shows only a collapsed work line and the result (section 6). A card appears when the Work has several steps or participants.
- **§3 Members can be addressed directly.** Members are listed in the sidebar, not only in Settings and `@` completion. Each member has its own 1:1 conversation. `@name` in the Representative's thread remains. "Organization lead" becomes "member".
- **§4 Who checks.** A host evaluator or a different-family model is preferred. When no different family is available, the same model checks in a separate run, and the family relation is recorded (section 7).
- **§10 Core Office.** Core Office returns as host functions, not as eight named members. "The Vega and Iris positions" become the producing seat and the checking seat.
- **Invariant 4** is replaced by: "A check is recorded with its family relation (deterministic, different family or same family). A check without execution evidence records no evaluation. A same-family check is allowed only when no different family is available; it may accept a Work result but never supports automatic adoption of Growth candidates or self-made skills and tools."

Everything else in ADR 0002 stands: one entry, no self-judgment, two kinds of owner decision, no autonomy setting, quiet normal state and exceptions only.

## What we dropped and kept from earlier designs

| Earlier design | Now | Why |
|---|---|---|
| Representative → department lead → team lead → specialist tree, free `kind` values | Dropped as a visible tree; kept as member → team lead → workers inside | Layers add hand-offs, not assurance. Unbounded kinds make permissions and checking rights incomputable |
| Eight Core Office names | Dropped | See Context |
| Eight Core Office responsibilities | Kept as host functions | They are what makes results trustworthy |
| Staffing proposals auto-applied in unsafe mode | Dropped | An autonomy setting, and members grow without asking |
| A new node routes requests at once | Dropped | The organization changes without a version. Work pins its organization version (ORG-01) |
| Default four-department pack, organization map GUI | Dropped | More for a new owner to see |
| All input goes to one Representative | Kept | ADR 0002 §1 |
| "Node lifetime ≠ model process lifetime" | Kept | Separates members (persistent) from teams (per Work) |
| "Temporary teams do not replace core responsibilities" | Kept | Teams cannot check, record or pass the policy gate |
| Runtime dynamic creation | Changed | A team per Work; anything persistent goes through admission |
| Merge and deactivation proposals | Changed | Merge is a proposal card; archive is automatic with revert, through Growth |
| `@agent` | Kept | `@name` |

## Invariants at the boundaries

1. ADR 0001 is unchanged. The headless core owns members, teams, Work, Records, memory and Growth.
2. A member is created only by an owner admission. A team or worker never becomes persistent by itself.
3. Producing and checking stay separate identities. The producer never judges its own result.
4. Checking rules, the family map, evaluators and permissions change only by owner decision at the moment of change. No skill, tool, app or Growth candidate changes them.
5. An app gets only its declared permissions. Widening them is an owner decision.
6. A direct answer is never an accepted result.

## Alternatives and replacement criteria

- **Restore Core Office as eight named members.** Rejected (see Context). Revisit if owners repeatedly ask for a fixed role that no member or host function covers.
- **A visible organization tree with titles.** Rejected. Revisit if measured steps for delegate → follow → decide do not grow with members and owners ask to see structure.
- **One shared thread with `@name` only, no 1:1 conversations.** Rejected by the owner. A 1:1 conversation keeps a relationship and a member's memory candidates in one place. Revisit if the sidebar starts to work as a conversation list again (steps or unread counts grow with members).
- **One fixed model per member.** Rejected. It breaks when a model is unavailable or over budget and it hides the family choice. Revisit if group descriptions do not route well in measurement.
- **Different family only, as in ADR 0002 invariant 4.** Replaced. An owner with one family would see "not checked" on almost every result. Revisit if same-family checks show a higher revert rate than different-family checks for the same targets; then same-family acceptance falls back to an exception card for those targets.
- **Agents keep their own skills without a check (Hermes `skill_manage`).** Rejected on the SkillsBench evidence. Revisit if a later study shows unchecked self-written skills help on held-out tasks.
- **A separate tool store for self-made tools.** Rejected. One app path gives permissions, versions, rollback and contributions once.

## Consequences and implementation order

Implementation order, continuing [scope](../../product/scope.md#next-implementation-order):

3. Growth stage 1 reflection trail (read-only).
4. Family map and family check, with same-family checks allowed and recorded (section 7), and model groups chosen by description (section 3).
5. Surface skeleton 1: rail, sidebar with the Representative and member slots, activity list and work pane.
6. Surface skeleton 2 and the policy gate: Work cards in the conversation, the collapsed work line, the policy gate with decision cards, and exception cards.
7. Members (need the policy gate from step 6): named members, 1:1 conversations and Work rooms.

After that: assignment and claims, organization Growth, apps, self-made skills and tools, and external members.

Consequences:

- The organization version (ORG-01) must widen from two roles to the Representative, members and team templates. Work keeps pinning the version it started with.
- The domain needs the family map and a check record that carries the family relation. Today `assistant_verifier_same_model` compares provider and model only.
- Model groups need a host routing rule and a record of which model ran, so the family relation is exact.
- Apps need a real sandbox and permission enforcement before the first outside app (EXT-01).
- Open before members: the boundary between owner memory and member memory, the budget owner when a member's schedule wakes it, the member-to-member message cap and the automatic retry bound.

Revisit this ADR when the step-count measurement fails as members grow, when same-family checks raise revert rates, or when app permissions cannot be enforced. Record the evidence and the replacement.
