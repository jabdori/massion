# 업무 협업 세로 흐름 구현 계획

> **상태:** 진행 중  
> **범위:** 새 업무 하나가 Core Office 협업 기록을 만들고 TUI·Web에서 같은 상태로 보이는 첫 완성 흐름

## 완료 기준

깨끗한 개인용 설치에서 사용자가 TUI 또는 Web으로 업무를 시작하면, Massion은 Work와 기본 협업방, 사용자 요청을 기록합니다. 두 화면은 정상 실시간 사건 뒤 새 Work·협업방·메시지를 새로고침 없이 같은 데이터로 표시합니다. Provider가 연결된 경우에는 Representative의 Context & Strategy handoff도 같은 흐름에서 확인합니다.

## 구현 순서

- [x] **Core Office 협업 연결**
  - `packages/application/src/core-pipeline.ts`에서 새 Work마다 Core Office 기본 협업방을 보장하고, 사용자 요청과 Representative handoff를 idempotent command ID로 기록합니다.
  - `packages/work/src/work.ts`에 Work별 협업방 조회를 추가해 Context & Strategy가 저장된 메시지를 `collaboration` source로 StrategyService에 전달합니다.
  - `packages/application/src/core-pipeline.test.ts`에서 Work·방·두 메시지·Strategy source와 재시도 중복 방지의 실패 테스트를 먼저 추가합니다.

- [x] **실행 상태 조회와 TUI 진입**
  - `packages/application/src/query-registry.ts`와 `packages/application/src/product.ts`에서 공개 `run.get` query를 제공해 `run.start`의 비동기 Work 연결을 안전하게 읽습니다.
  - `apps/tui/src/commands.ts`, `main.ts`, `open-tui.ts`, `controller.ts`에서 새 업무 입력, `run.start` 전송, 관련 정상 사건의 snapshot·chat 재조회가 동작하게 합니다.
  - `apps/tui/src/*test.ts`와 `open-tui.bun.test.ts`에서 command envelope, 키보드 입력, 정상 사건 갱신을 RED→GREEN으로 고정합니다.

- [x] **Web 진입과 실시간 동기화**
  - `apps/web/src/pages/OverviewPage.tsx`에서 새 업무 입력과 run 상태를 제공하고 Work ID가 확인되면 해당 Work로 이동합니다.
  - `apps/web/src/store.ts`, `hooks.ts`, `pages/RoomPage.tsx`에서 Work·Room·Message·Run 사건이 영향을 받는 retained query만 다시 읽도록 합니다.
  - `apps/web/src/store.test.ts`와 페이지 테스트에서 관련 Work만 갱신되고 외부 협업 메시지가 즉시 표시되는지 RED→GREEN으로 확인합니다.

- [x] **Provider 없는 공통 실제 검증**
  - source commit `746c0d5`의 release artifact를 빈 환경에 설치하고 native SurrealDB sidecar, onboarding, TUI·Web 실행을 확인했습니다.
  - Web에서 만든 Work와 두 메시지는 TUI에서 그 Work를 선택한 뒤 `r` 없이 대화 화면을 처음 열었을 때 표시됐습니다. TUI에서 보낸 다음 메시지도 Web에 실시간 반영됐습니다.
  - 모델 경로가 없는 환경은 예상대로 `blocked_model_unavailable`으로 끝났습니다.

- [ ] **Provider 연결 실제 검증**
  - Provider 인증이 필요한 Representative 성공과 Context & Strategy handoff는 사용자 계정 인증 뒤 별도 UAT로 확인합니다.
  - 전체 capability 동등성은 이 세로 흐름과 별도로 남아 있습니다.

## 작업 단위

각 항목은 실패 테스트 → 최소 구현 → 해당 패키지 테스트 → 작은 커밋 순서로 닫습니다. 전체 품질 게이트는 세로 흐름이 연결된 뒤 한 번만 실행합니다.
