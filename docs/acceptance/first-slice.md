# First complete vertical slice

## Target outcome

A user supplies a Mission with constraints and fixed acceptance criteria. Massion assigns real responsibilities, executes a bounded Work, independently detects an incorrect candidate, accepts a corrected artifact with complete Records, evaluates a memory improvement, applies it to a later Work, observes its effect and reverts without rewriting history. Interruption and a second client must not lose responsibility or duplicate uncertain effects.

The current fixture demonstrates useful portions of that path through actual local files, oracle processes and the SurrealDB adapter. It remains a **controlled development foundation**. It is not a real-provider, production-ready or full-product completion claim.

## Existing runnable scenarios

`src/scenario.ts` exposes:

- `runCalculationScenario`: wrong candidate → independent fail → revised attempt → corrected candidate → independent pass and accepted Record.
- `runDocumentScenario`: source-backed document facts through the same acceptance contracts, without a coding-only domain.
- `runGrowthScenario`: Work A → learned-memory candidate and counterevidence → separate held-out evaluation → review-mode adoption → Work B using the new pin → actual oracle measurement → revert → a newly admitted Work using the previous pin.

`src/server.ts` now also exposes user-authored Mission/Work admission, owner cancellation/steering and durable event catch-up. The default interface shows provider/runtime blockers rather than running a fixture for user Work. See [local product interface](../architecture/product-interface.md). The explicitly requested development fixture remains separate. Host-owned native provider bindings and an explicit bounded Run path are implemented and tested with credential-free local HTTP providers. Actual live-provider compatibility/quality and the complete client contract remain open.

## Acceptance status

| Gate | Current evidence | Still required for the complete slice |
| --- | --- | --- |
| Mission and truthful lifecycle | Pinned criteria, separate execution/acceptance, retained attempts, user forms and explicit blocked state | Actual task execution and full lifecycle/controls |
| Organization and collaboration | Product-owned parent/child task and executor/verifier assignments | Real model-driven staffing and causal agent collaboration; fixed fixture actors do not establish it |
| Independent acceptance | Wrong/correct fixture, separate oracle, mock executor/verifier binding, stale/tamper rejection, sealed artifacts and Records checksum; current code independently reviewed | Live-provider semantic judgment quality and full product review |
| Memory/Growth | Actual held-out oracle scores, second-Work version use, observed effect and revert | General authority lifecycle; controlled marker routing is not autonomous learning |
| Atomic persistence | Live Surreal tests for journals, revision races, replay and response-loss readback | Migration/load limits and broader aggregate contention evidence |
| Interrupted effects | Injected receipt failure plus [six owned host-process-kill boundaries](host-process-kill-evidence.md) with actual SurrealDB: no replay, preserved drafts/events and permanent unknown quarantine | Durable worker ownership/stop proof and general reconciled resumption; current tests preserve the bounded contract without adding a resume policy |
| Shared clients | Same-host links, isolated client storage, durable catch-up, reconnect write barrier, owner instruction conflict comparison, cancellation and exact receipt cleanup through actual HTTP/SurrealDB | Broader keyboard/screen-reader/browser QA, retention/snapshot fallback, persistent approvals, conversation reconstruction and authenticated remote-PC access |
| Backup/restore | Accepted bounded text Work/Records plus sealed artifacts restored into a fresh DB/root; CLI clean SurrealKV restore, lineage/checksums and no replay verified in `tests/portable-backup.test.ts` | General artifact formats, migration, operational backup/recovery drills and broader product restore |
| Knowledge relationships | Domain multi-hop version/provenance test | Actual database graph queries, change-impact invalidation and readable product evidence |
| Model/extensions | Native provider/host manifest selection and bounded explicit executor/verifier Run tested through local HTTP mocks, including usage/errors/cancel | Authorized live-provider compatibility/quality/spend evidence; external package lifecycle and isolation |
| User control | Domain role/budget checks and owner cancel/steer UI/API; web route rejects forged verdict input | Persisted approvals, policy versions, general execution/recovery controls and authenticated identities |
| Candidate integrity | Strict pinned TypeScript, runtime checks, actual-store aggregate evidence and independent review for the named candidate below | Fresh evidence after subsequent changes; actual browser/product review and release gates |

## Published checkpoint and issue #4

[Draft #13](https://github.com/jabdori/massion/pull/13) code candidate
`e1c9a348876595749e3a666bdcee93701a2f55ff` passed pinned Node 24.19.0/TypeScript
and SurrealDB 3.3.0 CI: actual-store 306/306, zero failures/skips; ordinary
runtime 284 passes, 22 conditional DB skips. [Exact-head CI](https://github.com/jabdori/massion/actions/runs/37247267178)
and [independent review](https://github.com/jabdori/massion/pull/13#issuecomment-5986033027)
are separate evidence. These counts belong to this candidate and are not a
complete-product or later-source verification claim. Drafts remain unmerged.

[Issue #4](https://github.com/jabdori/massion/issues/4) remains open:

| Acceptance criterion | Checkpoint disposition |
| --- | --- |
| Authorized live Mission/executor/verifier/Records and non-coding quality | Path implemented; local mocks verified; live/quality gate #5 remains open |
| Wrong/correct/stale/tampered results | Controlled artifact/version contract verified; model judgment quality remains open |
| Second client/interruption/cancel/steer/no blind replay | Bounded same-host HTTP/DB contract verified; general worker recovery/approvals remain open |
| Actual browser visual/accessibility journey | Bounded actual Chrome click/visual/axe journey recorded in [browser QA](browser-qa.md); broader keyboard/screen-reader/platform review remains open |
| Accepted Work plus sealed artifacts restored into clean environment | Bounded text/fixture path verified; general product restore remains open |
| Final-candidate report and stale status reconciliation | This named code checkpoint has CI/review evidence; browser/live/general gaps remain explicit |

SUR-01 describes shared Work state demonstrated on one loopback host, not shared
conversation or authenticated remote PC deployment. Local drafts are volatile and
private; committed owner instructions are durable Work inputs. The general
conversation-to-Work choice is deferred. The established central core and distinct
conversation/Work/Agent/execution-session concepts are preserved.

## Required final-candidate evidence

For each run, retain the source revision, runtime/store/provider versions, command, result counts, skipped checks, artifact identities and limitations. Fixture results must carry `evidenceClass: fixture`. A passing test that used an in-memory store is not durable database evidence.

Run `npm run check` for strict TypeScript, runtime syntax and the ordinary test suite. Actual-store tests require the configured disposable SurrealDB endpoint; without it they are skipped. The opt-in storage crash test owns a nested isolated DB lifetime and preserves the outer suite server for later fresh clients. See [storage reproduction instructions](../architecture/storage.md).

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

## Bounded database replacement recovery

[Same-host read recovery](cursor-recovery-evidence.md) extends issue #4’s second-client/interruption criterion: isolated fresh database replacement, including the same numeric cursor with different Mission state, obtains a consistent snapshot/feed boundary while retaining drafts and unknown command/fixture markers. Fresh reads and current permissions gate writes; recovery never resends commands or invokes models. This does not close the full recovery, remote-authentication or live-quality acceptance criteria. Exact published-candidate checks/review are linked from the Draft PR and issue #4 follow-up.

## Current bounded path audit above PR54

Audit of requirements/ADR/issue #4 against normal CLI/UI (2026-10-07): historical checkpoints above retain their own counts. The following maps current bounded implementations, not full-product closure.

| Issue #4 criterion | Current disposition | Unverified or separate requirement |
| --- | --- | --- |
| User-authored Mission → executor → separate verifier → Record, including non-coding quality | Normal CLI/UI fixture path implemented and exercised | Authorized real-provider account/input/auth/usage-spend and independent semantic quality evaluation; no live call authorized here |
| Wrong → corrected → accepted; stale/tampered exact versions | Rejected-text inspection and distinct correction Work → separate explicit Run → new Record through normal UI verified; original retained | Real model judgment quality, beyond fixture process independence |
| Second client/interruption/cancel/steer/no replay | Same-host actual DB/HTTP/client continuation, owned CLI kill/drain, exact expired closure UI, private drafts and unknown receipt barriers verified | General workers/recovery, remote identity and persistent approvals; no unknown outcome/retry authority inferred |
| Actual browser visual/accessibility journey | Named Chrome native-keyboard/visual/narrow-layout journeys and earlier bounded axe checks exist | Full latest-head journey-wide assistive-technology/screen-reader and multi-browser/platform certification not established |
| Accepted Work + sealed artifact clean restore | Real backup CLI clean DB/root and lineage already verified; this follow-up adds missing normal CLI/UI relocated original-text inspection and restart without effects | General artifact formats/migrations/operational recovery drills; not blanket recovery authority |
| Final-candidate evidence and truthful docs | Each Draft carries exact-head CI/raw counts/review; this audit reconciles normal restore and stale byte-serving prose | Keep full issue #4 open; local/CI conditional browser skips and live/not-run gates stay separate |

The wider requirements rows remain partial. Model-assisted interpretation/staffing/collaboration, further Growth targets, native graph/ingestion, extension lifecycle, packaging and production operations remain unimplemented or unverified; this audit does not classify all of them as automatically authorized implementation or as all needing external permission. They require an independently selected scope/acceptance. This increment selects only the normal restored-text inspection gap. Live providers, remote authentication/credentials, unknown recovery authority, merge/deployment and paid resources require their respective explicit authorization and were not performed.
