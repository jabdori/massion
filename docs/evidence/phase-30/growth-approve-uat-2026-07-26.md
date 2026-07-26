# Phase 30 Growth 승인·재시작 UAT — 2026-07-26

> **상태:** 실패 포함 부분 통과. 실제 Growth 승인 성공이나 최종 개인용 v1 완료를 뜻하지 않습니다.

## 실행 경계

- 번들: `Massion Growth Approve UAT.app`
- bundle identifier: `dev.massion.desktop.growth-approve-uat`
- 번들 소스 후보: `edb183c8e` (`feat(growth): 개선 상세 승인과 계보 조회를 연결`)
- 데이터: `/tmp/massion-growth-gate-uat-20260726` 기존 실제 후보 데이터
- 실행 전 기존 Massion 테스트 번들과 고아 sidecar를 확인·종료했습니다.
- 검증 후 Tauri·desktop bridge·server·SurrealDB를 exact process로 종료했고 `7330`~`7333` listener가 없음을 확인했습니다.

## 실제 읽기 경로 — 통과

기존 실제 후보 하나가 fixture 삽입 없이 다음 계보로 조회됐습니다.

| 항목 | 관측 |
| --- | --- |
| Growth Suggestion | `awaiting-review`, revision 1 |
| Evaluation | `eligible`, required 3종·independent assurance 신호 통과 |
| Adoption | `awaiting-review`, 원래 Adoption command ID와 before checksum 보존 |
| Approval | `growth.adopt`에 연결된 실제 Approval ID 조회 |

Application query `growth.suggestions`는 source reference, patch, evaluation input hash, signal source checksum, Adoption 계보를 반환했습니다.

## 실제 승인 시도 — 실패

위 후보의 Approval을 실제 `growth.suggestion.approve` Application command로 실행했으나, Approval이 이미 `expired`여서 HTTP 500 내부 오류가 반환됐습니다. 만료는 승인 성공으로 우회하지 않았습니다.

- 응답: `APP_INTERNAL`, correlation `uat-growth-approve-20260726-c1`
- 원인 데이터: Approval status `expired`, revision 2
- 후속 최소 수정: `f33649e9a`에서 만료(`만료|expired`) 도메인 오류를 사용자 검증 오류로 분류
- 판정: 수정 후 새 번들에서의 실제 승인 성공은 아직 확인하지 않았습니다.

## 실제 Provider Work·재시작 — 실패 포함

개인 Provider가 저장된 같은 격리 데이터에서 새 Work를 실제 시작했습니다.

- Application `run.start`: `accepted`, `ready`
- 실제 Work: `b286c148-1ddf-4eeb-8450-ef519d224c83`
- 실제 GLM 경로의 representative·context-strategy·evidence·growth·assurance 실행과 산출물 생성이 관측됐습니다.
- 마지막 independent assurance 실행이 `running` 상태에서 장시간 변하지 않았습니다.
- 같은 데이터로 앱과 daemon을 재시작한 뒤 startup recovery가 실행을 `blocked`, `assurance-verifier-interrupted`로 정리했습니다.

따라서 이 Work는 완료·Records 확정·새 승인 후보 생성으로 세지 않습니다. 재시작 후 기존 Work·실행 원장과 차단 사유가 유지된 것은 보존 경계의 부분 통과이며, assurance 정체는 제품 실패입니다.

## 정체 원인과 최소 패치

코드 추적 결과 일반 모델 경로에는 120초 응답 상한이 있었지만, 실제 Provider 구독 경로(`agent-runtime`)에는 세션 갱신 신호만 전달되어 Provider 무응답 시 `running`이 무기한 유지될 수 있었습니다. `a5b285aec`에서 같은 120초 상한을 구독 경로에도 연결하고, 무응답 Provider가 `failed`로 종료되는 최소 회귀 테스트를 추가했습니다. 이 패치는 새 동일 후보 번들에서 재실행해야 하며, 본 문서의 실제 UAT 실패 관측을 성공으로 소급하지 않습니다.

## 아직 확인하지 않은 항목

- 실제 새 eligible 후보의 승인 투표와 같은 Adoption command replay 성공
- auto/full-access 적용·효과 측정·degraded 복원
- 최종 후보 SHA의 10개 이상 데스크톱 시나리오 전체 통과

이 문서에는 Provider secret, 실제 파일 절대 경로, 기억 원문을 기록하지 않았습니다.
