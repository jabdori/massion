# ADR 0001: Product-owned headless core and separate SurrealDB

- Status: accepted working design; reversible on measured evidence
- Date: 2026-10-03
- Scope: clean Massion implementation and first development slice

## Context

Massion must retain Mission, organization, durable Work, independent verification, Records, memory and Growth across model and UI lifetimes. Historical failures included SDK-hidden delegation, model completion mistaken for outcome acceptance, replay of uncertain effects, stale evidence, and documented capabilities without an actual product path.

Relationship-centric requirements include Work dependencies, documents, files, functions, evidence and change impact. SurrealDB's multimodel direction must be evaluated as part of that workload. Embedded packaging difficulties do not alone establish that the product should abandon its relation model or switch databases.

## Decision

Use one authoritative headless application and a separately operated SurrealDB service. All clients use application commands and queries, not direct database access. The present development runtime is Node 24.19-compatible TypeScript executed using native type stripping, with built-in test/HTTP/filesystem facilities. Runtime syntax validation is not static type checking.

Keep the core modular:

- `src/domain.ts`: entities, transitions, authority and evidence invariants.
- `src/application.ts`: trusted actors, command envelope, revision/idempotency admission and persistence orchestration.
- `src/storage.ts`: authoritative-store boundary, Surreal transactions and ambiguous-outcome reconciliation. `InMemoryStore` is test-only.
- `src/execution.ts`: controlled execution and independent verification, artifact snapshots and built-in capability contract.
- `src/scenario.ts`: the explicit fixture application path through Work, Records and Growth.
- `src/server.ts`: loopback development workbench and narrow headless transport.

The current store persists a Mission aggregate snapshot plus operation/audit/event/outbox records. Atomic snapshot/journal persistence is a bounded first implementation; it is not the final typed graph schema or a claim that whole-Mission aggregate contention scales indefinitely.

Use project-scoped persistent workspaces as the intended execution model, with separately isolated risky or concurrent jobs. The current owned fixture directory is a development precursor, not a VM sandbox. Keep Massion's Representative and canonical state independent of an external assistant; dot integration is a separate authenticated adapter when supported.

## Invariants at the boundaries

1. A command identifies its actor, idempotency key and expected revision. Retrying returns the original accepted result, not a recomputed transition from newer state.
2. State, events, audit and outbox intent commit atomically. Snapshot isolation is not described as general serializable isolation; writers contend on the aggregate and deterministic operation keys.
3. A lost response is reconciled read-only by operation identity. Absence immediately after timeout does not prove rollback. External effects are never recovered by replaying text or assuming a stale lease means no action occurred.
4. Product-owned assignments and fixed artifact/criteria versions govern independent Assurance and Records. Providers cannot supply their own trusted acceptance result.
5. Model, extension, policy, memory and organization versions need explicit task bindings as those contracts mature. New versions must not silently rewrite historical execution.
6. Volatile token streams are distinct from durable events. Client catch-up requires a proper durable cursor, not timestamp ordering.

## Alternatives and replacement criteria

- **Continue the archived implementation:** rejected as the new baseline. Reuse verified requirements or assets selectively; do not inherit accidental omissions or framework ownership.
- **Use a file or SQLite fallback because it is locally convenient:** not selected. In-memory tests are valid, but the development host has one authoritative storage path. An unavailable server is an integration blocker, not permission to claim equivalent durability.
- **Immediately switch to PostgreSQL:** not selected without workload evidence. Revisit if the selected SurrealDB configuration cannot meet atomicity, outcome reconciliation, relation fidelity, operational stability or measured workload needs at reasonable complexity.
- **Embed the DB in every client:** not selected for this shared-authority design. Separate deployment decouples UI/native packaging and storage lifetime; it does not eliminate database or operational complexity.
- **Let an agent SDK own tasks/memory:** rejected. SDKs can be adapters; the product owns responsibility, authority, evidence and recovery.
- **Distributed microservices or offline multi-writer peers now:** deferred. Neither is needed to prove this first bounded path. Deferral does not prohibit a later independently justified design.

## Consequences and evidence gates

The design adds explicit database operation and backup responsibilities, while keeping clients and model adapters replaceable. One aggregate simplifies the first atomic boundary but will need measured contention and graph-projection work. Loopback development uses fixed actors and deliberately limited routes; it is not production security.

The actual local storage tests and exact tested SurrealDB configuration are documented in [storage.md](../storage.md). Before a complete vertical-slice claim, also establish durable effect-worker recovery, full product/artifact restore, global event catch-up, independent current-head review, real-provider execution and usable control surfaces. VM, external assistant, deployment and packaging claims require separate actual evidence.

Revisit this ADR when a conformance gate fails, the measured relationship/workload changes, or a deployment requirement cannot be met. Record the evidence, replacement rationale, preserved responsibilities and migration/rollback plan rather than silently changing the product contract.

## Bounded provider dispatch ownership follow-up (2026-10-07)

Above PR43, add an explicit one-shot claim between durable provider effect intent and adapter invocation. The claim binds the original host/dispatch, registered assignment/model and canonical bounded request hash. Only a fresh committed claim authorizes the current caller to attempt its invocation; a replayed or ambiguous response cannot be used as a retry instruction. Claim/intent is not evidence of an external call or success. Unknown effects and original Records survive crash/restart without reclaim, lease expiry or effect replay. This is a prerequisite for a later durable worker, not that worker or a distributed transaction. PR43 commit-call admission fencing and its in-flight transaction/remote stop limits remain unchanged.

## Durable owner Work conversation follow-up (2026-10-07)

Above PR44, retain a separate bounded conversation entity for an exact existing Work. Owner-authored messages and explicit earlier same-thread replies append through the normal application CAS/idempotency boundary and durable feed. They are conversation provenance, not automatic task inputs, grants, effect receipts, runtime recovery decisions or accepted Record data. Clients can share original messages across host lifetime while retaining private reviewed drafts. This is an owner discussion foundation; model/Representative answers, general questions, authentication and conversational autonomy require separate acceptance.

## Owned host drain follow-up (2026-10-07)

RUN-01/WRK-01 require the headless host to supervise its own shutdown. Before closing normal HTTP service, synchronously fence new local admissions and interrupt only runtime controllers owned by this host. Persist the original run/dispatch/host-bound local shutdown cause and preserve unknown effects, claims and reservations; never infer remote stop, effect success, lease reclaim or replay. Bound service drain and report unresolved shutdown when durable closure or sockets do not settle. Preserve original accepted and historical Work/conversation data; test real normal CLI signals with controlled loopback providers and actual disposable storage before publication.

## Explicit expired-run closure follow-up

Above PR46, retain no-replay admission after crash and provide one owner decision naming the original bounded run ownership and elapsed deadline. Server clock forbids future observations; atomic command identity records owner reason/uncertainty acknowledgment. Share the existing deadline interruption fence while preserving claims, receipts, reservations, cancellation and accepted originals. This closes stranded activation-only runs without inferring worker death, remote stop, retry or restored grants. Scope and preimplementation acceptance: [expired-run](../expired-run.md).

## Bounded local admission capacity follow-up

Above PR47, supervise one distinct Work admission at a time in the normal top-level Work runtime using existing local promise/active tracking. Reuse pure fresh Work/CAS/no-replay conditions; an occupied admission rejects another fresh Work without a durable state/queue or automatic future dispatch. Reservation precedes asynchronous admission reads; exact settlement releases only local capacity and never settles or replays unknown external effects. Validate controlled actual DB/normal CLI and existing browser preflight diagnostics. [Scope and acceptance](../host-admission.md) distinguish this local bound from global/remote concurrency, leases, budgets and complete scheduling/recovery.

## Explicit bounded sequence follow-up

Above PR48, connect owner-declared exact existing fresh Work in bounded order to the same run/Assurance/Records path. Each next Work requires prior accepted evidence and original revision/configuration, with no replay or silently resumed plan after error/restart. Reuse Work/journal/claims and local admission rather than adding a scheduler entity/queue/state. [Preimplementation purpose and acceptance](../run-sequence.md) preserve partial-progress and unknown boundaries.

## Explicit sequence GUI follow-up

Above PR49, give the owner exact private plan controls connected to the existing headless sequence API. Review remains revision/feed/configuration bound; first individual admission receipt is not an outer completion receipt. Preserve unknown/no replay, actual Work cancellation and private drafts without a new durable scheduler/queue/state. [Scope and acceptance](../run-sequence-panel.md).

Owner prerequisite authoring above PR50 uses the existing exact Work pin transition and version-bound acceptance gate through the normal UI. Client review is advisory and private; the server remains authoritative. No new execution authority, scheduler, pin rebinding or automatic continuation is added. See [panel protocol](../work-prerequisite-panel.md).

Failed candidate inspection above PR51 uses the product-owned original Work/verdict/immutable artifact, with query-only exact binding and known settled evidence. Reading a rejection creates no accepted Record, additional attempt, retry or execution authority. [Scope and acceptance](../rejected-candidate-text.md).

Known rejection correction above PR52 appends a distinct owner-admitted Work with historical exact failed provenance, preserving the original and binding the new execution/Record. Existing admission/permission and separate explicit Run apply; unknown effects never become retry permission. [Scope and acceptance](../owner-correction-work.md).

The expired-run owner UI follow-up to PR53 exposes the already approved exact local closure command through private selection, read-only original ownership review, Cancel and explicit Close. Server-observed time is frozen with original host/dispatch/deadline and current revision/feed; stale and late reads cannot authorize closure. Unknown claims/receipts/reservations survive, receipt reconciliation never resubmits, and restart grants/replay remain zero. This is an issue #4 interruption-inspection increment, not effect recovery or external stop proof.

Normal restored-text inspection above PR54 composes the existing explicit relocation reader into normal host startup for product-owned evidence queries. Original descriptors and Record checksums remain immutable; exact inventory and current bytes are validated before serving. Runtime's normal artifact writer remains separate, and no journal import, outbox replay, grants or unknown-effect outcome is created. [Acceptance](../restored-artifact-reader.md).

Restore capacity prevention above PR56 measures the exact normal HTTP RPC envelope and fails closed before schema/artifact mutation when it exceeds the explicit bounded client budget. Offline checking validates retained data without contacting a destination. The budget is not server-capacity discovery or a success guarantee; unknown restores retain identity and evidence and are never automatically replayed. No database/global configuration, new transport or splitting protocol is introduced. [Scope and evidence](../../acceptance/restore-preflight-evidence.md).

## Explicit owner conversation-to-Work draft

Above PR57, adopt one owner-selected saved message as provenance for a separately reviewed new Work. Discussion remains unchanged and does not become a runtime grant. The edited task, current admission pins and immutable source message are distinct; existing CAS/receipt/no-replay and separate explicit Run govern all effects. [Design and preimplementation acceptance](../conversation-work-draft.md).

## Exact memory usage inspection

Expose only original exact-version memory/Work/Record relationships from one authoritative read boundary, with explicit bounds and current effective versus historical pin semantics. No read result becomes permission, inferred applicability or task rebinding. [Scope and acceptance](../memory-usage.md).

## Explicit browser-local file document draft

Read only the owner's selected bounded UTF-8 File in the client, retain truthful raw-file versus normalized draft provenance, then reuse existing separate exact document admission. No host path access or source execution/verification authority follows from ingestion. [Preimplementation acceptance](../owner-file-document-draft.md).

Owner-authored first-execution clarification is a bounded COL-01/WRK-01 increment: [contract](../owner-work-clarification.md). Unanswered questions block admission; immutable answers alone never start execution. General agent questioning and shared conversation remain open.

Above PR61 `5d39dbdd`, normal fresh-client continuation can discover stored Mission identities without a remembered ID. The read-only bounded catalog remains database/feed/cursor bound and loads current state through existing controls, with no readiness or execution claim. [Preimplementation scope and acceptance](../stored-mission-catalog.md). Full MIS-01/SUR-01 and issue #4 remain partial.

Above PR62 `b89a3868`, an explicitly read-only unresolved Work inbox connects the preserved global inbox purpose to stored owner questions, execution blockers, failed/stale Assurance and unknown/closed pending outcomes across Missions. Current evidence and owner decisions remain in the existing fresh Load/Work controls; no list becomes a grant or resolved receipt. [Preimplementation scope and acceptance](../unresolved-work-inbox.md). Full WRK-01/GOV-01/SUR-01 and issue #4 remain partial.

[Unresolved Work inbox bounded verification](../../acceptance/unresolved-work-inbox-evidence.md).

Above PR63 `a8455f4d`, REC-01/KNW-01/WRK-01 and issue #4 connect exact accepted text to owner-reviewed retained document source and future Work input through existing contracts. No automatic copy, verified relation or new execution authority. [Preimplementation scope and acceptance](../accepted-result-source-draft.md).

[Accepted result source bounded verification](../../acceptance/accepted-result-source-evidence.md).

Above PR64 `11478ffc`, KNW-01/ADR0001 and issue #4 preserve knowledge exploration through an explicit exact-version incoming/outgoing neighborhood over existing Relation declarations. No endpoint existence/quality or execution authority is inferred. [Scope, acceptance and bounded verification](../exact-knowledge-neighborhood.md).

Above PR65 `a5bc7642`, MIS-01/ADR0001 and issue #4 retain owner-versioned Mission constraints for future Work while preserving every old Work/Record and execution authority. [Preimplementation scope and acceptance](../mission-constraint-revisions.md).

[Mission constraint revision bounded verification](../../acceptance/mission-constraint-revisions-evidence.md).

Above PR66 `5a3481da`, owner Mission discussion can precede the first Work, then explicitly seed an independently reviewed new Work through existing source/acceptance boundaries. [Preimplementation scope and acceptance](../mission-conversation-to-work.md).

Owner-declared explicit memory conflicts above PR67 bind two immutable version hashes through normal CAS/feed/receipt/journal admission. Only new Work admission checks both exact versions currently applying; retirement changes applicability without rewriting declaration history or older Work/Records. This is an owner statement, never an inferred contradiction, new model policy or existing Work execution block. [Bounded contract](../memory-conflicts.md).

Owner-declared explicit memory expiry above PR68 binds an immutable exact version hash, future canonical UTC deadline and reason. Host time is immutable event context, outside caller authority and command identity; replay/restore uses that recorded context. A nondecreasing committed watermark rejects observed rollback, but is not external trusted time. Only new Work admission checks expired effective versions. Existing Work execution/pins/Attempts/Records remain unchanged; existing retirement and a separate new admission are deliberate. No timers, automatic retirement/delete/replay, learned policy or new grants. [Bounded contract](../memory-expiry.md).

The stored-memory usage reader above PR69 must preserve the original literal identity accepted by portable lineage. ID validation follows the existing nonblank/well-formed/16,000-unit contract instead of an unrelated ASCII identifier restriction. No trimming/normalization, latest-version substitution, saving-rule expansion, authority change or write occurs. Original Work/Record pins and current feed/revision/late-read boundaries remain authoritative. [Bounded correction](../memory-usage-literal-ids.md).
