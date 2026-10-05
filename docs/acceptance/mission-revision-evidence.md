# Local increment: owner Mission purpose and acceptance revision

Recorded before implementation, base5835cfac4ac6e1948917cd043696278d34f8229b. Publication remains blocked awaiting public-repository authorization; explicit-memory worktree/evidence are preserved.

MIS-01 in docs/product/requirements.md preserves versioned purpose and acceptance; accepted ADR0001 requires product-owned commands with revision/idempotency and historical bindings. Domain revise-mission exists, but ProductService and normal HTTP expose no owner revision path.

Implement POST /missions/:id/revision accepting only commandId, expectedRevision, purpose and criteria(version/description/oracle). Trusted local-owner dispatches existing domain command. Scope, constraints, memories, Work history and runtime authority are unchanged. Existing Work retains original Mission snapshot, criteria and attempts; future Work receives revised purpose/criteria.

Acceptance: owner v1 creation -> old Work -> revision v2 -> new Work; old data unchanged and future inputs v2. Criteria must advance; malformed/extra authority/scope/criteria fields rejected without journal mutation. CAS conflict, exact replay and feed identity preserve existing outcomes; fresh actual SurrealDB-backed HTTP host reconstructs same state. No runtime calls/effects/Records admitted by revision. Strict types/runtime and affected actual store/HTTP tests.

Exclude new UI/general lifecycle, scope or constraint editing, automatic re-evaluation, memory extensions, live calls, external posting, new accounts/permissions/resources, merge/deploy. This local increment does not complete MIS-01.

## Local implementation and evidence

`ProductService.reviseMission` now dispatches the existing owner-only domain transition. Normal HTTP exposes the exact bounded revision route above, rejecting scope/constraint/actor and extra criteria fields. No UI/permission/runtime behavior was expanded.

Pinned Node24.19.0 strict TypeScript and runtime syntax checks passed. `tests/mission-revision.test.ts`, `tests/product.test.ts` and `tests/domain.test.ts` passed19/19, fail/skip0, with a fresh owned SurrealDB3.3.0 launcher on loopback18661. The actual-store revision route preserves old Work byte-for-byte, binds future Work/first attempt to v2, rejects malformed inputs without journal mutations, preserves feed/CAS/exact replay and reconstructs identical state through a fresh HTTP host. No runtime/effects/Records are started by revision. This is headless local behavior, not GUI, real provider or production lifecycle evidence. Tests stopped all owned processes; original explicit-memory worktree remains clean at5835cfac.

Actual command: `MASSION_SURREAL_BINARY=<pinned-surreal> python3 scripts/with-surreal.py --port18661 -- <pinned-node> --test --test-concurrency=1 tests/mission-revision.test.ts tests/product.test.ts tests/domain.test.ts`. Full raw log and separate pre-implementation scope are preserved under `task-11/mission-revision-5835cfa`. No completed explicit-memory test suite was rerun. No remote publication/CI/independent review for this local increment; public-repository authorization remains pending.

## Local UI completion above358185f6

The workbench now connects the existing owner revision route. Current Mission purpose/criteria and the draft's original revision are shown together. Edited drafts remain Mission-scoped and keep their original CAS revision across refresh; a losing owner draft needs deliberate “Keep draft against current revision” before resubmission. “Discard revision draft” resets edits without a command. The form preserves established unknown-write/receipt barriers and original/moved focus. Each Work's evidence displays its original Mission version/purpose/scope/constraints separately from pinned criteria; current Mission input is never substituted for absent historical input.

`tests/mission-revision-panel.test.ts` executes the actual inline client with a small supporting DOM double against real HTTP, including a fresh actual SurrealDB path. It covers original/future bindings, literal owner text, fresh-client reconstruction, stale drafts after authoritative refresh/conflict/rebase, Mission isolation with late old GET, invalid input and discard, pending repeat/discard/navigation suppression, lost acknowledged versus injected unresolved outcomes, disabled descendant focus and original/moved focus, and Work cancellation preserving original input/criteria. DOM doubles establish client transitions, not browser layout, keyboard or screen-reader conformance.

Final affected source validation passed109/109, fail/skip0, pinned Node24.19.0/SurrealDB3.3.0 on owned loopback18671. Tests were `mission-revision-panel`, `mission-revision`, `product`, `domain`, `workbench`, `client-workbench`, and `impact-panel`; strict TypeScript, runtime syntax and diff whitespace checks passed. This count is one final run, not summed historical counts. Earlier UI regex failures (JSON PRE line breaks) and restricted-invocation file failures are preserved alongside corrected/loopback-enabled results under `task-11/mission-revision-panel-358185f`. No completed explicit-memory suite was rerun. Owned test servers/database are stopped.

Actual revision GUI remains pending: shared GUI belongs to Youngcha, and no browser/input session was started. Exact local independent review is still required; source inspection by the implementer is not independent assurance. Remote publication/CI also remain blocked awaiting the previously requested public-repository authorization. Memory5835cfac and API358185f6 remain clean in their original worktrees; no live provider calls, permissions, resources, merge or deployment. The unrelated retirement proposal is parked without source changes.
