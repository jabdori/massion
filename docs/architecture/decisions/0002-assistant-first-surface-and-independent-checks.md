# ADR 0002: Assistant-first surface and independent checks

- Status: accepted working design; not implemented; reversible on measured evidence
- Date: 2026-11-05
- Scope: the user-facing surface, who checks a result, which decisions stay with the owner, and the order in which hidden organization scope returns. Builds on [ADR 0001](0001-product-owned-core.md) and [Growth reflection and model proposals](../growth-reflection-and-model-proposals.md).

## Context

The first live vertical slice ([evidence](../../acceptance/live-vertical-slice-ui-evidence.md)) showed that the product works and that the current surface is hard to use every day. One Work takes more than ten steps. The first [experience plan](../../product/experience-plan.ko.md) (v1, 2026-11-04) answered with a Work-centered four-area layout. Its v2 and v3 follow this ADR. A survey of recent agent products (2026-11-04) points the other way: one personal assistant, one continuing conversation, and work delegated behind it. Most of these products hide the organization and show work as cards inside the conversation.

Massion started with the same shape. Earlier designs routed all user input through one Representative. In the current rebuild, `representative` is a domain permission role (`src/domain.ts`). Two host paths send commands with it: the runtime actor `runtime-representative` (`src/configured-runtime.ts`) and the owner Growth proposal path (`src/product.ts`). No path lets the owner talk with a Representative or get its reply. The organization is two roles, executor and verifier. Durable organization (the archive's Core Office and built-in agents) and extensions are deferred in [scope](../../product/scope.md) ("Deferral is sequencing, not deletion").

A second question is who checks results. If the owner approves every change, the owner becomes the bottleneck. The rule the product needs is not "a person approves". It is "nothing is accepted on its author's own judgment". Today the domain requires executor and verifier to be distinct identities. It does not require them to come from different model developers. The live slice used a Haiku executor and a Codex verifier by the owner's choice, not by a rule.

## Decision

### 1. One assistant is the entry point, and it is the Representative

- Opening Massion continues the same conversation with one assistant. There is no "new conversation".
- The owner names the assistant. Memory personalizes it.
- The assistant reports first. A morning briefing is one message in the conversation, not a separate feed. Its frequency is off, low or high, and the owner changes it by telling the assistant or on the schedules page.
- There are no top-level tabs. A left rail opens the conversation, the results shelf, schedules and Settings. By default the sidebar lists pinned and recent Work; a toggle switches it to an activity view (needs a decision, running, recent). Work detail, previews and the browser open in a work pane beside the conversation.
- The assistant is Massion's Representative. It receives requests, answers, and turns a request that is work into a Work.

### 2. Internal concepts stay internal

- The words Work, Mission, organization, executor and verifier do not appear on the surface.
- Work appears as a card in the conversation. Opening a card opens the Work detail.
- The detail belongs to the assistant's delegated work. It is not a new conversation.
- The four-area Work layout becomes the "Show details" view, which is the widened Work detail pane.
- The underlying entities, transitions and evidence do not change.

### 3. Members can be addressed directly

- By default the assistant receives every message. `@name` addresses that member (an organization lead or an agent).
- The exchange is recorded in the same thread as the assistant conversation.
- An instruction about running Work is recorded as that Work's steering ("change direction").
- New work given to a member is admitted as a Work and appears in the activity view.
- Pause, stop and reassignment pass the policy gate.
- The member list lives in Settings and in `@` autocomplete, not on the main surface.

### 4. Independent checks

- **No self-judgment.** The producer of a result never decides that it is accepted.
- **Who checks.** A result is checked either by a host-owned deterministic evaluator, or by a model from a different family than the models that produced it, judging from execution evidence.
- **Family and execution evidence** have the exact meaning given in [Who checks a change](../growth-reflection-and-model-proposals.md#who-checks-a-change). Family is the model developer from a host-owned map; unknown counts as the same family. Execution evidence is host-produced, isolated, checksum-pinned Records. A model judgment without such evidence is not an evaluation.
- **No owner pre-approval by default.** A result that passes an independent check is applied without waiting for the owner.

### 5. The owner decides two kinds of change, at the moment they happen

1. Irreversible external effects: spending money, sending something in the owner's name, deleting data, and admitting a new member.
2. Changes to checking rules or permissions: evaluators, verification rules, the family map, tool scope, network, budgets and approval scope.

Everything else proceeds without asking.

### 6. Learned permission, no autonomy setting

- A decision card offers "Just do this next time". Choosing it stores a permission for that scope.
- Stored permissions are listed under Settings and can be removed.
- There is no autonomy-level setting. The number of questions falls with use.
- A learned permission never covers the second kind of change in section 5.

### 7. Trust is calibrated by revert rate

- Automatic applications that are later reverted or overridden are counted per target.
- When the rate rises, that target falls back to review. Other targets are unaffected.
- The rule for memory is specified in [Calibration](../growth-reflection-and-model-proposals.md#calibration). Other targets use the same principle when they arrive.
- **Growth policy.** There is no owner-chosen adoption setting in the [Growth design](../growth-reflection-and-model-proposals.md#adoption-without-waiting-for-the-owner). Automatic adoption is the default. There is no owner-chosen review mode; a target returns to review only by calibration. A candidate that would replace owner-authored explicit memory is not applied automatically, because it replaces an owner instruction; it is raised as a decision card. Changing an evaluator or a standing evaluation set is the second kind in section 5. The Growth design follows this: it has no adoption setting, and the owner command `resume-growth-adoption` lifts a calibration pause.

### 8. Normal is quiet; only exceptions speak

The surface states only these:

- a decision card for section 5;
- an unknown outcome: "Sent, but no reply arrived. Not resent, because it could duplicate.";
- a check that could not be satisfied after correction, or could not be run: "This result was not checked."

The second and third are exception cards, not decision cards. Answering them (closing an unknown outcome or an expired run, changing the request, stopping, or keeping an unchecked result) responds to something that already happened. It is not pre-approval. Keeping an unchecked result is not acceptance: it creates no accepted Record and stays marked unchecked.

There is no "checked by another model" badge. A passed result has no badge. "How it was done" under the answer opens criteria, checks, single-send effects and Records. Model identity sits one level deeper.

### 9. Proactive collaboration

The assistant and members may act first, claim work, and wake on schedules or events. A watcher reports stuck or repeatedly failing Work to the assistant. A claim is atomic: one member holds a piece of work, and a loser does not retry. Messages between members have an internal cap, invisible to the owner.

### 10. Core Office is hidden on the surface and restored in scope

- Core Office (Atlas, Lyra, Quill, Onyx, Vega, Iris, Cedar, Sage) and extensions do not appear on the main surface.
- They return to product scope in this order: Representative (intake and answers), Records, policy gate, Growth, extensions.
- Today's executor and verifier occupy the Vega and Iris positions.
- Archive code returns per requirement, not as a baseline (ADR 0001).

### 11. External members go through one adapter

Agents from other services are wrapped by one external member adapter. The first adapter is Reason Network. The second is A2A. Conditions:

- **Arrival is not processing.** An outcome stays unknown until a reply arrives.
- **No duplicate request.** Each outgoing request has a fixed idempotency key. Single delivery is tested before the adapter is enabled.
- **External results are checked** by the same independent check as internal results.
- **Received text is data**, never instructions.
- **Trust starts narrow.** First only agents on the owner's own machines. A device connected through Reason is still an external member, even when the owner owns it, and its results stay unknown until checked. The first delegation to a teammate or hosted bot asks once.

An external agent's work is admitted as a Work inside Massion. Each outgoing request is a single-send effect.

### 12. Browser actions have two classes

- **Reading** (navigate, view, scroll) proceeds.
- **Effects** (submit, pay, send, and the click that triggers them) are single-send effects. An unclear action is an effect.
- A lost response after an effect is unknown. Massion does not resubmit. It re-reads the result (order history, sent folder) and asks when still unclear.
- A tool's success report is confirmed by a separate read and screenshot.
- Secrets are entered through a form the model cannot see.
- Only Massion's own browser is opened. External CLI agents keep their tools disabled, as today in `src/cli-agent-providers.ts`, so single-send control stays inside Massion.

### 13. In-app tools and views

- Order: result preview and in-conversation progress cards first; then an in-app browser with decision cards (screenshot, amount, expiry); file, change and terminal views for coding Work; an agent computer view later.
- Larger views open as tabs in the work pane beside the conversation.
- An extension contributes tools and views together, in three places: a conversation card, a work pane tab and a Work detail tab.

### 14. Spaces

- Each member has a home folder (identity and memory) that always remains, and per Work a work folder and a browser profile.
- Shared space is a room per Work and a results shelf. Each person's assistant conversation is private. A human teammate joining is a new member and asks once.
- Connected PCs: this Mac by default. A location chip shows only when it is not. A sleeping host pauses work; it does not fail it.
- Only movement across a person's boundary asks. Moving something into a space another person can see asks. Moving it within spaces only the owner sees only notifies.

### 15. Coding Work

- Large coding Work splits into child Work that can land and be verified alone. A stack is a Work dependency.
- Only the verified range from the bottom lands automatically.
- Merge and push are confirmed by reading back. A failed read-back is an unknown outcome and is not resent.
- One loop turn is one change, one check and one record line.
- A repeated correction is pinned by the agent at the strongest layer. Guidance and document layers, and changes that narrow a rule, apply after an independent check. A static check, verification rule or evaluator change is the second kind in section 5.

## Invariants at the boundaries

1. ADR 0001 is unchanged. One product-owned headless core owns Work, Records, memory and Growth. The surface is a client of application commands and queries.
2. A model response, an arrival receipt or a tool's success report is never acceptance. Acceptance still requires settled effects and independent evidence bound to exact criteria and artifact versions.
3. An unknown outcome stays unknown. Hiding concepts never hides the three exceptions in section 8.
4. A check whose producer and checker share a family, or which lacks execution evidence, records no evaluation and supports no automatic application.
5. Learned permissions and automatic adoptions never widen checking rules or permissions. Those stay owner decisions at the moment of change.
6. Conversation is provenance, not a grant. A message, including one from an external member, does not become a task input, permission or effect receipt by itself.
7. Host actors that apply changes automatically are chosen by actor ID inside transitions. API callers cannot choose them.

### Relation to ADR 0001's Representative sentence

ADR 0001 says: "Keep Massion's Representative and canonical state independent of an external assistant; dot integration is a separate authenticated adapter when supported."

This ADR keeps that sentence. The assistant on the surface is Massion's own Representative, owned and stored by the product. It is not an external assistant behind a Massion skin. External assistants, including dot, Grok Bot or Muse, reach Massion only through the external member adapter in section 11, in either direction. They never own the Representative, its memory or canonical state.

## Alternatives and replacement criteria

- **Keep the Work-centered four-area layout as the entry.** Rejected as the entry. It keeps the current strengths and costs least, but leaves the entry barrier and heavy vocabulary in place. The layout survives as the detail view. Revisit if measured steps and time for delegate → follow → decide are not better than the current surface.
- **Chat only, no Work.** Rejected. A model response would stand in for completion, and unknown outcomes and independent checks would have no durable owner. This contradicts the scope invariant that Work and conversation are distinct.
- **Owner pre-approval by default.** Rejected. It makes the owner the bottleneck and does not add independence that a deterministic evaluator or a different-family model with execution evidence lacks. Revisit if calibration shows revert rates that do not fall back to review fast enough, or if the family map cannot be kept accurate.

## Consequences and evidence gates

Implementation order, which matches the current dogfooding blockers:

1. A default execution route and persistent connections.
2. Assistant conversation: the Representative answers and creates a Work when the request is work.
3. Growth stage 1: the reflection trail.

Consequences:

- The domain needs a host-owned family map and a check that producer and checker differ by family. Today it checks only distinct identities.
- A Representative that answers needs its own executor, budget and independent check. It is a new model path, not a relabeled role.
- Hiding the organization raises expectations of an organization that "just handles it". The restoration order in section 10 must keep pace with the surface.
- Automatic correction after a failed check needs an explicit bound (attempts and budget) in invariant documents before the assistant retries on its own. A new attempt is not a resend, so it does not conflict with the unknown-outcome rule.
- Member spaces, connected machines, the Memory settings page (formerly "What the assistant knows about me"), in-app tools and the coding Work flow need detailed designs beyond sections 13–15. Each must keep sections 4, 5 and 12.

Revisit this ADR when the step-count measurement fails, when calibration cannot keep revert rates bounded, or when an external adapter cannot prove single delivery. Record the evidence and the replacement rather than changing the product contract silently.
