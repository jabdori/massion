# Product charter

Massion is a personally owned AI organization that retains responsibility for outcomes beyond a conversation, model run, window or machine session.

A **Mission** supplies purpose and constraints. The **organization** supplies durable responsibilities and capabilities. **Work** owns execution and acceptance criteria. Independent **Assurance** assesses the result. **Records** preserve accepted evidence. **Memory and Growth** improve later work with traceable authority, evaluation and rollback.

The owner enters through one personalized **assistant**, and the assistant is the **Representative**. Opening Massion continues the same conversation; there is no "new conversation". The owner names the assistant, memory personalizes it, and it reports first (a morning briefing is one message in that conversation). There are no top-level tabs: a rail (conversation, results shelf, schedules, settings), a sidebar with an activity view, and a work pane that opens beside the conversation. Mission, Work, organization, executor and verifier stay in the product model but are not words the owner has to see: Work appears as a card in the conversation, and the card opens its detail. Normal progress stays quiet; only exceptions speak. See [ADR 0002](../architecture/decisions/0002-assistant-first-surface-and-independent-checks.md) and the [experience plan v3](experience-plan.ko.md).

## Product invariants

- Mission, Work, Task, Attempt, Agent and conversation are distinct concepts. Ending a model response is not completing a Work.
- Massion owns delegation: assigned responsibility, inputs, authority, model/configuration, attempts, costs, cancellation and actual results. A provider SDK cannot silently own the task hierarchy.
- Record intent before an external effect and its observed receipt afterward. An unknown outcome remains unknown until explicitly reconciled; a timeout does not authorize replay.
- Independent verification binds exact criteria and artifact versions. The author cannot certify its own outcome; a changed artifact invalidates prior proof.
- Checks are independent, not human pre-approval. A host deterministic evaluator, or a model from a different family (vendor) judging execution evidence, does the check. The owner decides only two things, at the moment they arise: irreversible external actions (money, sending in the owner's name, deletion, admitting a new member) and changes to checking rules or permissions. A decision the owner was asked can become "just do it next time" for that scope. There is no autonomy-level setting; trust is adjusted by the revert rate after automatic application.
- Records acceptance is constructed from settled effects and applicable independent evidence. Caller-supplied success is not evidence.
- Explicit user instructions and learned memory have different authority. Historical task inputs remain pinned when effective memory or policy changes.
- Growth separates reflection, proposal, independent evaluation, adoption, measured subsequent effect and revert. Prompt, Memory, Policy and Organization remain target families. Automatic adoption after an independent check is the default; it is not an alternative to verification. A target falls back to review only by calibration (revert rate). Changing evaluators or evaluation sets is an owner decision.
- Relationships among Work, documents, files, functions and evidence carry type, versions and provenance. Model-inferred links remain distinguishable from observed or code-derived facts.
- One authoritative headless core serves clients and external assistants. Closing a UI does not end host ownership; reconnecting must reconstruct state from durable facts.
- Agent identity and memory survive execution-workspace replacement. A process boundary or filesystem check is not a claim of VM/OS isolation.

## Current implementation boundary

The repository contains a **controlled development foundation**, not a completed autonomous assistant. It implements Mission/Work transitions, distinct assignments, effect receipts, independent fixture verification, accepted Records, versioned memory and a narrow measured Growth cycle. Actual files and separate verifier processes are used. SurrealDB is the authoritative host storage; in-memory storage is test-only.

The loopback workbench supports user-authored Mission/Work, explicit owner controls, two-role organization revisions, bounded memory Growth and exact retained source/accepted evidence inspection. It also retains an explicitly invoked development fixture. A durable feed-bound event client supports same-host continuation. Arbitrary model-assisted admission, general organization/staffing, production authentication and shared conversation continuation remain open. Fixture providers produce controlled candidates; no real model competence is established. See the [requirements ledger](requirements.md) for completed bounded paths and wider missing responsibilities.

The first complete vertical slice is a bounded Work A → independently accepted artifact → evaluated memory improvement → Work B → observed effect → revert, including durable interruption/recovery and two-client continuation. A document-analysis fixture guards against defining the product as coding-only. See [requirements and evidence](requirements.md) and [acceptance gates](../acceptance/first-slice.md).

## Preserved scope beyond the foundation

- Durable organization, semantic capability/staffing decisions, role reuse and organization changes; causal multi-party collaboration.
- Complete explicit/learned memory lifecycle and evaluated Growth across all four target families, including appropriate automatic adoption.
- Task-aware model selection, discovered/configured/usable distinctions, empirical capability evaluation, freshness, costs and budgets.
- Extension installation, enablement, authorized execution, contributions, version pinning, health, update and rollback; actual untrusted-code isolation.
- Knowledge exploration, graph impact/invalidation, global inbox, budgets, approvals and comprehensible evidence/action surfaces.
- Shared conversations, Work, organization, approvals and memory across clients; authenticated external-assistant integration, including dot where supported.
- Persistent project environments, isolated concurrent/risky jobs, self-hosting and scoped autonomous operation.
- Backup/restore, migrations, installer/update/rollback, supported platforms, accessibility, long-running stability and production operations.

- Core Office (Atlas, Lyra, Quill, Onyx, Vega, Iris, Cedar, Sage) and extensions (plugins) stay hidden from the main surface but remain in scope. Restore order: Representative (intake and replies) → Records → policy gate → Growth → extensions. Today's executor and verifier occupy the Vega and Iris positions. Archive code returns per requirement, not as a baseline ([ADR 0001](../architecture/decisions/0001-product-owned-core.md)).
- Direct conversation with members (office leads and agents): the assistant answers by default, and `@name` addresses that member. The record joins the assistant's thread; an instruction becomes a steer of that Work; a new task is admitted as Work. Members appear in settings and in `@` completion. Members act proactively: they start, take a task, exactly one claims it, they wake on schedule or event and watch stalled work, under a cap on member-to-member messages.
- One **external member adapter** for agents of other services; the first adapter is Reason Network, the second A2A. Arrival is not processing: the outcome stays unknown until a reply arrives. The same request is never sent twice (idempotency key). External results are verified like any other. Received text is data. Trust starts narrow.
- Proposed, per [ADR 0002](../architecture/decisions/0002-assistant-first-surface-and-independent-checks.md) sections 13–15, not yet designed in detail: the next three items.
- In-app tools and views, in order: result preview and in-conversation progress cards; then an in-app browser (reading proceeds, while submit, payment, send and the click that causes them are single-send effects) with decision cards (screenshot, amount, expiry); file, change and terminal views for coding Work; agent computer view later. One work pane with tabs beside the conversation. An extension contributes tools and views together (card, work pane tab, Work detail tab).
- Spaces: each member has a home folder (identity and memory, always retained), and, per Work, a work folder and a browser profile. Shared space is a room per Work and a results shelf; a human teammate joining is asked once, and each person's assistant conversation is private. Connected PCs: this Mac by default, a location chip only when it is not, a sleeping host pauses, and a Reason device is someone else's device. The Memory settings page shows what I said, what it learned, when it asks and member memory. Only movement across a person's boundary asks: moving something into a space another person can see asks; moving it within spaces only the owner sees only notifies. A device connected through Reason is an external member even when the owner owns it, and its results stay unknown until checked.
- Coding Work: split into child Work that can land and be verified alone; a stack is Work dependency; only the verified range from the bottom lands automatically; merge and push are confirmed by reading back; one loop turn is one change, one check, one record line; the agent pins a repeated correction at the strongest layer; guidance and document layers, and changes that narrow a rule, apply after an independent check, while a static check, verification rule or evaluator change is an owner decision card.
- Growth stages 1–2, automatic adoption, calibration and the seven stages are designed in [Growth reflection and model proposals](../architecture/growth-reflection-and-model-proposals.md).

Deferral is sequencing, not deletion. An interface, test fixture or unused helper does not complete a product responsibility.

## Next implementation order

These are also the current dogfooding blockers.

1. Basic execution path and persistent connections. Server side implemented ([design](../architecture/default-route-and-persistent-connections.md)): under a host manifest, authorizations, default routes, revocations, labels and discovered metadata are stored without secret values and restored at restart, and a request without a selection uses the saved route. Remaining: Workbench prefill and revoke/default controls, unmanaged-host persistence, live-provider evidence.
2. Assistant conversation. The Representative talks with the owner and creates Work when a request is work. Today `representative` is a domain permission role (`src/domain.ts`). Two host paths send commands with it: the runtime actor `runtime-representative` (`src/configured-runtime.ts`) and the owner Growth proposal path (`src/product.ts`). No path lets the owner talk with a Representative or get its reply, and owner Mission/Work discussion has no model reply. [Design](../architecture/assistant-conversation.md): PR 2a (segment storage, reducer, Mission-reader guard, lineage and backup) is implemented; PR 2b (Representative settings, turn path, Work admission, HTTP and surface) is pending.
3. Growth stage 1 execution trail, as designed in [Growth reflection and model proposals](../architecture/growth-reflection-and-model-proposals.md). Implemented: read-only `GET /missions/:id/reflection-trail` and the Work detail section. Stage 2 is next.

## Repository principles

This is the clean implementation in `jabdori/massion`. `jabdori/massion-archive` is historical reference, not an automatically adopted code baseline. Preserve useful requirements and verified assets without copying an abandoned implementation wholesale. Product responsibilities outrank a database, runtime or framework preference. Primary repository prose and conventional commit messages are English.

### Explicit source selection for fresh Work

After local document capture/inspection, the owner may deliberately pin exact stored ID/version/SHA plus reason to a fresh Work. Up to three distinct originals, 64KiB serialized source input, immutable original snapshots and checked Record lineage. Both bounded text roles see untrusted reference data; saving starts no execution. No automatic latest source, replacement, relations, invalidation, accounts or live-model quality claim. [Protocol](../architecture/work-sources.md), [evidence](../acceptance/work-sources-evidence.md).
