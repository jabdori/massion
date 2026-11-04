# First complete vertical slice

## Target outcome

A user supplies a Mission with constraints and fixed acceptance criteria. Massion assigns real responsibilities, executes a bounded Work, independently detects an incorrect candidate, accepts a corrected artifact with complete Records, evaluates a memory improvement, applies it to a later Work, observes its effect and reverts without rewriting history. Interruption and a second client must not lose responsibility or duplicate uncertain effects.

The current fixture demonstrates useful portions of that path through actual local files, oracle processes and the SurrealDB adapter. It remains a **controlled development foundation**. It is not a real-provider, production-ready or full-product completion claim.

## Existing runnable scenarios

`src/scenario.ts` exposes:

- `runCalculationScenario`: wrong candidate → independent fail → revised attempt → corrected candidate → independent pass and accepted Record.
- `runDocumentScenario`: source-backed document facts through the same acceptance contracts, without a coding-only domain.
- `runGrowthScenario`: Work A → learned-memory candidate and counterevidence → separate held-out evaluation → review-mode adoption → Work B using the new pin → actual oracle measurement → revert → a newly admitted Work using the previous pin.

`src/server.ts` now also exposes user-authored Mission/Work admission, owner cancellation/steering and durable event catch-up. The default interface shows provider/runtime blockers rather than running a fixture for user Work. See [local product interface](../architecture/product-interface.md). The explicitly requested development fixture remains separate. Real-provider execution and the complete client contract are still open.

## Acceptance status

| Gate | Current evidence | Still required for the complete slice |
| --- | --- | --- |
| Mission and truthful lifecycle | Pinned criteria, separate execution/acceptance, retained attempts, user forms and explicit blocked state | Actual task execution and full lifecycle/controls |
| Organization and collaboration | Product-owned parent/child task and executor/verifier assignments | Real model-driven staffing and causal agent collaboration; fixed fixture actors do not establish it |
| Independent acceptance | Wrong/correct fixture, separate oracle, stale/tamper rejection, sealed artifacts and Records checksum | Real-provider result quality and independent product review |
| Memory/Growth | Actual held-out oracle scores, second-Work version use, observed effect and revert | General authority lifecycle; controlled marker routing is not autonomous learning |
| Atomic persistence | Live Surreal tests for journals, revision races, replay and response-loss readback | Migration/load limits and broader aggregate contention evidence |
| Interrupted effects | Real file write followed by injected receipt failure; reconnect refuses a second effect | Actual host process death at admission/write/receipt boundaries, durable owner detection and reconciled resumption |
| Shared clients | Snapshot reads, CAS conflicts, durable cursor catch-up and actual HTTP-host restart tests | Retention/snapshot fallback, approvals, conversation reconstruction and production identity across clients |
| Backup/restore | Actual database crash/restart and fresh database import tests for storage fixtures | Restore accepted product state **and** sealed artifacts into a clean environment and validate checksums/links |
| Knowledge relationships | Domain multi-hop version/provenance test | Actual database graph queries, change-impact invalidation and readable product evidence |
| Model/extensions | Pinned controlled-provider/built-in capability checks | Actual configured provider, observed usage/errors/cancel, external package lifecycle and isolation |
| User control | Domain role/budget checks and owner cancel/steer UI/API; web route rejects forged verdict input | Persisted approvals, policy versions, general execution/recovery controls and authenticated identities |
| Candidate integrity | Runtime syntax checks and tests with explicit live-store opt-ins | Static TypeScript checking, final-revision aggregate evidence and independent review |

## Required final-candidate evidence

For each run, retain the source revision, runtime/store/provider versions, command, result counts, skipped checks, artifact identities and limitations. Fixture results must carry `evidenceClass: fixture`. A passing test that used an in-memory store is not durable database evidence.

Run `npm run check` for runtime syntax and the ordinary test suite. Actual-store tests require the configured disposable SurrealDB endpoint; without it they are skipped. The opt-in storage crash test kills its own test server and must run separately from clients sharing that server. See [storage reproduction instructions](../architecture/storage.md).

The complete-slice fault matrix must cover:

1. Before effect admission: no effect and no partial journal.
2. After durable admission, before invocation: deterministic ownership/reconciliation without duplicate admission.
3. After actual external write, before receipt: unknown state persists; no automatic effect replay.
4. After receipt, before client response: command retry returns the original outcome.
5. After verifier pass, before acceptance: changed bytes or versions invalidate proof.
6. During approval or client disconnect: recovery preserves the pending decision and rejects stale/wrong-scope responses.
7. During policy/memory/organization updates: new Work uses the intended version; existing Work history is unchanged unless explicitly rebound.

## Separate release gates

These remain required product scope but are not implied by a successful first fixture: real VM/OS isolation and resource controls; supported external dot integration; complete organization and collaboration lifecycle; automatic Growth and other target families; external extension security; full product surfaces and accessibility; platform installation/update/rollback; authenticated production hosting; long-run memory/shutdown/load behavior; backup operations and recovery drills.

A completed checkpoint should say precisely what was demonstrated. Do not call the whole product complete because a helper exists, a fixture passed, a README was published or a build artifact was uploaded.
