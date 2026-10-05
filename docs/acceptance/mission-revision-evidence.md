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
