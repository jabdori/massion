# Model Optimization Lab Implementation Plan

> **For agentic workers:** Execute each task with the test-driven-development workflow and keep the Phase 25 implementation plan and evidence current.

**Goal:** Build a local-first model evaluation lab that evaluates only user-connected models, produces deterministic role-specific recommendations with fallbacks, and safely applies or rolls back model batches.

**Architecture:** A new `@massion/model-optimization` domain package owns immutable evaluation bundles, receipts, recommendations, policies, and batch lineage. It reads model profiles through a narrow `ModelOptimizationModelCatalog` port and never calls a provider directly. The application and server expose the domain through command/query adapters; the existing router remains responsible for per-request credential, quota, circuit, and fallback selection.

**Tech Stack:** TypeScript, Vitest, SurrealDB migrations through `@massion/storage`, existing `@massion/identity`, `@massion/router`, `@massion/governance`, `@massion/runtime`, CLI/Web operation registries.

---

### Task 1: Domain package and immutable evaluation contracts

**Files:**
- Create: `packages/model-optimization/package.json`
- Create: `packages/model-optimization/tsconfig.json`
- Create: `packages/model-optimization/src/contracts.ts`
- Create: `packages/model-optimization/src/scoring.ts`
- Create: `packages/model-optimization/src/schema.ts`
- Create: `packages/model-optimization/src/index.ts`
- Test: `packages/model-optimization/src/scoring.test.ts`

- [ ] Define the eight Core Office roles and eight software-engineering roles as stable role keys, and reject unknown roles.
- [ ] Define evaluation policies `quality`, `value`, `speed`, `privacy`, and `manual`, with explicit hard-gate requirements.
- [ ] Define candidate, case, receipt, recommendation, batch, observation, and recovery contracts with bounded strings and finite numeric values.
- [ ] Add append-only migrations for evaluation bundles, cases, runs, receipts, recommendations, policy versions, batches, observations, and recovery events.
- [ ] Write failing scoring tests for hard-gate exclusion, deterministic tie breaking, each policy, fallback ordering, and privacy restrictions.

### Task 2: Evaluation execution and receipt persistence

**Files:**
- Create: `packages/model-optimization/src/evaluation.ts`
- Create: `packages/model-optimization/src/ports.ts`
- Create: `packages/model-optimization/src/evaluation.test.ts`
- Modify: `packages/model-optimization/src/index.ts`

- [ ] Add an evaluator port that receives fixed prompt/tool/environment checksums and returns latency, token, cost, quality, and privacy facts without provider-specific imports.
- [ ] Persist immutable run and receipt records with an input checksum that covers bundle, model profile, runtime version, and execution facts.
- [ ] Reject duplicate or mismatched command IDs and reject receipts whose candidate or role does not match the run.
- [ ] Ensure a shadow evaluation cannot invoke write, message, deployment, approval, or organization mutation capabilities.
- [ ] Add tests for deterministic receipts, checksum mismatch, duplicate command replay, and shadow side-effect denial.

### Task 3: Recommendation policy and batch lifecycle

**Files:**
- Create: `packages/model-optimization/src/recommendation.ts`
- Create: `packages/model-optimization/src/batch.ts`
- Create: `packages/model-optimization/src/recommendation.test.ts`
- Create: `packages/model-optimization/src/batch.test.ts`

- [ ] Generate a primary model and ordered fallback list only from eligible verified profiles and completed receipts.
- [ ] Require a first recommendation approval unless the organization explicitly enables automatic optimization.
- [ ] Enforce minimum sample count and improvement threshold before shadow, limited, or active promotion.
- [ ] Use immutable batch versions with an atomic active pointer and reject updates to an in-flight execution's batch.
- [ ] Record automatic recovery to the previous healthy batch after degraded observations.

### Task 4: Application and server integration

**Files:**
- Modify: `packages/application/package.json`
- Modify: `packages/application/src/index.ts`
- Create: `packages/application/src/model-optimization-operations.ts`
- Modify: `apps/server/src/product.ts`
- Modify: `apps/server/src/command-registry.ts`
- Modify: `apps/server/src/query-registry.ts`
- Test: `apps/server/src/model-optimization-product.test.ts`

- [ ] Construct the optimization service during local/server bootstrap using the existing database, organization, router model catalog, governance, and runtime ports.
- [ ] Expose evaluate, recommend, policy configure, approve/apply, observe, recover, and read operations with tenant checks and redacted views.
- [ ] Keep router fallback and quota decisions at request time; optimization only updates an immutable role-to-route batch.
- [ ] Add product tests for approval mode, automatic mode, batch activation, and recovery.

### Task 5: CLI, TUI, Web, documentation, and evidence

**Files:**
- Modify: `apps/cli/src/**` operation registration and help
- Modify: `apps/tui/src/**` model optimization view
- Modify: `apps/web/src/**` model optimization page/query
- Modify: `docs/phases/25-model-optimization-lab/implementation-plan.md`
- Create: `docs/evidence/phase-25/model-optimization-2026-07-13.md`
- Modify: `docs/generated/requirements-traceability.tsv`
- Modify: `docs/architecture/README.md`

- [ ] Provide the same redacted operations in CLI, TUI, and Web, including policy choice and approval/automatic choice.
- [ ] Document that unconnected free/public models are never implicitly used and that production learning/shadow are disabled by default.
- [ ] Record test, security, install, release, and tmux evidence; explicitly separate external provider scenarios that could not be run.
- [ ] Mark Phase 25 tasks completed only from fresh command output.

### Task 6: Full verification and release

- [ ] Run focused RED/GREEN tests after every implementation slice.
- [ ] Run `pnpm verify`, `pnpm verify:security`, `pnpm verify:hardening`, `pnpm release:build`, and `pnpm verify:release`.
- [ ] Run tmux release UAT for all available provider credentials and validate the receipt.
- [ ] Commit each coherent slice with a Phase-specific message and leave the worktree clean.

