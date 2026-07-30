# ADR-003 — Task-Aware Model Placement

[English](ADR-003-task-aware-model-placement.md) | [한국어](ADR-003-task-aware-model-placement.ko.md)

> **Status:** Accepted
> **Decision date:** 2026-07-28
> **Scope:** Strategy, model evaluation, Router, and execution lineage

## Context

A stable role key alone cannot distinguish lightweight summarization from difficult design or review. Encoding task difficulty into role keys would multiply role identity and break bundle lineage, while storing per-task tiers in an active batch would make a stable recommendation own volatile request state.

Model placement also requires end-to-end evidence of which model handled which execution and Assurance result. Selection policy without this lineage cannot learn safely.

## Decision

### 1. Keep role identity stable

An active role batch supplies an allowed candidate set and ordered preference. Task signals select within that set. Sparse task categories fall back to the role baseline instead of creating a permanent active pointer for every role-task combination.

### 2. Produce task signals during strategy

Strategy has goal, scope, constraints, assumptions, unknowns, decisions, evidence, and assignee context. It classifies the reasoning requirement before that context is reduced to a delivery task.

Task difficulty is independent from Governance risk. Similar words such as low, medium, and high do not make them the same field.

### 3. Define evidence authority

Model evidence has three levels.

- **T0 bundled estimates:** expiring cold-start priors, never the source of truth.
- **T1 local benchmarks:** controlled measurements for models the user has connected, with visible call count, maximum cost, Provider, and data scope.
- **T2 real Work observations:** Assurance-linked evidence used conservatively for demotion and recovery before it is allowed to improve rank.

Benchmark licenses, versions, configuration, and contamination risk remain attached to receipts. Shadow comparison requires explicit user enablement and a separate budget.

### 4. Establish lineage before optimization

The execution chain must connect Assurance executor, Runtime execution, route attempt, and actual model profile. Selection emits `model.route.selected` before external side effects and records the actual profile, batch, preference influence, credential, and usage.

## Consequences

- Role bundle checksums and role identity remain stable.
- Users declare Provider supply and policy; they do not choose a model for every request.
- The Router retains ownership of credential rotation, quota, circuit state, and fallback.
- Task observations are computed from actual execution and Assurance lineage rather than caller claims.
- Missing task evidence falls back to the role baseline.

## Rejected alternatives

- **Role × difficulty keys:** identity and checksum explosion.
- **Difficulty tiers inside an active batch:** volatile Work state corrupts stable recommendation lineage.
- **Classify immediately before execution:** the reduced task no longer contains enough strategy evidence.
- **Trust external leaderboards as runtime truth:** environment and task mismatch cannot establish local behavior.
