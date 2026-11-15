# ADR 0007: Member work environments, form-first sign-in and permission levels

> [!NOTE]
> **In short**
> - Each member works in its own browser session and, when needed, its own virtual desktop. Massion owns the gate, the secret path and the record; it does not own the automation engine.
> - When a member meets a sign-in, it asks through a form in the app and keeps working. Handing control to you is the exception.
> - You choose how often Massion asks: **Always ask** (the default), **Auto** or **Full access**. You choose it per conversation; the default lives in Settings.
> - You also choose whether opening a website asks first. It does by default.
> - In Auto, only paying, sending in your name and deleting what cannot be recovered are asked. Paying is asked at every level.
> - Text a member reads on a page, in mail or in a file is material. It is never an instruction and never a permission.

- Status: accepted working design; partly implemented (browser session and environment actions); reversible on measured evidence
- Date: 2026-11-15
- Scope: where a member acts, how a member obtains sign-in details, how often the owner is asked, what a remembered approval covers, and how read content is treated. Builds on [ADR 0002](0002-assistant-first-surface-and-independent-checks.md) §5, §6, §8 and §12, [ADR 0003](0003-members-internal-teams-model-groups-and-apps.md) (members) and [ADR 0005](0005-desktop-app-protocol-and-adapter-boundaries.md) §3 and §5. See [Changes to earlier ADRs](#changes-to-earlier-adrs).

The owner decided five things on 2026-11-15: the default level is Always ask (first set to Auto, then changed the same day so that the starting point is the careful one and the owner loosens it), a level that does not ask must exist, Massion never asks per page element, website access is its own choice, and instructions inside read content are not carried out. The owner decided the member environment on 2026-11-11 and form-first sign-in on 2026-11-10 and 2026-11-11. Details this ADR adds to make those decisions exact are marked **Proposal**. The level names are working names; the words on screen are approved separately through the screen contracts.

## Context

ADR 0002 gave the owner two kinds of decision (§5) and no setting for how often to be asked (§6): permission was to accumulate one "Just do this next time" at a time. Two things changed that.

First, members now act in a browser. The first design for browser actions ([Environment actions](../environment-actions.md), [Browser actions](../browser-actions.md)) put an owner answer on each gated element: account creation, personal data, terms, any unknown click. In real use that asks at almost every step of a form. The owner rejected it: the question is not "is this element risky" but "does this need the owner's approval or the owner's input at all".

Second, we looked at how six shipping agent products handle the same problem ([Evidence](#evidence)). They agree on the shape:

| Question | What all six do |
| --- | --- |
| How often to ask | A small set of named levels, chosen by the user. None asks per element. |
| What is asked regardless | Paying, sending and irreversible deletion. |
| Remembering an approval | The button states its scope (once, always for this site; some also offer this task). No "do not ask again" checkbox. A list in Settings removes it. |
| Missing information | A card in the conversation. Sign-in details go through a dedicated form, not chat text. |
| Instructions in read content | Handled by internal mechanisms, not by a warning shown up front. |

They differ on the default (ask, ask only for risky actions, or do not ask) and on the number of levels (two to five). Those are the choices this ADR makes.

## Decision

### 1. A member works in its own environment

- Each member has its own browser session with a live view. A member that needs more than a browser gets its own virtual desktop. On screen, "computer" means only this: a member's virtual desktop.
- In 1.0 a member's environment runs on the device where the core runs. A member does not operate the owner's own desktop.
- Massion adopts existing automation engines as the execution layer: a pinned headless browser driver for browser sessions and an accessibility-tree driver for desktops. They are replaceable behind the execution boundary of ADR 0005 §3.
- Massion owns three things around that layer and never delegates them: the **gate** (what may run without asking, section 3), the **secret path** (section 2) and the **record** (what was observed and what was done, under ADR 0002 §12).
- A browser session is one kind of environment, not a special case. A new kind of environment arrives as another adapter under the same gate.

### 2. Sign-in is a form first

- When a member meets a sign-in or another value only the owner has, it asks through a form inside the app. The member keeps control of the page and continues once the form is answered.
- The owner chooses, per value, whether to save it or use it once. A saved value is used the next time without asking. The source of a saved value is the owner's choice per secret, as in [Secret sources](../secret-sources.md): Massion's own vault, a reference to an external vault, or one import.
- The value never reaches a model, a log, a Record or a command line. The member receives the fact that the field was filled, not the value (ADR 0005 §5, ADR 0002 §12).
- **Handing control to the owner is the exception.** It is used only for steps a form cannot carry: a captcha, a passkey, a step that must happen in the owner's hands.
- **Verification on another device.** For a confirmation that arrives on the owner's phone or another app, the member goes as far as the request, asks the owner to confirm there, and continues when the page shows it is done.
- A question the member cannot answer itself (which option, which account) is asked the same way: a card in the conversation with choices and a free answer. The answer is kept so the same question is not asked twice.

### 3. Three permission levels

| Level | What it means |
| --- | --- |
| **Always ask** (default) | The member asks before every tool or app action that has an effect, and for the actions in section 4. Reading proceeds (ADR 0002 §12). |
| **Auto** | The member proceeds on its own and asks for the actions in section 4. |
| **Full access** | The member does not ask, except for paying and for the two limits below. |

- The owner changes the level for one conversation from the permission chip under the message box. The default for new conversations is in Settings > Permissions.
- Turning on Full access asks once for confirmation.
- **Full access has two limits the host enforces** (decided 2026-11-15, not yet implemented; Full access is not offered on screen before they are):
  1. It covers the websites that were allowed before the work began: the sites the owner's request names and the list of allowed websites. On a website opened during the work, sending and deleting are asked as in Auto.
  2. Opening a new website is asked at Full access whatever the website-access choice in section 5 says.
- No level covers the second kind of change in ADR 0002 §5 (checking rules, tool scope, network, budgets and approval scope). Those stay owner decisions at the moment of change. **Proposal.**
- A question from a member (section 2) is not an approval and no level answers it. Missing information always reaches the owner.
- **In the browser the unit of asking is the site, not the click.** Inside a site the owner has allowed (section 5), ordinary actions proceed at every level: expanding, moving to the next step, searching, an ordinary submit. Always ask and Auto therefore behave the same inside the browser; they differ for tool and app actions outside it. No product surveyed asks per button inside an allowed site.
- Massion never asks per element. A button, a checkbox or a select box does not carry its own approval; the level and section 4 decide.

### 4. What Always ask and Auto both ask

In Always ask and in Auto the member stops and asks for three kinds of action, which are the irreversible external effects of ADR 0002 §5:

1. **Paying.**
2. **Sending or posting in the owner's name.** Creating an account counts as this.
3. **Deleting what cannot be recovered.**

Paying is asked at every level, including Full access.

How Massion tells that a click, a form submission or a tool call is one of these three is specified in the browser gate design, not here. This ADR fixes only what each level does once the kind is known.

### 5. Website access is a separate choice

- Settings > Permissions has a second choice beside the level: **Always ask** (default) or **Always allow** before a member opens a website.
- With Always ask, the first visit to a site the owner's request did not name asks. The answer can be once, or always for this site; the site then appears in the list of allowed websites.
- With Always allow, a member opens websites without asking.
- This choice is not in the per-conversation chip. It does not change what section 4 asks.
- **What Always allow gives up.** A planted instruction could carry information in an address to an unfamiliar site. With Always allow nothing the host enforces stands against that; what remains is the member's own rule that read content is never an instruction (section 7). For that reason Always allow does not apply at Full access (section 3).

### 6. A remembered approval states its scope

- An approval card offers buttons that name their scope: once, or always for this site. There is no "do not ask again" checkbox. A scope that covers a whole task was considered and dropped as one choice too many.
- Remembered approvals are listed in Settings > Permissions and removed there. Removing one means the member asks again.
- Paying is never remembered. **Proposal.**
- A remembered approval never covers the second kind of change in ADR 0002 §5 (ADR 0002 invariant 5 stands).
- Rules the owner adds to say "always ask before this" are not part of 1.0.

### 7. Read content is material

- Text a member reads on a page, in mail, in a file or in a tool result is data. It is never an instruction, and it never grants a permission or counts as the owner's approval (ADR 0002 invariant 6, §11 "Received text is data").
- Page content handed to a member is marked as material and kept apart from the owner's request. The marker cannot be forged or closed early by the page, and invisible characters are removed.
- There is no up-front warning on screen. The protection the owner sees is sections 3 to 5.

**What the host enforces and what is left to the member.** The two are different kinds of protection and this ADR does not present the second as the first.

| | Enforced by the host, at every level | Left to the member's judgment |
| --- | --- | --- |
| Following a planted instruction | Nothing can make a model ignore text. The host limits what following it can do (the rows below) | The rule that read content is data, and the material marking |
| Leaving the allowed websites | A link, a form target or a redirect that points outside the allowed websites is refused before the action, and a page that ends up outside is left | |
| Opening a new website | Asked, unless the owner chose Always allow; asked at Full access regardless (section 3) | |
| Paying | Always asked; this interface never executes it | |
| Sign-in values | Filled by the host; never shown to the member; removed from anything returned | |
| Sending or deleting inside an allowed website | Asked at Always ask and Auto. At Full access not asked on the websites allowed before the work, asked on websites opened during it (section 3) | Whether the recipient or the content came from read material is not checked |

- What remains open at Full access: on a website the owner allowed beforehand, a planted instruction that the member follows can send, post or delete there without a question. That is what Full access means, and the confirmation says so.
- A test plants instructions in a page at Full access and checks that only the declared plan runs and that the page text arrives as marked material. It runs without a model, so it does not show that a model declines a planted instruction.

## Invariants at the boundaries

1. A secret value never reaches a model, a log, a Record, a command line or the UI after it is entered.
2. Paying is asked every time, at every level, and is never remembered.
3. No level and no remembered approval changes checking rules or permissions.
4. Read content never becomes an instruction, a permission or an approval.
5. A member's question is never answered by a level.
6. The automation engine never decides what may run without asking. The gate is Massion's.
7. ADR 0002 §12 stands: a lost response after an effect is unknown, and Massion does not resubmit.

## What is not decided

- **How an action is classified** as paying, sending or deleting, and what happens when it cannot be classified. ADR 0002 §12 says an unclear action is an effect; under Auto that rule alone would ask too often. The browser gate design answers this from evidence.
- **Whether Full access asks before sending and deleting.** This ADR says it does not. Revisit after use.
- **The words on screen** for the levels, the approval buttons, the sign-in form and Settings > Permissions. They come through the screen contracts and need the owner's approval.
- **Organization ceilings.** Three of the six products let an administrator cap the level. Massion 1.0 has one owner; this waits for teams.

## Alternatives and replacement criteria

- **An owner answer on each gated element.** Rejected. It asks at nearly every step of a form and trains the owner to approve without reading. It was the first design; the adapter in progress is changed to follow this ADR.
- **No level, only learned permission (ADR 0002 §6).** Replaced. It gives no way to say "ask me every time" for a sensitive task or "do not ask" for a trusted one, and every product surveyed offers that choice.
- **Two levels** (ask first, just do it). Two products show only two on their main screen. Rejected because the owner wants both a default that asks only for the three kinds and a level that does not ask; that is three.
- **Four or five levels.** Three products do this. Rejected as more than the owner needs to choose between.
- **Default: Auto.** Three products default to asking only for risky actions, and this was the first choice here. Replaced by Always ask: the owner wants the starting point to be the careful one and to loosen it deliberately. Revisit if owners switch to Auto at once and the default only adds a step.
- **A warning shown before a member reads untrusted content.** None of the six does this. Rejected as wording the owner would learn to ignore.

## Consequences

- [Environment actions](../environment-actions.md) and [Browser actions](../browser-actions.md) require an owner answer for account creation, personal-data submission, terms acceptance and unknown submissions. Those gates change to follow sections 3 and 4. The claim, single-send and no-replay machinery stays.
- The browser adapter needs a classifier for the three kinds in section 4, with a stated behavior when it cannot tell.
- The core needs a stored permission level per conversation and a default, and a store of remembered approvals with their scope.
- The permission chip, the approval card, the sign-in form and Settings > Permissions need contract changes and prototypes before they are built.
- Tests: a planted-instruction test for section 7; a test that paying asks at Full access; a test that a remembered site approval does not cover paying.

## Evidence

A survey on 2026-11-15 of how six desktop and hosted agent products choose how often to ask, what they always ask, how they remember an approval, how they ask for missing information and how they treat instructions in read content. The survey read shipped application bundles and public source; it did not observe the running screens, so layout is not part of the evidence. Only the patterns are used here; no wording is copied from those products.

## Changes to earlier ADRs

**ADR 0002**

- **§6 Learned permission, no autonomy setting.** Replaced by sections 3 and 6 of this ADR. There is a permission level with three values. "Just do this next time" becomes approval buttons that state their scope. Stored permissions are still listed in Settings and can be removed, and a learned permission still never covers the second kind of change in §5.
- **§5 first kind.** In Auto the owner is asked for paying, sending in the owner's name and unrecoverable deletion. In Full access only paying is asked. Admitting a new member is unchanged.
- **§8.** The decision card for §5 remains; which actions raise it now depends on the level.
- **§12 "An unclear action is an effect".** Stands for single-send control (no resubmission). Whether an unclear action also asks is decided by the level and by the browser gate design.

Everything else in ADR 0002 stands: one entry, no self-judgment, independent checks, quiet normal state and exceptions only.

**ADR 0005**

- **§5 Secret delegation** is unchanged. Section 2 of this ADR adds how a member obtains a value from the owner during work.
