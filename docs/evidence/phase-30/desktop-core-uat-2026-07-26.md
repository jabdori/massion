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
- 전체 권한의 Governance·resolver·Codex/Claude option 전달은 로컬 회귀 테스트까지 확인했지만, Work·Runtime mode/revision 영속 계보·해제·긴급 정지·capability probe와 실제 Tauri P01/P02는 아직 구현·UAT 대기입니다.
- 서명·공증·업데이트·제거·재설치 및 공개 릴리스는 진행하지 않았습니다.

## Growth Reflection 연결 증분 — 미통과 기록

- 후보 커밋: `a00ccfc22`
- 별도 번들: `Massion Growth UAT.app` (`dev.massion.desktop.growth-uat`)
- 확인: 실제 Z.ai 연결 명령이 `succeeded`, `status=active`, `connectorStatus=ready`를 반환했고 `run.start`도 `accepted`로 기록되었습니다.
- 실행 상태: 실제 representative·context-strategy·delivery 실행은 일부 `succeeded`였으나, 세션 종료 시 Work run이 `delivery/running`에 남아 `records_run` 완료와 Growth trigger·Reflection suggestion을 만들지 못했습니다.
- 판정: Growth UAT 통과로 세지 않습니다. bundle·SurrealDB·server·bridge는 exact PID로 종료했고 7330–7333 포트가 비었음을 확인했습니다.

재시작 복구 뒤에는 같은 Work가 `terminal/completed`가 되었고 worker가 실제 Reflection RuntimeExecution(`agent_handle=growth`, `status=succeeded`)을 만들었습니다. 다만 provider가 일반 회고 문서 객체를 반환해 `SuggestionCandidate` 검증에서 ReflectionRun이 `blocked`되고 suggestion은 0건이었습니다. 이 관찰에 대한 최소 수정은 `1f787e210`의 structured output schema 고정이며, 수정 후보의 새 Tauri UAT는 아직 실행하지 않았습니다.

`1f787e210` 후보를 새 번들에서 재실행했을 때는 후보 필드와 source ID는 맞았지만 `operation`이 `refine`, `add`, `update`로 반환되어 제품 allowlist(`replace-instruction`, `add-entry`, `replace-policy`, `change-node`)에서 다시 blocked되었습니다. 이 두 번째 관찰에 대한 최소 수정은 `9db9c013`이며, 해당 수정 후 새 Tauri UAT는 아직 통과하지 않았습니다.

`9db9c013` 후보의 별도 `Massion Growth Allowlist UAT.app`에서는 같은 완료 Records trigger를 재시도해 `growth_trigger=completed`, `reflection_run=completed`, `runtime_execution(status=succeeded, agent_handle=growth)`, `growth_suggestion=3(status=proposed)`를 확인했습니다. 검증 뒤 exact Tauri·bridge·server·SurrealDB를 종료했고 7330–7333 listener가 없음을 확인했습니다. 이는 Reflection 제안 생성 증분의 통과이며, 코드 수준의 후보 평가·채택 호출 연결이나 실제 review/auto 적용·효과·복원과 전체 v1 UAT 통과를 뜻하지 않습니다.

## Growth 실제 조회 연결 재검증 — 부분 통과

- 새 코드 후보: `bde15efd6` (`fix(growth): 실제 평가 근거를 개선 조회에 연결`), `1f56a9220` (`fix(application): Surreal 날짜 객체를 Growth 조회에서 투영`)
- 번들: `Massion Growth Read UAT.app` (`dev.massion.desktop.growth-read-uat`)
- 실행 데이터: 앞선 실제 Gate UAT가 남긴 격리 SurrealDB를 새 번들로 재시작했습니다. fixture를 삽입하지 않았습니다.
- Provider: 로컬 Application command로 개인 Z.AI Coding Plan 연결이 `succeeded`, 계정 `active`, Connector `ready`를 반환했고 설정 화면에 `Z.AI GLM Coding Plan · 사용 중 · https://api.z.ai/api/coding/paas/v4`가 표시됐습니다. secret은 로그·화면·문서에 남기지 않았습니다.
- 실제 화면: 개선 목록에 실제 `awaiting-review` 후보 1개가 표시되고, 상세에 원인 Work·Reflection·`승인 가능` 평가·전략 버전·평가 실행 ID·required/supporting 신호가 표시됐습니다. 이전의 `평가가 아직 실행되지 않았습니다`와 내부 오류는 재현되지 않았습니다.

## 같은 후보 재검증에서 확인한 별도 실패

- 새 격리 루트에서 짧은 실제 Work는 GLM 실행과 Work 완료, Records·Reflection 완료까지 갔지만 Reflection 후보가 0개여서 Growth 후보 생성 통과로 세지 않았습니다.
- 더 긴 실제 Work는 `application_run=blocked`, `runtime_execution=failed`로 종료되어 후보 생성 통과로 세지 않았습니다. 이는 조회 수정의 성공 증거와 분리한 Provider 실행 실패 기록입니다.
- 첫 새 번들의 개선 조회는 SurrealDB `datetime` 객체가 문자열·`Date` 전용 변환기를 통과하지 못해 내부 오류가 났습니다. `timestamp()`가 `toISOString()` 날짜 객체를 처리하도록 최소 수정하고 회귀 테스트를 추가한 뒤, 위의 기존 실제 후보 조회가 정상 렌더링됐습니다.

이 증거는 Growth 후보·평가의 실제 읽기 경로가 연결됐다는 뜻이지, Growth 승인 명령·auto/full-access 채택·효과 측정·되돌리기와 전체 v1 UAT가 완료됐다는 뜻은 아닙니다.
