# Native Local Runtime Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` to implement this plan task-by-task.

**Goal:** 개인용 Massion이 관리하는 SurrealDB 3.2.1 sidecar를 준비하고, 기존 embedded database 경로를 새 설치에 사용하지 않게 합니다.

**Architecture:** 새 runtime manager는 native binary의 위치·무결성·version과 loopback sidecar lifecycle만 맡습니다. application server는 authenticated remote transport로만 연결합니다. 이전 database는 import하거나 migration하지 않습니다.

### Task 1: Runtime layout과 binary 증명

**Files:**
- Create: `apps/cli/src/local-surreal-runtime.ts`
- Create: `apps/cli/src/local-surreal-runtime.test.ts`

- [x] 먼저 실패 테스트로 platform별 binary 위치, SurrealDB 3.2.1 version, SHA-256 검증 계약을 고정합니다.
- [x] `runtime/surrealdb/3.2.1/<platform>/surreal` binary와 `surrealdb/3/database` data 경로를 계산하는 최소 구현을 추가합니다.
- [x] focused test를 실행해 GREEN을 확인합니다.

### Task 2: Loopback sidecar lifecycle

**Files:**
- Modify: `apps/cli/src/local-surreal-runtime.ts`
- Modify: `apps/cli/src/local-surreal-runtime.test.ts`

- [ ] 먼저 실패 테스트로 binary 검증 뒤 `surreal start`가 loopback·인증·새 data 경로로 실행되는 계약을 추가합니다.
- [ ] sidecar start, authenticated readiness, owned process 확인과 stop을 구현합니다.
- [ ] focused test를 실행해 GREEN을 확인합니다.

### Task 3: Local application 연결 전환

**Files:**
- Modify: `apps/cli/src/local.ts`
- Modify: `apps/cli/src/local.test.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/config.test.ts`

- [ ] 먼저 실패 테스트로 application server가 sidecar의 authenticated loopback URL만 받는 계약을 추가합니다.
- [ ] 기존 `rocksdb://./massion.db` 전달을 제거하고, sidecar 준비 뒤 application server를 시작하도록 구현합니다.
- [ ] focused CLI·server tests를 실행해 GREEN을 확인합니다.

### Task 4: 검증과 checkpoint

**Files:**
- Modify: `docs/phases/30-surface-parity-agent-ux/implementation-plan.md`

- [ ] 관련 test, typecheck, lint를 실행합니다.
- [ ] tmux의 깨끗한 HOME에서 runtime 준비와 onboarding 진입을 확인합니다.
- [ ] 실행 결과만 Phase 문서에 짧게 기록하고 하나의 checkpoint commit을 만듭니다.
