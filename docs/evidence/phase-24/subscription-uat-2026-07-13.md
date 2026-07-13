# Phase 24 구독 UAT 증거

> **실행일**: 2026-07-13
> **실행 방식**: 최종 local release archive를 격리 tmux 세션에서 실행
> **민감정보**: 원시 pane 출력과 계정 식별자는 저장하지 않음

## 계보

- Git commit: `5f1b0822bfbdddced82c15b2f7cc44170bb6fa18`
- Release artifact: `sha256:6959a71b803cae07909432f2ce1fe00394712d26b00f036ee5da9d0deb0e1a92`
- Receipt schema: `massion.subscription-uat.v1`
- Receipt summary: `passed: 1`, `failed: 1`, `not-run: 9`

## 통과한 사용자 흐름

- release 설치와 version 확인
- bundled Connector doctor
- local daemon 시작·owner 초기화·status/readiness
- subscription provider catalog
- SSE event watch 연결
- daemon 재시작과 상태 확인
- owner-only backup 생성과 restore
- uninstall 후 사용자 data 보존

## 외부 계정 때문에 실행하지 못한 흐름

- Claude consumer login: `provider-approval-required`
- Z.AI Coding Plan: `provider-approval-required`
- 두 번째 계정, 두 번째 사용자, 공개 failure injection과 승인 재개: 각 외부 전제조건 필요

Codex consumer 연결은 로그인 동의와 계정·doctor·quota·adaptive policy 조회까지 통과했지만, 실제 `run subscription acceptance`가 180초 제한에 도달해 `network` 실패로 분류되었습니다. 따라서 실행 계보와 fallback 성공을 통과로 기록하지 않았습니다. Codex 로그인은 브라우저 인증 URL에서 추가 사용자 인증이 필요합니다.

처음 실행에서 발견된 SSE drain 종료 문제는 `2cb4f65`에서 수정했습니다. 수정 후 최종 receipt의 `restart-stop`과 모든 lifecycle command가 종료 코드 0입니다.
