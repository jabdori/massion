# Product charter

Massion is a personally owned AI organization that retains responsibility for outcomes beyond a conversation, model run, window or machine session.

A **Mission** supplies purpose and constraints. The **organization** supplies durable responsibilities and capabilities. **Work** owns execution and acceptance criteria. Independent **Assurance** assesses the result. **Records** preserve accepted evidence. **Memory and Growth** improve later work with traceable authority, evaluation and rollback.

## Product invariants

- Mission, Work, Task, Attempt, Agent and conversation are distinct concepts. Ending a model response is not completing a Work.
- Massion owns delegation: assigned responsibility, inputs, authority, model/configuration, attempts, costs, cancellation and actual results. A provider SDK cannot silently own the task hierarchy.
- Record intent before an external effect and its observed receipt afterward. An unknown outcome remains unknown until explicitly reconciled; a timeout does not authorize replay.
- Independent verification binds exact criteria and artifact versions. The author cannot certify its own outcome; a changed artifact invalidates prior proof.
- Records acceptance is constructed from settled effects and applicable independent evidence. Caller-supplied success is not evidence.
- Explicit user instructions and learned memory have different authority. Historical task inputs remain pinned when effective memory or policy changes.
- Growth separates reflection, proposal, independent evaluation, adoption, measured subsequent effect and revert. Prompt, Memory, Policy and Organization remain target families. Review and user-selected automatic adoption are separate operating choices, not alternatives to verification.
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

Deferral is sequencing, not deletion. An interface, test fixture or unused helper does not complete a product responsibility.

## Repository principles

This is the clean implementation in `jabdori/massion`. `jabdori/massion-archive` is historical reference, not an automatically adopted code baseline. Preserve useful requirements and verified assets without copying an abandoned implementation wholesale. Product responsibilities outrank a database, runtime or framework preference. Primary repository prose and conventional commit messages are English.

### Explicit source selection for fresh Work

After local document capture/inspection, the owner may deliberately pin exact stored ID/version/SHA plus reason to a fresh Work. Up to three distinct originals, 64KiB serialized source input, immutable original snapshots and checked Record lineage. Both bounded text roles see untrusted reference data; saving starts no execution. No automatic latest source, replacement, relations, invalidation, accounts or live-model quality claim. [Protocol](../architecture/work-sources.md), [evidence](../acceptance/work-sources-evidence.md).
