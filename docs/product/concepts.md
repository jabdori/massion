# Massion concepts

A **Mission** holds purpose and constraints. A **Work** owns a requested outcome, its execution and acceptance criteria. Independent **Assurance** checks the result; an accepted **Record** preserves its evidence. **Memory** supplies versioned instructions for later Work, and **Growth** evaluates changes to how later Work is done. A conversation or model response is not a completed Work. See the [product charter](scope.md) and [product-owned core](../architecture/decisions/0001-product-owned-core.md).

## The graph

The graph connects Works, documents, files and evidence. A relationship identifies its kind, both endpoint versions and its provenance: where the link came from. The current kinds are dependency (`depends-on`), supporting evidence (`evidenced-by`) and containment (`contains`). Documents retain successive versions; artifacts carry a kind, version and content hash. A relationship can name a file or another reference without proving that the endpoint exists or its contents are true. See [relationship records](../architecture/owner-relations.md), [retained documents](../architecture/owner-documents.md) and [storage boundaries](../architecture/storage.md).

Model-inferred links remain marked as inferred, distinct from observed or code-derived facts. An owner-authored link is a declaration with provenance, not independent verification; the current owner path records it as non-inferred. The distinction must survive inspection and restore. See [relationship records](../architecture/owner-relations.md) and [the graph requirement](scope.md#product-invariants).

Exact version pinning keeps old Work under its original conditions. Work retains its Mission inputs, criteria, applied memory versions, selected source documents and organization revision where present. Assignments and accepted Records retain the corresponding model, configuration, extension and evidence bindings. A new document, memory or organization revision does not silently rebind old Work. This is not a claim that every planned policy or extension lifecycle is implemented. See [source pins](../architecture/work-sources.md), [Mission revisions](../architecture/mission-constraint-revisions.md) and [organization revisions](../architecture/organization-revisions.md).

The implemented neighborhood reader follows direct incoming and outgoing links at an exact version. Reverse impact tracing starts with a changed reference and follows incoming relationships across multiple hops to list potentially affected references. Both are read-only: they neither invalidate accepted Records nor schedule re-execution. See [neighborhood exploration](../architecture/exact-knowledge-neighborhood.md) and [reverse impact](../acceptance/relation-impact-evidence.md).

Historically, separating a persistent project graph from transient execution goes back to the owner's earlier jabtang-go prototype, which split a Project Graph (persistent topology) from an Execution Graph (transient runtime). Source (local archive, not public): `pi-dev/docs/plans/2026-04-01-jabtang-go-execution-plan.md`, Phase 3, cited the same way as the earlier designs in [ADR 0004](../architecture/decisions/0004-member-rooms-mutual-challenge-and-discriminator.md).

## Change-history audit graph

A change-history audit graph treats changes and handling events as nodes with identities, rather than only log lines. Its links express evidence, dependency, replacement, correction, exact-version use, cause and who decided. The current system retains parts of this history as relations, immutable revisions, correction Work, intervention events and accepted Records; it does not yet expose them as one audit graph. See [storage](../architecture/storage.md), [correction Work](../architecture/owner-correction-work.md) and [intervention history](../acceptance/intervention-history-evidence.md).

| Audit link | Current implementation |
|---|---|
| Evidence (`evidenced-by`) and dependency (`depends-on`) | Implemented as versioned relations. Evidence also binds artifacts, verdicts and receipts in accepted Records. |
| Replacement (`supersedes`) | No general edge kind. Document and organization revisions retain earlier versions; memory tracks which version is effective. |
| Correction (`corrects`) | Implemented as a new Work's exact correction pin, including the original Work, input, criteria, verdict and artifact hashes, author and reason; no general edge kind. |
| Exact-version use (`pinned-version`) | Implemented as Work source, memory, organization and prerequisite pins, plus Record bindings; no general edge kind. |
| Cause (`cause`) | Runtime interruption and recovery retain particular causes and affected effect identities; general causal edges are not implemented. |
| Decision author (`decided-by`) | Commands and intervention history retain actor and command identity; revisions and correction pins retain author and reason. No general edge kind. |

These distinctions follow the [relationship contract](../architecture/owner-relations.md), [organization history](../architecture/organization-revisions.md), [source selection](../architecture/work-sources.md), [prerequisite pins](../architecture/work-prerequisites.md), [runtime lifetime](../architecture/runtime-lifetime.md) and [quarantine decisions](../architecture/owner-quarantine.md). Code boundaries: [domain entities](../../src/domain.ts), [correction pins](../../src/work-correction.ts) and [intervention reader](../../src/work-budget-history.ts).

| Capability | Implemented now | Not yet implemented |
|---|---|---|
| Back-tracing: why this result, from which evidence and versions? | Inspect exact accepted Records, source pins, correction provenance and intervention history. A read-only reflection trail gathers one finished Work's inputs, attempts, effects and verdict. | One general causal traversal joining every change and decision into an explanation. |
| Forward tracing: what might this change affect? | Exact-version reverse traversal over stored relations, preserving provenance and inferred flags. | Complete automatic dependency discovery, invalidation or re-execution. |
| Reconstruct the graph at a point in time | The retained operation journal contains historical snapshots and supports validated backup and inert restore. | A user-facing arbitrary-time graph query or unified temporal audit-graph view. Journal restore is not that interface. |

Sources and implementation: [reflection trail design](../architecture/growth-reflection-and-model-proposals.md) and [reader](../../src/reflection-trail.ts); [impact evidence](../acceptance/relation-impact-evidence.md) and [reader](../../src/relation-impact.ts); [portable backup](../architecture/portable-backup.md) and [journal storage](../../src/storage.ts). Storage currently uses aggregate snapshots and operation/event/audit records, not the complete typed audit-graph schema.

## Growth

Growth separates **retrospective → proposal → independent evaluation → adoption → effect measurement → rollback**. A promising idea is not an adopted improvement. The intended targets are **prompt, memory, policy and organization**; only memory has an executable Growth cycle today. See [Growth requirements](scope.md#product-invariants), [bounded proposals and evaluation](../architecture/growth-proposals.md) and [later stages](../architecture/growth-reflection-and-model-proposals.md#later-stages).

| Stage | Current implementation |
|---|---|
| Retrospective | A deterministic, read-only reflection trail for an eligible finished Work is implemented. Automatic reflection and lesson extraction are not. |
| Proposal | Owner-authored, versioned memory candidates with provenance and counterevidence are implemented. Model-proposed candidates are designed, not implemented. |
| Independent evaluation | A host-owned rounding evaluator compares exact baseline and candidate memory on supplied cases in a separate bounded process. General prompt or policy evaluation and model evaluators are not implemented. Caller-supplied cases are not a secret held-out set. |
| Adoption | Explicit owner adoption requires independently measured improvement. Automatic adoption after a check is designed, not implemented. |
| Effect measurement | An evaluator can retain one metric from a later accepted Work that used the candidate; the controlled fixture exercises it. Multi-observation monitoring and automatic degradation detection are not implemented. |
| Rollback | Explicit owner revert restores the prior effective memory selection and preserves historical Work and Records. Automatic rollback is not implemented. |

The code implements these boundaries in [Growth transitions](../../src/domain.ts), [owner proposal/evaluation/adoption/revert](../../src/product.ts), [the rounding evaluator](../../src/growth-evaluation.ts) and [the controlled cycle](../../src/scenario.ts). See also [owner Growth evidence](../acceptance/owner-growth-evidence.md) and [proposal evidence](../acceptance/growth-proposals-evidence.md). Fixture success does not establish general learning quality.

The intended trust rule counts automatic applications later reverted or overridden, per target. A rising rollback rate returns that target to review; it does not lower the independent-check requirement. This calibration is **not yet implemented**, nor are prompt, policy or organization Growth adoption. Changing checking rules or permissions remains an owner decision. See [calibration](../architecture/growth-reflection-and-model-proposals.md#calibration) and [ADR 0002](../architecture/decisions/0002-assistant-first-surface-and-independent-checks.md).

## Core rules

- **Unknown outcome.** A timeout or lost reply is not proof of failure and never authorizes resending an external effect. Record intent before the effect, preserve uncertainty and reconcile by original identity and observed evidence. See [core invariants](scope.md#product-invariants) and [storage reconciliation](../architecture/storage.md).
- **Independent verification.** An author cannot certify its own result. Acceptance requires settled effects and independent evidence bound to exact criteria and artifact versions. A same-family model may check Work in a separate run with a distinct identity and fresh context when no different family is available; that does not qualify it for automatic Growth adoption. See [ADR 0003, checking rules](../architecture/decisions/0003-members-internal-teams-model-groups-and-apps.md#7-checks-when-only-one-family-is-available) and [family-check implementation](../architecture/family-map-and-model-groups.md).
- **Correction Work.** Preserve the rejected original; a new Work carries its exact source and the owner's correction reason, then undergoes its own execution and check. The implemented path requires a known, settled rejection. An unknown outcome cannot authorize a correction as a retry. See [correction Work](../architecture/owner-correction-work.md).

The two kinds of change only the owner decides are named in [ADR 0002 §5](../architecture/decisions/0002-assistant-first-surface-and-independent-checks.md#5-the-owner-decides-two-kinds-of-change-at-the-moment-they-happen):

1. **Irreversible external effects:** spending money, sending something in the owner's name, deleting data, and admitting a new member.
2. **Changes to checking rules or permissions:** evaluators, verification rules, the family map, tool scope, network, budgets and approval scope.

These are product rules, not a claim that every decision surface or external integration is complete. Responding to an already unknown outcome or failed check is exception handling, not a third pre-approval category. There is no autonomy-level setting. See [the charter](scope.md) and [ADR 0002's exception rules](../architecture/decisions/0002-assistant-first-surface-and-independent-checks.md#8-normal-is-quiet-only-exceptions-speak).
