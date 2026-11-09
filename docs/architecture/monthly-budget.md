# Monthly usage and owner budget decisions (E8)

A calendar month in the owner's persisted IANA timezone is the accounting period. The existing providers record input and output tokens, but no monetary prices. The enforceable monthly unit is output tokens; currency cost stays unknown. The usage read sums original provider receipts and settled conversation turns from the durable event feed, once per original call. It never prices tokens or treats unknown usage as zero.

One reserved conversation aggregate holds the owner limit, timezone, run reservations and one open/deferred decision per period. CAS serializes admission across runtime instances. Before a fresh Work starts, reserve its existing full executor/verifier/team output cap. Known usage consumes that reservation; terminal, fully known runs release the unused part. Pending or unknown calls retain their bounds across restart. Existing unreserved runs are included when enabling a limit. A lost reservation acknowledgment never authorizes invocation.

If there is insufficient capacity, retain the exact fresh Work as budget-waiting, without a runtime activation or provider call. Repeated attempts join the same period decision. Raising the limit requires an explicit owner command bound to the shown aggregate revision and proposed limit, with actor/time in the journal. Later and reopen only change the decision; month rollover and another limit change do not resume a paused Work. Startup and first reads can reconcile a previously accepted owner decision only for unchanged budget-paused Work without runtime or effect evidence. An explicitly accepted raise releases only that decision's fresh waiting Works, and the normal explicit runtime path checks their original inputs and current configuration again. Unknown admission or a replayed decision never starts execution.

The normal conversation read projects the budget card and waiting separator. Settings reads period totals and per-member totals, offers Change and Refresh, and uses request generation/feed fences. Commands use the existing drain-aware owner store, feed admission and single-send UI behavior. Portable backup replays the new aggregate and Work transitions rather than granting restored runs authority.

Implementation scope: monthly accounting/admission and decisions; normal runtime and owner transport; existing conversation/settings surfaces and copy; three fixtures and six artboard/app pairs under docs/acceptance/e8. No invented prices, payment/external-device workflows, new dependencies, provider calls, deployment or merge. Related tests plus typecheck run locally; full tests and all contracts belong to CI.

## Review correction before the next push

Count pending/crashed conversation turns by their pinned output cap, retaining unknown reservations after restart. Prepare every waiting Work's pause before committing the owner's acceptance, and treat a completed/released reservation as a fence against a late pause. Fresh owner steering remains admissible, but steering an already budget-paused Work is rejected without changing its pinned inputs. Resume each explicitly authorized Work independently and surface any original unsettled error after processing the remaining Works.

Outstanding proposals derive a current increase from the shared limit without rewriting historical journal commands. Even before the owner configures a limit, a runtime admission records its existing output cap in the budget aggregate. First configuration therefore contends with those reservations through the same CAS boundary; it cannot overlook an activation still in flight. A null limit records that no owner monthly limit exists and does not create a permission or price. The first owner configuration pins the accounting timezone. The browser inbox accepts budget-waiting alongside the server projection.

The GLM follow-up moves authorized resume onto a tracked background path: the owner receives the committed decision immediately, host drain waits for the task, and startup/first-read reconciliation visits released reservations under done decisions. It only attempts a fresh unchanged budget-paused Work; any admitted runtime or effect keeps its original no-replay boundary. The runtime and CAS still own activation. Unknown run errors remain observable while later authorized Works are processed.

Browser keys are not consumed while offline. The protocol distinguishes failures before command transport from lost responses after transport; only a proven unsent command or an explicit server rejection releases a key. An unchanged revision alone cannot prove rollback of an in-flight request. Unknown outcomes retain their marker and show a checking state instead of silently enabling a duplicate send.

## Interrupted queued recovery (GLM round 2)

An accepted decision also remains eligible when its exact pristine Work is already queued. Recovery uses the same deterministic monthly run identity and checks original inputs, pending acceptance and absence of all runtime/effect evidence. A reserved entry whose decision link was replaced during re-admission is recognized by that run identity. Before releasing any stale reservation, a CAS Work transition fences an older activation; cleanup is bound to the original Work revision so a losing attempt cannot free a newer reservation. Reservation operation identities include that revision to allow a fresh metadata admission without changing the provider run identity. Admitted or unknown runtime/effect evidence never becomes replay permission.

## Invariant reconciler redesign

One pure `reconcileMonthly(snapshot)` classifies every reservation from authoritative Mission/Work snapshots, the decision, recorded usage and its original feed/selection. A single service executor applies those plans with CAS and refreshes facts after each committed change. Startup, conversation/usage reads, owner decision completion and owned runtime completion/failure enter that executor. The old pause/release/resume cleanup paths are removed.

Pristine queued reservations are fenced and released; a done decision can prepare and execute its unchanged Work using its stored run ID and executor/verifier choice. Runtime/effect evidence is held intact; only known terminal recorded usage settles it. Foreign-feed grants remain inert. Missing legacy selection never silently becomes a new default selection. Readiness controls dispatch, not accounting cleanup. Reservation and activation use the same Work revision, and metadata recovery cannot rebase a stale owner admission.

New records retain the exact execution choice, original input hash, Work revision, run ID and source feed. Legacy journal transitions keep their recorded semantics. Commit-boundary fault tests cover before/after throws and simulated crashes, then reconcile to assert no stale fresh allocation or done-decision wait, no selection substitution and no duplicate provider call. The sequence identity regression must reject before reserving a different Work under an already-used run operation.

## Live admission observation during reconciliation

The host supplies admission activity as a callback. Snapshot construction samples it after loading the budget and Work facts, and every reconciler refresh samples it again. A run beginning outside recovery during an earlier reservation's cleanup therefore keeps its fresh claim until activation, rather than being mistaken for an abandoned claim. The pure planner still receives a captured boolean; live host state is read only at the snapshot boundary.

## Admission-owned runtime cleanup

A runtime completion or failed admission invokes the same reconciler scoped to its own Mission, Work, run ID and reservation revision. It has no authority to fence another instance's fresh claim. Host-wide startup/read recovery remains unscoped and supplies the live-admission observer. Both entry points use the same pure reservation policy; scope only limits which plans a caller executes.
