# Phase 30 History Reconciliation Implementation Plan

> **에이전트형 작업자(agentic workers):** 각 복구 조각(slice)을 구현할 때 필수 하위 스킬(required sub-skill)로 `subagent-driven-development` 또는 `executing-plans`를 사용합니다.

**Goal:** Phase 30의 안전 스냅샷과 깨끗하게 검증된 기준선을 바탕으로 후보 변경을 원자적인 복구 조각으로 재구성하고, 각 변경의 구현·검증·문서 근거를 커밋 단위로 일치시킵니다.

**Architecture:** 불변 안전 스냅샷(immutable safety snapshot)은 원본 증거로 보존하고, 별도의 정합성 복구 브랜치에서 소유 파일 또는 소유 변경 조각(hunk)만 순서대로 복원합니다. 공용 파일(shared file)은 통째로 스테이징하지 않으며, 각 조각은 코드 커밋 뒤 실제 커밋 SHA를 기록하는 문서 커밋으로 닫습니다.

**Tech Stack:** Git 참조(ref)·트리(tree), pnpm 동결 설치(frozen install), TypeScript, Vitest, Playwright, OpenTUI, tmux, Markdown 문서 검증(document verification)

**정본 원장(source of truth):** [정합성 복구 원장(reconciliation manifest)](./reconciliation-manifest.json)은 안전 스냅샷의 완전 경로 배정, 공용 변경 조각(hunk) 소유자와 anchor, 조각별 정확한 검증 명령의 정본입니다. 이 계획은 복구 의도와 순서를 설명하며, 경로 목록·anchor·명령은 원장을 우선합니다.

---

## 1. 기준점과 불변 안전 스냅샷

- 복구 기준 HEAD(base HEAD): `65922bd706580a0962b6eda81c6fa3d63b36b6a8`
- 안전 참조(safety ref): `refs/massion-safety/phase-30-pre-reconcile-20260717-65922bd`
- 안전 커밋(safety commit): `9b049f72a96457c46139811f86d36589f073df64`
- 안전 트리(safety tree): `22e98dcfe1c689ded1b9b7d6d9caaec328ebddb9`
- 원본 오염 작업 경로(original dirty worktree): `/Volumes/Crucial P3 PLUS/workspace.backup-20260502/massion/.worktrees/phase-30-parity-ux`
- 정합성 복구 경로(reconciled worktree): `/Volumes/Crucial P3 PLUS/workspace.backup-20260502/massion/.worktrees/phase-30-reconciled`
- 정합성 복구 브랜치(reconciled branch): `feat/phase-30-reconciled`
- 의존성은 `pnpm install --frozen-lockfile` 동결 설치(frozen install)로 고정했습니다.
- 깨끗한 기준선(clean base)에서 전체 `pnpm verify`를 실행했고 종료 코드(exit code)는 `0`이었습니다.

안전 참조는 변경 출처를 확인하는 읽기 전용 원본입니다. 복구 브랜치가 전체 게이트와 깨끗한 복제본(clean clone) 릴리스 검증을 모두 통과할 때까지 삭제하거나 이동하지 않습니다.

## 2. 복구 상태 정의

- **1 — 커밋 완료·최신 검증(committed + freshly verified):** 독립 코드 커밋이 있고 현재 후보에서 요구 검증을 다시 통과했으며, 문서가 실제 커밋 SHA를 가리킵니다. 체크박스는 이 상태에만 사용합니다.
- **2 — 후보 구현·재검증 필요(candidate implemented / reverify):** 안전 스냅샷에 구현 후보가 있으나 정합성 복구 브랜치의 독립 커밋과 최신 검증 근거가 아직 없습니다.
- **3 — 부분 구현(partial):** 일부 계층 또는 호출 경로만 구현되어 계약 전체를 만족하지 않습니다.
- **4 — 미구현(not implemented):** 요구 계약을 충족하는 구현 근거가 없습니다.
- **5 — 대체됨(superseded):** 더 정확한 구현이나 근거가 기존 후보를 대체했으므로 이전 변경을 복원하지 않습니다.

상태는 추측으로 올리지 않습니다. 코드 커밋, 현재 후보에서 실행한 검증 결과, 실제 SHA를 기록한 문서 커밋이 모두 있어야 상태 1로 전환합니다.

## 3. 순서화된 복구 원장

실행 순서 식별자는 1, 2, 3, 4, 5, 6, 7, 8A, 8B, 9, 10, 11, 12, 13, 14, 15의 16개입니다. 8A와 8B는 기존의 과대한 8번 조각을 승인 CAS와 Application HTTP·Web session 계약으로 분리한 것입니다.

### 1) SurrealDB 릴리스 기반

- **상태:** 2 — 후보 구현·재검증 필요
- **경계:** 아래 8개 파일만 이 조각의 소유 범위로 복원합니다.
  - `.github/workflows/release.yml`
  - `compose.yaml`
  - `deploy/kubernetes/base/surreal-statefulset.yaml`
  - `deploy/surreal/Dockerfile`
  - `scripts/build-release.mjs`
  - `scripts/release-workflow.test.mjs`
  - `packages/application/src/artifacts.ts`
  - `packages/extension-host/src/compliance.ts`
- **최소 검증:** 릴리스 워크플로 테스트(release workflow test), 관련 패키지 테스트, 형식 검사(format), 타입 검사(typecheck), 빌드(build)를 실행하고 컨테이너·Kubernetes 설정의 SurrealDB 버전과 릴리스 산출물 계약을 대조합니다.
- **문서 조치:** 코드 커밋 뒤 릴리스 증거와 실제 SHA를 체크리스트(checklist)와 추적성 표(traceability matrix)에 기록합니다.

### 2) 기반 계약 프리미티브

- **상태:** 2 — 후보 구현·재검증 필요
- **경계:** 기능 능력 계약(capability contract), 쿼리 리소스(query resource), 쿼리 무효화(query invalidation), 리소스 상태(resource status) 프리미티브와 단위 테스트만 복원합니다. 개인 능력 카탈로그(personal capability catalog)는 제외하며 `packages/foundation/src/personal-core-capabilities.ts`를 포함하지 않습니다. `packages/foundation/src/index.ts`, `packages/foundation/package.json`, `pnpm-lock.yaml`은 소유 변경 조각만 적용합니다.
- **최소 검증:** foundation 단위 테스트, 공개 내보내기(export) 타입 검사, 소비 패키지 타입 검사와 빌드를 실행합니다.
- **문서 조치:** 각 프리미티브의 계약, 소비자, 테스트 명령, 코드 커밋 SHA를 근거 문서에 추가합니다.

### 3) CLI 프레임워크

- **상태:** 2 — 후보 구현·재검증 필요
- **경계:** 명령 구문 분석(command parsing), 명령 디스패치(command dispatch), 출력·오류 계약과 공통 CLI 서비스 연결만 복원합니다. 범용 공급자 인증(generic provider authentication)과 로그인 온보딩(login onboarding)은 제외합니다. `apps/cli/src/parser.ts`, `apps/cli/src/commands.ts`, `apps/cli/src/execution.ts`는 소유 변경 조각만 적용합니다.
- **최소 검증:** CLI 파서·명령·실행 단위 테스트, CLI 타입 검사, 빌드, 대표 도움말(help) 스냅샷을 실행합니다.
- **문서 조치:** 지원 명령과 제외된 인증 경계를 명시하고 실제 코드 커밋 SHA를 기록합니다.

### 4) 모델 최적화

- **상태:** 2 — 후보 구현·재검증 필요
- **경계:** 모델 최적화(model optimization)의 도메인 계약, 애플리케이션 서비스, 저장·조회 경로, 서버 노출 계약만 복원합니다. TUI 단축키(keymap)와 Web 화면 연결은 각 표면(surface) 조각으로 미룹니다.
- **최소 검증:** 모델 최적화 단위·통합 테스트, 관련 패키지 타입 검사와 빌드, 서버 계약 테스트를 실행합니다.
- **문서 조치:** API·저장소·최적화 결과의 추적 경로와 코드 커밋 SHA를 추가합니다.

### 5) 성장 기능

- **상태:** 2 — 후보 구현·재검증 필요
- **경계:** 성장 기능(Growth)의 도메인 모델, 애플리케이션 유스케이스(use case), 서버 계약과 저장 경로만 복원합니다. 다른 기능의 공용 레지스트리(registry)는 소유 변경 조각으로만 수정합니다.
- **최소 검증:** Growth 단위·통합 테스트, 관련 타입 검사, 빌드와 서버 계약 테스트를 실행합니다.
- **문서 조치:** 요구 사항별 테스트와 실제 코드 커밋 SHA를 추적성 표에 연결합니다.

### 6) 런타임 메모리와 아웃박스

- **상태:** 2 — 후보 구현·재검증 필요
- **경계:** 런타임 메모리(runtime memory), 이벤트 아웃박스(outbox), 실행 상태의 저장·재생 계약만 복원합니다. `packages/runtime/src/execution-store.ts`, `packages/runtime/src/schema.ts`, `packages/runtime/src/voltagent-runner.ts`, `packages/runtime/src/embedded-agent-runtime.ts`는 소유 변경 조각만 적용합니다.
- **최소 검증:** 런타임 메모리·아웃박스 단위 및 통합 테스트, 스키마 호환성 검사, 런타임 타입 검사와 빌드를 실행합니다.
- **문서 조치:** 지속성(persistence), 재시도(retry), 중복 방지(idempotency) 근거와 실제 코드 커밋 SHA를 기록합니다.

### 7) 협업과 위임

- **상태:** 2 — 후보 구현·재검증 필요
- **경계:** 협업(collaboration)·위임(delegation) 계약, 작업자 상태 전이, 애플리케이션 오케스트레이션만 복원합니다. CLI·TUI·Web 표면 연결은 해당 조각에서 처리합니다.
- **최소 검증:** 협업·위임 단위 및 통합 테스트, 상태 전이 테스트, 관련 타입 검사와 빌드를 실행합니다.
- **문서 조치:** 위임 흐름, 실패·취소 경계, 테스트 결과와 코드 커밋 SHA를 연결합니다.

### 8A) 승인 revision CAS와 Integration 전달

- **상태:** 3 — 부분 구현
- **경계:** 승인(approval)의 revision 기반 비교·교환(compare-and-swap), 취소 사유(reason), Integration command envelope 전달을 복원합니다. `packages/governance`, `packages/integrations`, `packages/assurance`, `packages/organization`과 `packages/work`의 승인 변경 조각만 적용합니다. `packages/application/src/adapters/domain.ts`, `packages/application/src/adapters/read-model.ts`, `packages/application/src/query-registry.ts`, `packages/application/src/read-model.ts`, `packages/application/src/snapshot.ts`, `packages/application/src/remote.contract.test.ts`, `packages/work/src/work.ts`은 파일 전체가 아니라 원장이 지정한 변경 조각만 적용합니다.
- **최소 검증:** governance·integrations·assurance·organization·work·extension-host·application의 단위·통합 계약 테스트, 타입 검사(typecheck), 빌드를 통과한 뒤 다음 조각으로 진행합니다.
- **문서 조치:** approval CAS와 external Integration 전달의 코드 SHA, 동시 수정 충돌 테스트, 검증 결과를 분리해 기록합니다.

### 8B) Application HTTP·Web session·event 보강

- **상태:** 2 — 후보 구현·재검증 필요
- **경계:** Application HTTP API, Web session, command event 공개 payload의 독립 계약을 복원합니다. `packages/application/src/event-store.ts`, `http-client.ts`, `http-server.ts`, `http-web.test.ts`, `product.test.ts`, `web-session.ts`와 각 테스트가 이 조각의 고유 경로입니다. `packages/application/src/event-projector.ts`, `query-registry.ts`는 원장의 소유 변경 조각만 적용합니다.
- **최소 검증:** Application HTTP·Web session·event 단위 테스트, Application 전체 테스트, 타입 검사와 빌드, Server 타입 검사와 빌드를 실행합니다.
- **문서 조치:** HTTP envelope, session binding, event 공개 범위의 코드 SHA와 검증 결과를 별도 근거로 기록합니다.

### 9) Router/Hermes 공급자 백엔드

- **상태:** 2 — 후보 구현·재검증 필요
- **경계:** Router/Hermes 공급자(provider) 카탈로그, 백엔드 인증 계약, 서버 API와 영속화만 복원합니다. 범용 공급자 CLI 연결과 사용자 승인 흐름은 제외합니다.
- **최소 검증:** Router/Hermes 공급자 단위·통합 테스트, 서버 계약 테스트, 타입 검사와 빌드를 실행합니다.
- **문서 조치:** 지원 공급자, 백엔드 인증 경계, 비밀 정보(secret) 처리 검증과 코드 커밋 SHA를 기록합니다.

### 10) 범용 공급자 CLI 연결

- **상태:** 3 — 부분 구현
- **경계:** 파서와 명령 후보만으로 완료로 판단하지 않습니다. 현재 실행 경로(execution path)가 여전히 `resolveProviderLoginOnboarding`을 호출하므로, 범용 공급자 선택·인증·로그아웃과 실제 실행 연결이 모두 닫힐 때까지 부분 구현입니다.
- **최소 검증:** 공급자별 CLI 단위·통합 테스트, 기존 로그인 회귀 테스트, 비대화형(non-interactive) 실패 계약, 최종 공급자 사용자 인수 테스트(UAT)를 실행합니다.
- **문서 조치:** 기존 전용 온보딩 호출이 제거되거나 의도적으로 격리된 코드 근거와 실제 SHA를 기록하고, UAT 전에는 완료 표기를 하지 않습니다.

### 11) TUI 표면

- **상태:** 3 — 부분 구현
- **경계:** OpenTUI 화면, 컨트롤러(controller), 카탈로그와 명령 연결을 기능별로 복원합니다. 현재 최적화 단축키 맵(optimization keymap)이 비어 있고 백업·복원(backup/restore)이 카탈로그에 없으므로 기능 동등화(surface parity)는 아직 충족되지 않습니다. `apps/tui/src/open-tui.ts`와 `apps/tui/src/controller.ts`는 소유 변경 조각만 적용합니다.
- **최소 검증:** TUI 단위 테스트, OpenTUI 렌더·키 입력 테스트, tmux 실제 조작 검증, 최적화·백업·복원 경로의 사용자 인수 테스트를 실행합니다.
- **문서 조치:** 키·화면·명령별 증거, 캡처 또는 로그, 실제 코드 커밋 SHA를 체크리스트와 추적성 표에 연결합니다.

### 12) Web 표면

- **상태:** 2 — 후보 구현·재검증 필요
- **경계:** Web 상태 저장소(store), API 어댑터(adapter), 화면과 사용자 상호작용을 기능별로 복원합니다. `apps/web/src/store.ts`와 `apps/web/src/api.ts`는 소유 변경 조각만 적용합니다.
- **최소 검증:** Web 단위·통합 테스트, 타입 검사, 프로덕션 빌드, Playwright 핵심 사용자 흐름과 시각적 확인을 실행합니다.
- **문서 조치:** 사용자 흐름별 Playwright 근거와 실제 코드 커밋 SHA를 기록합니다.

### 13) 기능 능력 게이트

- **상태:** 3 — 부분 구현
- **경계:** 기능 능력 게이트(capability gate)의 현재 RED 두 건을 먼저 정확히 유지하고 원인별로 수정합니다. 알려진 실패는 런타임 메모리 레지스트리 픽스처(runtime-memory registry fixture) 누락과 오래된 `problems.length > 0` 단언(assertion)입니다.
- **최소 검증:** 두 실패를 각각 재현하는 표적 테스트를 먼저 실행하고, 수정 뒤 기능 능력 계약 테스트와 관련 전체 테스트를 다시 실행합니다.
- **문서 조치:** RED 재현 출력, 수정 커밋 SHA, GREEN 재검증 결과를 기록하며 실패 중에는 게이트를 통과로 표시하지 않습니다.

### 14) 근거·체크리스트·추적성 정정

- **상태:** 3 — 부분 구현
- **경계:** 설계, 구현 계획, 체크리스트, 리뷰 증거, 추적성 표의 주장을 실제 코드·테스트·커밋 상태와 맞춥니다. 현재 후보와 일치하지 않는 완료 주장은 대체됨(superseded)으로 남기고 삭제로 은폐하지 않습니다.
- **최소 검증:** 문서 검증, 링크 검사, 파일·테스트·SHA 존재 여부 대조와 코드 diff 교차 검토를 실행합니다.
- **문서 조치:** 각 코드 조각의 후속 문서 커밋에서 실제 SHA와 검증 명령·결과를 기록하고, 자체 문서 커밋 SHA를 선행 코드 근거로 오인하지 않도록 구분합니다.

### 15) 전체 게이트와 사용자 인수 검증

- **상태:** 4 — 미구현
- **경계:** 모든 코드 조각이 닫힌 뒤 전체 게이트(full gates), 깨끗한 복제본(clean clone), Playwright, OpenTUI, tmux, 백업, 복원, 공급자 사용자 인수 테스트(provider UAT)를 하나의 릴리스 후보에서 수행합니다.
- **최소 검증:** 동결 설치 후 전체 `pnpm verify`, 프로덕션 빌드와 릴리스 검사, 깨끗한 복제본의 동일 검증, Playwright 브라우저 흐름, OpenTUI·tmux 흐름, 실제 백업·복원 왕복(round trip), Router/Hermes를 포함한 공급자 UAT를 모두 실행합니다.
- **문서 조치:** 명령, 환경, 종료 코드, 산출물, 사용자 흐름별 증거와 최종 후보 SHA를 릴리스 근거에 고정합니다.

## 4. 공용 파일 스테이징 금지 목록

다음 파일은 여러 복구 조각이 공유하므로 절대로 파일 전체를 일괄 스테이징하지 않습니다. 각 조각이 소유한 변경 조각만 검토하고 선택적으로 적용·스테이징합니다.

- `apps/server/src/product.ts`
- `packages/foundation/src/index.ts`
- `packages/foundation/package.json`
- `packages/application/src/adapters/domain.ts`
- `packages/application/src/query-registry.ts`
- `packages/application/src/product.ts`
- `packages/runtime/src/index.ts`
- `packages/runtime/src/execution-store.ts`
- `packages/runtime/src/schema.ts`
- `packages/runtime/src/voltagent-runner.ts`
- `packages/runtime/src/embedded-agent-runtime.ts`
- `packages/work/src/work.ts`
- `apps/cli/src/execution.ts`
- `apps/cli/src/commands.ts`
- `apps/cli/src/parser.ts`
- `apps/tui/src/open-tui.ts`
- `apps/tui/src/controller.ts`
- `apps/web/src/store.ts`
- `apps/web/src/api.ts`
- `pnpm-lock.yaml`

## 5. `pnpm-lock.yaml` 처리 원칙

`pnpm-lock.yaml`의 primary 소유자는 2번 조각 하나이며, 3·5·11·12번은 [정합성 복구 원장](./reconciliation-manifest.json)이 지정한 공용 변경 조각만 소유합니다. 안전 커밋의 최종 `pnpm-lock.yaml`을 통째로 복원하면 안 됩니다. 이 파일은 미래 조각의 manifest까지 한꺼번에 포함합니다.

manifest를 변경하는 각 조각에서는 반드시 다음 순서로 해당 시점 manifest가 요구하는 폐쇄 의존성(closed dependency set)만 재생성합니다. 안전 커밋의 최종 lockfile 전체를 복사하지 않습니다.

```bash
pnpm install --lockfile-only
git diff -- pnpm-lock.yaml
pnpm install --frozen-lockfile
```

아직 적용하지 않은 importer가 lockfile에 나타나면 그 조각은 범위 오염입니다. 정확한 owner·anchor·명령은 원장을 기준으로 검증합니다.

## 6. 복구 조각별 실행 절차

1. 안전 커밋 `9b049f72a96457c46139811f86d36589f073df64`에서 현재 조각이 소유한 파일 또는 변경 조각만 복원합니다.
2. 저장소의 포맷터(formatter)를 적용하고 포맷 차이를 검토합니다.
3. 현재 조각의 표적 테스트(targeted tests)를 실행해 실패와 성공 결과를 보존합니다.
4. 영향받는 패키지의 타입 검사(typecheck)와 빌드(build)를 실행합니다.
5. 기준 HEAD, 안전 커밋, 현재 작업 트리 사이의 diff를 검토해 범위 밖 변경과 공용 파일의 혼입을 제거합니다.
6. 검증된 코드만 독립 코드 커밋으로 만들고 커밋 SHA를 확정합니다.
7. 체크리스트와 추적성 표에 실제 코드 SHA와 검증 결과를 기록하는 후속 문서 커밋을 만듭니다.
8. 독립 명세 리뷰(specification review)를 먼저 받고, 그다음 독립 품질 리뷰(quality review)를 받습니다. Important 또는 Critical 등급 문제가 하나라도 있으면 다음 조각으로 진행하지 않고 멈춥니다.

## 7. 최종 회계와 안전 참조 보존

최종 후보는 안전 커밋 `9b049f72a96457c46139811f86d36589f073df64`과 안전 트리 `22e98dcfe1c689ded1b9b7d6d9caaec328ebddb9`를 기준으로 경로별 회계(accounting)를 수행합니다. 안전 스냅샷과 최종 후보 사이의 모든 차이는 의도적이며, 테스트되었고, 문서화되었음을 코드 커밋과 후속 문서 커밋으로 증명해야 합니다.

`refs/massion-safety/phase-30-pre-reconcile-20260717-65922bd`는 깨끗한 복제본 릴리스 검증까지 보존합니다. 전체 검증과 릴리스 검증이 끝나기 전에는 참조 삭제, 강제 이동, 원본 오염 작업 트리 정리를 수행하지 않습니다.
