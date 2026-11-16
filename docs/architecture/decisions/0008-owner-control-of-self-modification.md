# ADR 0008: Owner control of self-modification

> [!NOTE]
> **In short**
> - The owner chooses how changes that Massion makes to itself are adopted: **Review**, **Auto after a check**, or **Auto**.
> - The choice is one setting for the organization, with an optional override per kind of change.
> - Until the screen where the owner chooses exists, the default for every kind is exactly the behaviour of `main` on 2026-11-16; the first value for a new installation is decided together with that screen.
> - No mode adopts a change that failed the host scan, that a check found worse, or that only a same-family model judged. No mode replaces what the owner wrote or widens permissions without asking.
> - The record of every adoption and the ability to revert it cannot be turned off.
> - No mode carries an expiry.

- Status: proposed; awaiting the owner's approval
- Date: 2026-11-16
- Scope: who decides that a self-made change (a member's skill or procedure, a memory candidate, a self-made app, an organization change) takes effect. Builds on [ADR 0002](0002-assistant-first-surface-and-independent-checks.md) §5 and §7, [ADR 0003](0003-members-internal-teams-model-groups-and-apps.md) §5, §7 and §8, and [ADR 0007](0007-member-environments-sign-in-and-permission-levels.md). See [Changes to earlier ADRs](#changes-to-earlier-adrs).

## Context

Massion has two separate questions about asking the owner.

- **What a member may do without asking** while it works: the permission level of ADR 0007 (Always ask, Auto, Full access).
- **Whether a change to Massion itself takes effect without asking**: a new or edited skill, a memory candidate, a new member.

ADR 0002 §7 answered the second question with no setting: adoption after an independent check was automatic, and a target returned to review only by calibration. Self-made skills and procedures were built that way.

On 2026-11-16 the owner decided that 1.0 gives the owner this control, as the earlier Massion design did: three modes, audit and revert always on. The owner also decided that organization changes follow the same control. The first draft of this ADR made the automatic modes carry an expiry and set Review as the default; on the same day the owner removed the expiry (section 3) and decided that until the choosing screen exists the default is exactly today's behaviour, so this PR changes nothing for a user who never touches the setting.

The earlier design defined the middle mode by a combined score with a fixed threshold that it called an initial value chosen without data. This ADR does not carry that number over. The repository already has a stricter gate: a check supports adoption only when it comes from a host-owned deterministic evaluator or from a model of a different family (ADR 0003 §7).

## Decision

### 1. Three modes

| Mode | A candidate whose check supports adoption | A candidate with no way to be checked |
|---|---|---|
| **Review** | The owner is asked with a decision card | Stays unchecked, as today |
| **Auto after a check** | Adopted | Stays unchecked, as today |
| **Auto** | Adopted | Adopted, if the host scan passed |

**Today two of the three modes behave differently.** A self-made skill or procedure always has an evaluation, so no skill candidate is ever "without a way to be checked". For skills, Auto after a check and Auto adopt the same candidates. The third column matters once a kind of change exists whose candidates can lack a check.

"A check supports adoption" keeps its meaning from ADR 0003 §7: a host-owned deterministic evaluator or a different-family model judged the candidate better than the baseline on the same inputs.

### 2. What no mode changes

1. A candidate that fails the host scan, or that a check found worse than the baseline, is rejected.
2. A judgement from a same-family model alone never leads to adoption.
3. A candidate that replaces something the owner wrote is always a decision card.
4. A change that widens permissions or tool scope, or that touches evaluators, evaluation sets, the family map or scan rules, is never adopted automatically (ADR 0002 §5, second kind; invariant 5).
5. Every adoption is recorded with the mode and the setting revision it was made under, and can be reverted. Neither can be turned off.
6. Only the owner changes the mode. A member, an app, a schedule or an automatic adoption cannot.
7. Calibration stays. When too many recent automatic adoptions of one kind were reverted, that kind returns to Review until the owner resumes it.

### 3. Scope, the default and no expiry

- The setting has one organization default and an optional override per kind of change: skills and procedures, memory, self-made apps, organization changes.
- **Owner decision (2026-11-16): the owner chooses the mode; auto-adopt carries no expiry ("자동 방식에 만료를 둘 이유가 있나? 너무 과한거 아니야?").** Of the seven apps compared on 2026-11-16, none puts an expiry on an automatic adoption mode. Auto stays on until the owner changes it; Auto after a check is guarded by the check and the calibration.
- Each change of the setting is a recorded revision: who, when, which kind, which mode.
- Until the screen where the owner chooses exists, the default for every kind is exactly today's behaviour on `main`: skills and procedures are adopted automatically after a check that supports adoption (Auto after a check), and every other kind asks the owner (Review), because that is what `main` does today. The first value for a NEW installation is decided together with that screen.
- The Settings screen where the owner changes the mode is not in this PR; it needs a new screen contract. Until it exists the mode can be set only through the host route this PR adds: POST `/assistant/adoption` with `{commandId, action: "set-mode", target, mode}` and a caller command ID, the owner's local workbench HTTP route — the command requires the owner role, so no member, app, schedule or host step can issue it, and it is reachable only by the owner's own tools on the computer running the host. GET `/assistant/adoption` reads the revisions.

### 4. Kinds of change

Only skills and procedures are wired today. The other kinds are named in the setting and decided here so that later slices follow the same rules.

- **Skills and procedures.** Wired. Under Review a candidate that passed its check becomes the existing decision card.
- **Memory.** Automatic adoption of memory candidates, designed in ADR 0002 §7, will be implemented behind the same decision. Not built yet.
- **Self-made apps.** A new tool or a wider scope is item 4 of section 2, so installing one is always a decision card. The mode changes nothing here.
- **Organization changes.** Admitting and merging members will follow this setting. Not built yet: today the owner decides every admission. Automatic admission will additionally require a budget limit for what the admitted member may spend; without one the owner is asked. Archiving an unused member stays automatic with revert (ADR 0003 §8).

### 5. One decision function

One pure function takes the kind of change, the nature of the candidate, the check result, the effective mode and the calibration state, and returns adopt, ask or reject. Every kind of change that is wired goes through it. It is tested as a table.

## Invariants

1. Until the choosing screen exists, the default is today's behaviour on `main` (Auto after a check for skills and procedures; Review for every other kind). The first value for a new installation is decided together with that screen.
2. Section 2 holds in every mode.
3. A mode change is an owner command and a recorded revision.
4. No mode carries an expiry: a mode stays in force until the owner changes it.
5. An adoption without a record, or a record without a way to revert, does not exist.

## What is not decided

- The Settings > Improvements screen for the choice, and with it the first value for a NEW installation.
- The budget limit for automatic admission.
- Prompt and policy as kinds of change. No path produces such candidates in 1.0.

## Alternatives

- **No setting; automatic after a check** (ADR 0002 §7). Replaced. The owner decided that the owner controls self-modification; until the choosing screen exists the default keeps today's behaviour.
- **Two modes (Review, Auto).** Not chosen. It cannot express "automatic only when an independent check exists", which is the behaviour already built.
- **A score threshold for the middle mode.** Not chosen. The earlier value had no data behind it, and a check by an independent evaluator is a stricter and explainable gate.
- **An expiry on an automatic mode.** Not chosen. The owner decided on 2026-11-16 that the automatic modes carry no expiry; of the seven apps compared that day, none puts an expiry on an automatic adoption mode.

## Consequences

- An installation where nobody sets a mode keeps today's behaviour; this PR changes nothing for a user who never touches the setting.
- Settings > Improvements gains the mode choice (a screen change that needs approval).
- ADR 0002 §5 loses "admitting a new member" from its first kind.

## Changes to earlier ADRs

- **ADR 0002 §7.** "There is no owner-chosen adoption setting … Automatic adoption is the default. There is no owner-chosen review mode" is replaced by sections 1–3. Calibration stays.
- **ADR 0002 §5.** "Admitting a new member" is removed from the first kind (irreversible external effects): an admission can be undone. It is governed by section 4.
- **ADR 0003 §5.** The table's "Automatic after the check" rows apply under Auto after a check and Auto; under Review they are decision cards.
- **ADR 0003 §8.** "There is no autonomy setting and no automatic hiring" is replaced by section 4.
- **`docs/product/scope.md` invariant 8.** "Automatic adoption after an independent check is the default" becomes "The owner chooses how self-made changes are adopted; until the choosing screen exists the default is today's behaviour".
- **ADR 0007** is unchanged. It governs what a member does while working; this ADR governs what changes Massion itself.
