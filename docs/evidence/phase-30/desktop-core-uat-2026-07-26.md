# Phase 30 실제 Core UAT — 2026-07-26

> **상태:** 부분 통과. 개인용 공개 릴리스나 최종 v1 완료를 뜻하지 않습니다.

## 후보와 격리 실행

- 후보 커밋: `7708d5f33` (`fix(growth): 위임 실행의 Prompt section 조회 허용`)
- 번들: `Massion Core Fix UAT.app`
- bundle identifier: `dev.massion.desktop.core-fix-uat`
- 데이터: 임시 XDG 디렉터리와 임시 SurrealDB sidecar
- 실행 규칙: 기존 Massion 테스트 앱·고아 sidecar를 먼저 종료하고 이 번들 하나만 실행했습니다. 검증 뒤 Tauri·bridge·server·SurrealDB를 모두 종료했고 포트 `7330`~`7333`에 남은 listener가 없음을 확인했습니다.

## 실제 결과

| 시나리오 | 결과 | 근거 |
| --- | --- | --- |
| UAT-01 bootstrap·탐색 | 통과 | 실제 Tauri 화면에서 홈·업무·조직·개선·확장·설정·수신함 접근 가능 |
| UAT-02 Z.ai 연결 | 통과 | 로컬 Application command `subscription.server.connect-model`가 `providerId=zai-coding-plan`, `status=active`, `connectorStatus=ready` 반환. secret은 출력하지 않음 |
| UAT-03 workspace 없는 Work | 통과 | 실제 GLM Work가 workspace 없이 생성되어 representative·context-strategy·delivery·assurance 실행을 거쳐 `run.status=completed`가 됨 |
| UAT-07 협업·위임 화면 | 통과 | 실제 Work 상세에서 Core Office 참가자 9명, representative handoff, 3개 작업과 실행 계보가 표시됨 |
| UAT-12 완료·Assurance·Records | 통과 | 실행 6개 모두 `succeeded`, 검증 1개, 산출물 4개, `verification_recorded`와 `records_finalized` 활동이 실제 query와 화면에 남음 |
| 재시작·보존 | 통과 | 같은 임시 XDG 데이터로 번들을 재실행한 뒤 완료 탭에서 동일 Work, 활동, 산출물, 검증, Records가 다시 표시됨 |

## 실제 실패와 수정

Provider 연결 전 Work를 실행했을 때 `model-unavailable`로 차단되었습니다. 이는 Provider 연결 선행 조건이 없는 격리 데이터의 예상 차단으로 분리했습니다.

Provider를 연결한 첫 후보에서는 VoltAgent 위임 중 `Runtime Execution의 Agent handle이 일치하지 않습니다`가 server log에 기록됐습니다. 부모 Work의 Runtime Execution을 하위 Agent가 공유하면서 대상 section handle이 달라지는 경계가 원인이었습니다. 기존 `packages/growth/src/runtime-configuration.test.ts`에 동일 실행에서 `context-strategy` section을 읽는 회귀 사례를 추가했고, 수정 뒤 테스트가 통과했습니다.

## 남은 게이트

- 동일 후보 SHA의 UAT-K01~K04, UAT-G01~G02, UAT-P01~P02와 나머지 핵심 시나리오는 아직 최종 후보에서 통과하지 않았습니다.
- 전체 권한 runtime 전달·해제·긴급 정지와 Growth production worker는 아직 구현·실제 UAT 대기입니다.
- 서명·공증·업데이트·제거·재설치 및 공개 릴리스는 진행하지 않았습니다.
