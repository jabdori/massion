# Phase 25 모델 평가실 검증 증거

> **실행일**: 2026-07-13
> **검증 커밋**: `5f1b0822bfbdddced82c15b2f7cc44170bb6fa18`
> **범위**: 개인용 Core 저장소의 모델 평가·추천·배치·정책·Runtime 선호 순서

## 자동 검증 결과

- `pnpm verify`: 통과
  - 저장소 검증 테스트 67개 통과
  - 워크스페이스 패키지 테스트 통과
  - 문서 구조 검증 통과
- `pnpm verify:security`: 통과
  - 14개 test file, 67개 테스트 통과
  - moderate/high/critical 취약점 0개, low 1개
- `pnpm verify:hardening`: 통과
  - 26개 테스트 통과
  - hardening load 500 requests, concurrency 32, failures 0, p95 13.58ms
- `pnpm release:build`: 통과
  - release schema: `massion.release.v1`
  - source commit: `5f1b0822bfbdddced82c15b2f7cc44170bb6fa18`
  - local archive: `sha256:6959a71b803cae07909432f2ce1fe00394712d26b00f036ee5da9d0deb0e1a92`
- `pnpm verify:release`: 통과
  - 개인 설치·실행·백업 복원·삭제 검증
  - 삭제 후 사용자 데이터와 백업 보존 확인

## 모델 평가실 기능 범위

- 평가 묶음(bundle), 실행(run), 점수 영수증(receipt), 정책(policy), 추천(recommendation), 배치(batch), 실사용 관찰(observation), 복구(recovery)를 tenant와 checksum 기준으로 격리합니다.
- 서버의 `ModelEvaluationExecutor`가 Router 모델 프로필을 선택하고 AI SDK로 prompt를 실행합니다.
- 평가 실행은 파일·메시지·배포·승인·조직 정본 변경 capability를 모두 `false`로 전달합니다.
- `production_learning` 동의가 없는 실사용 관찰은 거부합니다.
- 관찰·배치·복구 명령은 command idempotency와 request hash를 검사하여 재전송을 안전하게 처리합니다.
- 활성 배치는 Runtime이 역할별 모델 선호 순서로 읽고 Router reserve 후보 순서에 반영합니다.
- Web 정책 화면은 owner/admin만 변경할 수 있고, governance decision id를 필수로 받습니다.

## tmux 실제 사용자 시나리오

최종 local archive를 격리된 `massion-uat-phase24` tmux 세션에서 설치하여 실행했습니다. 비밀값과 원시 pane 출력은 저장하지 않았습니다.

- `release-lifecycle`: passed
  - 설치, version, Connector doctor, local start, owner 초기화, readiness, provider catalog, event watch, 재시작, backup/restore, uninstall 후 data 보존
- `codex-live-subscription`: failed (`network`)
  - Codex 로그인 동의, accounts, doctor, quota, adaptive policy configure/query까지 통과
  - 실제 `run subscription acceptance`는 180초 timeout으로 종료되어 실행 계보와 성공으로 기록하지 않음
  - 브라우저 OAuth 인증 URL에서 사용자 계정 인증이 추가로 필요함
- 의도적으로 미실행한 시나리오 9개
  - 두 번째 계정, 두 번째 사용자, 공개 failure injection, 승인 checkpoint, quota contract, Claude/Z.AI 공개 Provider 승인 조건

원본 구조화 영수증은 로컬 `artifacts/uat-phase-24/receipt.json`에 생성되며, 저장소에는 민감정보 제거 요약만 보존합니다.

## 남은 완성 조건

Phase 25는 현재 in-progress입니다. Provider별 품질 판정 고도화, 관찰 예산·보존 정책, TUI/Web 실행·추천 승인 화면, 외부 평가 import/export, 확장 역할 등록, 실제 복수 계정·Provider UAT가 남아 있습니다.
