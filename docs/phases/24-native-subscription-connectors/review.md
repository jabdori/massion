# Phase 24 — 구독 연결기 회고와 종료 조건

> **상태**: 외부 UAT 부분 통과 — Codex 실행 네트워크 재검증 대기
> **대상**: 개인용 Massion Core의 네이티브 구독 연결기와 로컬 릴리스
> **검토 기준**: `docs/evidence/phase-24/subscription-uat-2026-07-14.md`

## 이번 Phase에서 확인한 것

구독 계정 원장, quota 기반 라우팅, 계정별 fallback, Codex·Claude 연결기, Edge Connector, 승인 정책, runtime suspend/resume, CLI·TUI·Web 표면을 Core에 조립했습니다. 연결기와 계정의 비밀값은 공개 query·event·metric으로 노출하지 않는 계약을 유지합니다.

로컬 release는 다음 흐름을 실제로 통과했습니다.

- 설치와 version 확인
- Connector doctor
- local daemon 시작, owner 초기화, readiness 확인
- provider catalog와 event watch
- daemon 재시작
- owner 전용 backup·restore
- uninstall 뒤 사용자 data 보존

## 검증 결과

구조화된 subscription UAT 영수증은 `massion.subscription-uat.v1`이며, 이번 검증 결과는 `passed: 1`, `failed: 1`, `not-run: 9`입니다. Codex OAuth 로그인 동의와 계정·doctor·quota·adaptive policy 조회는 통과했지만 실제 subscription run은 180초 네트워크 timeout으로 종료되었습니다. Claude·Z.AI와 복수 계정 시나리오는 외부 승인·계정 조건이 없어 실행하지 않았습니다.

이번 실행에서는 인증 완료를 확인했지만, 외부 모델 응답이 제한시간 안에 도착하지 않았으므로 실행 성공이나 fallback 성공으로 승격하지 않습니다.

## 결정과 교훈

1. 실제 자격 증명과 네트워크가 없는 경우 provider 실행 성공을 추측하지 않습니다.
2. 외부 제공자 승인 전에는 Claude·Z.AI를 공개 연결 가능한 상태로 표시하지 않습니다.
3. 로컬 Core는 Cloud 과금·관리 서버에 의존하지 않으며, 향후 Cloud는 별도 제품 경계로 둡니다.
4. UAT 영수증에는 원시 pane 출력, 이메일, token, 개인 경로를 저장하지 않습니다.

## Phase 24 종료 조건

다음 조건이 모두 충족되면 Phase를 `completed`로 변경합니다.

1. 사용자 OAuth 인증 후 Codex subscription run의 성공 또는 명확한 provider 실패 계보를 새 receipt로 기록합니다.
2. 실제 연결된 복수 계정에 대해 rotation·quota·offline·429·fallback·중단·재개·재시작을 검증합니다.
3. 외부 계정이 승인된 경우에만 Claude·Z.AI 시나리오를 추가하고, 승인되지 않은 경우에는 현재 `provider-approval-required` 근거를 유지합니다.
4. 최종 source commit, release manifest, UAT receipt가 서로 가리키도록 고정합니다.
