# Phase 24 구독 UAT 증거

> **실행일**: 2026-07-13
> **실행 방식**: 최종 local release archive를 격리 tmux 세션에서 실행
> **민감정보**: 원시 pane 출력과 계정 식별자는 저장하지 않음

## 계보

- Git commit: `2cb4f650f8a9e06ce8b07a8d17848304a07b3025`
- Release artifact: `sha256:1091fecb658b5d7de2ff242bab50662421dc07f1d431c4cbc60f3fcd489d3ac5`
- Receipt schema: `massion.subscription-uat.v1`
- Receipt summary: `passed: 1`, `failed: 0`, `not-run: 11`

## 통과한 사용자 흐름

- release 설치와 version 확인
- bundled Connector doctor
- local daemon 시작·owner 초기화·status/readiness
- subscription provider catalog
- SSE event watch 연결
- daemon 재시작과 상태 확인
- owner-only backup 생성과 restore
- uninstall 후 사용자 data 보존

## 의도적으로 실행하지 않은 흐름

- Codex consumer login: `interactive-login-required`
- Claude consumer login: `provider-approval-required`
- Z.AI Coding Plan: `provider-approval-required`
- 두 번째 계정, 두 번째 사용자, 공개 failure injection과 승인 재개: 각 외부 전제조건 필요

처음 실행에서 발견된 SSE drain 종료 문제는 `2cb4f65`에서 수정했습니다. 수정 후 최종 receipt의 `restart-stop`과 모든 lifecycle command가 종료 코드 0입니다.
